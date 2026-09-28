import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
import { promisify } from "node:util";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "./config.js";
const scrypt = promisify(scryptCallback);
const lifetime = 8 * 60 * 60 * 1000;
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  const [, salt, expected] = hash.split(":");
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}
export interface Session {
  csrf: string;
  expires: number;
}
export async function registerAuth(server: FastifyInstance, config: Config) {
  // Opaque random IDs, held server-side: logout revokes sessions immediately, restart revokes all.
  const sessions = new Map<string, Session>();
  const key = (token: string) =>
    createHmac("sha256", config.SESSION_SECRET).update(token).digest("hex");
  const getSession = (req: FastifyRequest) => {
    const token = req.cookies.pi_session;
    const session = token ? sessions.get(key(token)) : undefined;
    return session && session.expires > Date.now() ? session : undefined;
  };
  const sweep = setInterval(() => {
    for (const [id, session] of sessions)
      if (session.expires <= Date.now()) sessions.delete(id);
  }, 60_000).unref();
  server.addHook("onClose", async () => {
    clearInterval(sweep);
    sessions.clear();
  });
  await server.register(cookie);
  await server.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
  });
  server.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (config.COOKIE_SECURE === "true")
      reply.header("Strict-Transport-Security", "max-age=31536000");
    const pathname = req.url.split("?")[0];
    if (!pathname.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (unsafe && req.headers.origin !== config.PUBLIC_ORIGIN)
      return reply.code(403).send({ error: "Origin not allowed" });
    if (pathname === "/api/login" && req.method === "POST") return;
    const session = getSession(req);
    if (!session) return reply.code(401).send({ error: "Sign in required" });
    if (unsafe && req.headers["x-csrf-token"] !== session.csrf)
      return reply.code(403).send({ error: "Invalid CSRF token" });
  });
  server.post(
    "/api/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { username, password } = z
        .object({
          username: z.string().max(80),
          password: z.string().min(1).max(1024),
        })
        .strict()
        .parse(req.body);
      // Always derive the hash, including for invalid usernames.
      const valid = await verifyPassword(password, config.ADMIN_PASSWORD_HASH);
      if (!valid || username !== config.ADMIN_USERNAME)
        return reply.code(401).send({ error: "Invalid username or password" });
      const old = req.cookies.pi_session;
      if (old) sessions.delete(key(old));
      while (sessions.size >= 20)
        sessions.delete(sessions.keys().next().value!);
      const token = randomBytes(32).toString("hex");
      const session = {
        csrf: randomBytes(32).toString("hex"),
        expires: Date.now() + lifetime,
      };
      sessions.set(key(token), session);
      reply.setCookie("pi_session", token, {
        httpOnly: true,
        secure: config.COOKIE_SECURE === "true",
        sameSite: "strict",
        path: "/",
        maxAge: lifetime / 1000,
      });
      return { username: config.ADMIN_USERNAME, csrf: session.csrf };
    },
  );
  server.get("/api/session", async (req) => ({
    username: config.ADMIN_USERNAME,
    csrf: getSession(req)!.csrf,
  }));
  server.post("/api/logout", async (req, reply) => {
    sessions.delete(key(req.cookies.pi_session ?? ""));
    reply.clearCookie("pi_session", { path: "/" });
    return { ok: true };
  });
  return getSession;
}
