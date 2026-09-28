import type { Config } from "./config.js";
import { HostMetrics } from "./metrics.js";
import { DockerService, safeDockerError } from "./docker.js";
import type { Events } from "./events.js";
import type { Deployments } from "./deployments.js";
import type { Snapshot, Container } from "../../../shared/types.js";
export class Monitor {
  snapshot: Snapshot = {
    metrics: null,
    history: [],
    containers: [],
    activity: [],
    deployments: [],
    errors: { metrics: null, docker: null },
    refreshedAt: null,
  };
  host: HostMetrics;
  private metricTimer?: NodeJS.Timeout;
  private dockerTimer?: NodeJS.Timeout;
  private refreshPromise?: Promise<void>;
  private stopped = false;
  private known = new Map<string, Container>();
  private warnings = new Set<string>();
  constructor(
    private config: Config,
    readonly docker: DockerService,
    private events: Events,
    private deployments: Deployments,
  ) {
    this.host = new HostMetrics(config);
  }
  current() {
    return {
      ...this.snapshot,
      activity: this.events.activity,
      deployments: this.deployments.state,
    };
  }
  private publish() {
    this.events.snapshot(this.current());
  }
  async refreshDocker() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.readDocker().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }
  private async readDocker() {
    try {
      const containers = await this.docker.list();
      for (const container of containers) {
        const old = this.known.get(container.id);
        if (container.health === "unhealthy" && old?.health !== "unhealthy")
          this.events.add(
            "container.unhealthy",
            `${container.name} became unhealthy`,
            "warning",
          );
        if (old && container.health === "healthy" && old.health !== "healthy")
          this.events.add(
            "container.healthy",
            `${container.name} healthcheck OK`,
            "success",
          );
        if (
          old &&
          (container.restarts > old.restarts ||
            (old.state === "running" && container.exitCode !== 0 &&
              ["exited", "dead"].includes(container.state)))
        )
          this.events.add(
            "container.crashed",
            `${container.name} exited or restarted; inspect logs`,
            "warning",
          );
        if (old && old.state !== container.state)
          this.events.add(
            `container.${container.state}`,
            `${container.name} is ${container.state}`,
          );
      }
      this.known = new Map(
        containers.map((container) => [container.id, container]),
      );
      this.snapshot.containers = containers;
      this.snapshot.errors.docker = null;
    } catch (error) {
      this.snapshot.errors.docker = safeDockerError(error);
    }
    this.publish();
  }
  private async sample() {
    try {
      const metrics = await this.host.sample();
      this.snapshot.metrics = metrics;
      this.snapshot.errors.metrics = null;
      this.snapshot.history = [...this.snapshot.history, metrics].slice(-180);
      for (const [type, warning, message] of [
        [
          "system.temperature.high",
          metrics.temperature !== null &&
            metrics.temperature >= this.config.TEMPERATURE_WARN,
          "CPU temperature above threshold",
        ],
        [
          "system.disk.low",
          metrics.diskUsed !== null &&
            metrics.diskTotal !== null &&
            (metrics.diskUsed / metrics.diskTotal) * 100 >=
              this.config.DISK_WARN_PERCENT,
          "Root disk usage above threshold",
        ],
      ] as const) {
        if (warning && !this.warnings.has(type))
          this.events.add(type, message, "warning");
        if (warning) this.warnings.add(type);
        else this.warnings.delete(type);
      }
      this.snapshot.refreshedAt = metrics.time;
    } catch {
      this.snapshot.errors.metrics =
        "Host metrics unavailable. Check Linux host mounts and permissions.";
    }
    this.publish();
    if (!this.stopped)
      this.metricTimer = setTimeout(() => void this.sample(), 2000).unref();
  }
  start() {
    void this.sample();
    const loop = async () => {
      await this.refreshDocker();
      if (!this.stopped)
        this.dockerTimer = setTimeout(() => void loop(), 5000).unref();
    };
    void loop();
  }
  close() {
    this.stopped = true;
    clearTimeout(this.metricTimer);
    clearTimeout(this.dockerTimer);
  }
}
