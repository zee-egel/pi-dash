import Docker from "dockerode";
import { z } from "zod";
import type { Container, ContainerDetail } from "../../../shared/types.js";
export const containerId = z.string().regex(/^[a-f0-9]{64}$/);
export const actionSchema = z
  .object({ action: z.enum(["start", "stop", "restart"]) })
  .strict();
export function safeDockerError(error: unknown): string {
  const code = (error as { code?: string; statusCode?: number }).code;
  const status = (error as { statusCode?: number }).statusCode;
  if (code === "EACCES" || status === 403)
    return "Docker permission denied. Check socket permissions.";
  if (status === 404)
    return "Container no longer exists. Refresh the dashboard.";
  if (status === 409 || status === 304)
    return "Container state changed or operation conflicts. Refresh and retry.";
  return "Docker operation failed. Check Docker availability and server logs.";
}
export class DockerService {
  client: Docker;
  private previousCpu = new Map<string, { cpu: number; system: number }>();
  constructor(socketPath: string) {
    this.client = new Docker({ socketPath, timeout: 30_000 });
  }
  async list(): Promise<Container[]> {
    const rows = await this.client.listContainers({ all: true });
    const result: Container[] = [];
    // Small batches keep stats collection from overwhelming a Pi with many containers.
    for (let index = 0; index < rows.length; index += 4) {
      result.push(
        ...(await Promise.all(
          rows.slice(index, index + 4).map(async (row) => {
            const container = this.client.getContainer(row.Id);
            const [inspect, stats] = await Promise.all([
              container.inspect(),
              row.State === "running"
                ? container
                    .stats({ stream: false, "one-shot": true })
                    .catch(() => null)
                : null,
            ]);
            let cpu: number | null = null;
            if (stats) {
              const previous = this.previousCpu.get(row.Id);
              const delta = previous ? stats.cpu_stats.cpu_usage.total_usage - previous.cpu : 0;
              const systemDelta = previous ? stats.cpu_stats.system_cpu_usage - previous.system : 0;
              this.previousCpu.set(row.Id, { cpu: stats.cpu_stats.cpu_usage.total_usage, system: stats.cpu_stats.system_cpu_usage });
              if (systemDelta > 0 && delta >= 0)
                cpu =
                  (delta / systemDelta) *
                  (stats.cpu_stats.online_cpus ||
                    stats.cpu_stats.cpu_usage.percpu_usage?.length ||
                    1) *
                  100;
            }
            return {
              id: row.Id,
              name: inspect.Name.replace(/^\//, ""),
              image: inspect.Config.Image,
              state: inspect.State.Status,
              health: inspect.State.Health?.Status ?? "none",
              started: inspect.State.StartedAt,
              ports: (row.Ports ?? []).map((port) =>
                port.PublicPort
                  ? `${port.IP ?? ""}:${port.PublicPort} → ${port.PrivatePort}/${port.Type}`
                  : `${port.PrivatePort}/${port.Type}`,
              ),
              cpu,
              memory: stats
                ? Math.max(
                    0,
                    stats.memory_stats.usage -
                      (stats.memory_stats.stats?.inactive_file ??
                        stats.memory_stats.stats?.cache ??
                        0),
                  )
                : null,
              memoryLimit: stats?.memory_stats.limit ?? null,
              rx: stats
                ? Object.values(stats.networks ?? {}).reduce(
                    (sum, network) => sum + network.rx_bytes,
                    0,
                  )
                : null,
              tx: stats
                ? Object.values(stats.networks ?? {}).reduce(
                    (sum, network) => sum + network.tx_bytes,
                    0,
                  )
                : null,
              restarts: inspect.RestartCount,
              exitCode: inspect.State.ExitCode,
              project:
                inspect.Config.Labels?.["com.docker.compose.project"] ?? null,
            };
          }),
        )),
      );
    }
    const running = new Set(result.filter(item => item.state === 'running').map(item => item.id));
    for (const id of this.previousCpu.keys()) if (!running.has(id)) this.previousCpu.delete(id);
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
  async detail(id: string, containers: Container[]): Promise<ContainerDetail> {
    const base = containers.find((container) => container.id === id);
    if (!base)
      throw Object.assign(new Error("Container unavailable"), {
        statusCode: 404,
      });
    const inspect = await this.client.getContainer(id).inspect();
    // Explicit projection: never return raw inspect (contains credentials and host paths).
    return {
      ...base,
      created: inspect.Created,
      restartPolicy: inspect.HostConfig.RestartPolicy?.Name ?? "none",
      networks: Object.keys(inspect.NetworkSettings.Networks ?? {}),
      mounts: (inspect.Mounts ?? []).map((mount) => ({
        type: mount.Type,
        destination: mount.Destination,
        readOnly: !mount.RW,
      })),
      environmentNames: (inspect.Config.Env ?? []).map(
        (value) => value.split("=", 1)[0],
      ),
    };
  }
  async action(id: string, action: z.infer<typeof actionSchema>["action"]) {
    const container = this.client.getContainer(id);
    switch (action) {
      case "start":
        await container.start();
        break;
      case "stop":
        await container.stop({ t: 15 });
        break;
      case "restart":
        await container.restart({ t: 15 });
    }
  }
}
