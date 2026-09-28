import { parseConfig, loadApps } from "./config.js";
import { buildServer } from "./server.js";
try {
  const config = parseConfig(process.env);
  const apps = await loadApps(config.APPS_CONFIG_PATH);
  const server = await buildServer(config, apps);
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      void server.close().then(() => process.exit(0));
    });
  await server.listen({ port: config.PORT, host: config.BIND_ADDRESS });
} catch (error) {
  console.error(
    "Startup failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
}
