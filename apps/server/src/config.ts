import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const appSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/),
    name: z.string().min(1).max(80),
    directory: z
      .string()
      .refine((value) => path.isAbsolute(value), "directory must be absolute"),
    composeFile: z
      .string()
      .default("docker-compose.yml")
      .refine(
        (value) =>
          !path.isAbsolute(value) &&
          !value.split(/[\\/]/).includes("..") &&
          !value.startsWith("-") &&
          /^[\w./-]+$/.test(value),
        "composeFile must be a relative path inside the application",
      ),
    branch: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_/-]*$/)
      .refine(
        (value) =>
          !value.includes("..") &&
          !value.includes("//") &&
          !value.endsWith("/"),
      ),
    project: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]*$/)
      .optional(),
    build: z.boolean().default(false),
  })
  .strict();
export const appsSchema = z
  .object({ apps: z.array(appSchema).max(50) })
  .strict()
  .refine(
    (value) =>
      new Set(value.apps.map((app) => app.id)).size === value.apps.length,
    "Application IDs must be unique",
  );
export type AppConfig = z.infer<typeof appSchema>;
const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  BIND_ADDRESS: z.string().default("127.0.0.1"),
  PUBLIC_ORIGIN: z
    .url()
    .refine(
      (value) => new URL(value).origin === value && /^https?:/.test(value),
      "Use an http(s) origin without a trailing slash",
    )
    .default("http://localhost:5173"),
  SESSION_SECRET: z.string().min(32),
  ADMIN_USERNAME: z.string().min(1).max(80).default("admin"),
  ADMIN_PASSWORD_HASH: z
    .string()
    .regex(/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/, "Use npm run password:hash"),
  COOKIE_SECURE: z.enum(["true", "false"]).default("true"),
  N8N_WEBHOOK_URL: z
    .union([z.literal(""), z.url().refine((value) => /^https?:/.test(value))])
    .default(""),
  APPS_CONFIG_PATH: z.string().default("./config/apps.json"),
  DATA_DIR: z.string().default("./data"),
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  HOST_PROC: z.string().default("/proc"),
  HOST_SYS: z.string().default("/sys"),
  HOST_ROOT: z.string().default("/"),
  TEMPERATURE_WARN: z.coerce.number().min(30).max(120).default(80),
  DISK_WARN_PERCENT: z.coerce.number().min(1).max(100).default(90),
});
export type Config = z.infer<typeof envSchema>;
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const config = envSchema.parse(env);
  if (
    config.COOKIE_SECURE === "false" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(
      new URL(config.PUBLIC_ORIGIN).hostname,
    )
  )
    throw new Error(
      "COOKIE_SECURE=false is allowed only for a localhost PUBLIC_ORIGIN. Use HTTPS for remote access.",
    );
  return config;
}
export async function loadApps(file: string): Promise<AppConfig[]> {
  return appsSchema.parse(JSON.parse(await readFile(file, "utf8"))).apps;
}
