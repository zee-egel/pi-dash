import { PassThrough, Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Session } from "./auth.js";
import type { DockerService } from "./docker.js";
import type { Events } from "./events.js";
export function openSse(reply: FastifyReply) {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  reply.raw.write(": connected\n\n");
}
export async function streamLogs(
  id: string,
  tail: number,
  req: FastifyRequest,
  reply: FastifyReply,
  docker: DockerService,
  events: Events,
  valid: () => Session | undefined,
) {
  const container = docker.client.getContainer(id);
  const inspect = await container.inspect();
  const source = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    timestamps: true,
    tail,
  });
  openSse(reply);
  const output = new PassThrough();
  const decoder = new StringDecoder("utf8");
  const write = (chunk: Buffer) =>
    events.send(reply.raw, "log", decoder.write(chunk));
  output.on("data", write);
  if (inspect.Config.Tty) source.pipe(output);
  else docker.client.modem.demuxStream(source, output, output);
  const heartbeat = setInterval(() => {
    if (!valid()) {
      events.send(reply.raw, "expired", {});
      cleanup();
    } else reply.raw.write(": heartbeat\n\n");
  }, 15_000).unref();
  const cleanup = () => {
    clearInterval(heartbeat);
    (source as Readable).destroy();
    output.destroy();
    reply.raw.end();
  };
  source.on("error", () => {
    events.send(reply.raw, "stream-error", {
      error: "Docker log stream interrupted",
    });
    cleanup();
  });
  source.on("end", () => {
    const remaining = decoder.end();
    if (remaining) events.send(reply.raw, "log", remaining);
    events.send(reply.raw, "end", {});
    cleanup();
  });
  reply.raw.on("close", cleanup);
  req.raw.on("error", cleanup);
}
