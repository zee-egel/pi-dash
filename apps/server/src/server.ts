import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { z, ZodError } from "zod";
import { registerAuth } from "./auth.js";
import {
  DockerService,
  actionSchema,
  containerId,
  safeDockerError,
} from "./docker.js";
import { Events } from "./events.js";
import { Deployments } from "./deployments.js";
import { Monitor } from "./monitor.js";
import { openSse, streamLogs } from "./logs.js";
import type { Config, AppConfig } from "./config.js";

export async function buildServer(
  config: Config,
  apps: AppConfig[],
  options: { monitor?: boolean; logger?: boolean } = {},
) {
  const server = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 8192,
    trustProxy: false,
    requestTimeout: 30_000,
  });
  const getSession = await registerAuth(server, config);
  const events = new Events(config);
  await events.load();
  const docker = new DockerService(config.DOCKER_SOCKET);
  const deployments = new Deployments(apps, config, events, docker);
  await deployments.init();
  const monitor = new Monitor(config, docker, events, deployments);
  server.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError)
      return reply
        .code(400)
        .send({
          error: "Invalid request",
          details: error.issues.map(
            (issue) => `${issue.path.join(".")}: ${issue.message}`,
          ),
        });
    const failure = error as { statusCode?: number; message: string };
    const status =
      failure.statusCode &&
      failure.statusCode >= 400 &&
      failure.statusCode < 500
        ? failure.statusCode
        : 500;
    req.log.error({ err: error }, "Request failed");
    return reply
      .code(status)
      .send({
        error:
          status === 500
            ? "Operation failed. Check server logs."
            : failure.message,
      });
  });
  server.get("/api/snapshot", async () => monitor.current());
  server.get("/api/settings", async () => ({
    username: config.ADMIN_USERNAME,
    origin: config.PUBLIC_ORIGIN,
    secureCookies: config.COOKIE_SECURE === "true",
    webhookEnabled: Boolean(config.N8N_WEBHOOK_URL),
    sampleSeconds: 2,
    hostMetrics: config.HOST_PROC !== "/proc",
  }));
  server.get("/api/system", async () => ({
    ...(await monitor.host.info()),
    dockerVersion: await docker.client
      .version()
      .then((version) => version.Version)
      .catch(() => null),
  }));
  server.post("/api/refresh", async () => {
    await monitor.refreshDocker();
    return monitor.current();
  });
  server.post("/api/images/prune", async (req) => {
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    const result = await docker.client.pruneImages({
      filters: { dangling: ["true"] },
    });
    events.add("docker.cleanup", "Dangling image cleanup completed", "success");
    return { reclaimed: result.SpaceReclaimed };
  });
  server.get<{ Params: { id: string } }>("/api/containers/:id", async (req) => {
    return docker.detail(
      containerId.parse(req.params.id),
      monitor.snapshot.containers,
    );
  });
  server.post<{ Params: { id: string } }>(
    "/api/containers/:id/action",
    async (req, reply) => {
      const id = containerId.parse(req.params.id);
      const { action } = actionSchema.parse(req.body);
      try {
        await docker.action(id, action);
      } catch (error) {
        return reply.code(502).send({ error: safeDockerError(error) });
      }
      events.add(
        `container.${action === "stop" ? "stopped" : action === "start" ? "started" : "restarted"}`,
        `${monitor.snapshot.containers.find((item) => item.id === id)?.name ?? id.slice(0, 12)} ${action} completed`,
        "success",
      );
      await monitor.refreshDocker();
      return { ok: true };
    },
  );
  server.post<{ Params: { id: string } }>(
    "/api/deployments/:id",
    async (req, reply) => {
      const id = z
        .string()
        .regex(/^[a-z0-9][a-z0-9_-]{0,47}$/)
        .parse(req.params.id);
      z.object({ confirm: z.literal(true) })
        .strict()
        .parse(req.body);
      return reply.code(202).send(deployments.start(id));
    },
  );
  const streams = new Set<import('node:http').ServerResponse>();
  const limitStream = (reply: import("fastify").FastifyReply) => {
    if (streams.size >= 12) {
      void reply
        .code(429)
        .send({ error: "Too many live streams. Close another tab." });
      return false;
    }
    streams.add(reply.raw);
    reply.raw.once("close", () => streams.delete(reply.raw));
    return true;
  };
  server.get("/api/events", async (req, reply) => {
    if (!limitStream(reply)) return;
    openSse(reply);
    events.clients.add(reply.raw);
    events.send(reply.raw, "snapshot", monitor.current());
    const timer = setInterval(() => {
      if (!getSession(req)) {
        events.send(reply.raw, "expired", {});
        reply.raw.end();
      } else reply.raw.write(": heartbeat\n\n");
    }, 15_000).unref();
    reply.raw.on("close", () => {
      clearInterval(timer);
      events.clients.delete(reply.raw);
    });
  });
  server.get<{ Params: { id: string }; Querystring: { tail?: string } }>(
    "/api/containers/:id/logs",
    async (req, reply) => {
      const id = containerId.parse(req.params.id);
      const tail = z.coerce
        .number()
        .int()
        .min(0)
        .max(2000)
        .default(200)
        .parse(req.query.tail);
      if (!limitStream(reply)) return;
      try {
        await streamLogs(id, tail, req, reply, docker, events, () =>
          getSession(req),
        );
      } catch (error) {
        if (!reply.raw.headersSent)
          return reply.code(502).send({ error: safeDockerError(error) });
      }
    },
  );
  const webRoot = path.resolve("dist/web");
  if (existsSync(webRoot)) {
    await server.register(fastifyStatic, { root: webRoot });
    server.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "Endpoint not found" })
        : reply.sendFile("index.html"),
    );
  }
  server.addHook("preClose", async () => {
    monitor.close();
    deployments.close();
    for (const stream of streams) stream.destroy();
  });
  server.addHook("onClose", async () => {
    monitor.close();
    deployments.close();
    await events.close();
  });
  if (options.monitor !== false) {
    monitor.start();
    events.add("server.started", "Control Center is online", "success");
  }
  return server;
}
