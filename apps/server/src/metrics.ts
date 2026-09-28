import { readFile, readdir, statfs } from "node:fs/promises";
import os from "node:os";
import type { Config } from "./config.js";
import type { Metric, SystemInfo } from "../../../shared/types.js";
export function parseMemory(text: string) {
  const values = Object.fromEntries(
    [...text.matchAll(/^(\w+):\s+(\d+)/gm)].map((match) => [
      match[1],
      Number(match[2]) * 1024,
    ]),
  );
  if (!values.MemTotal || values.MemAvailable === undefined)
    throw new Error("Host memory data unavailable");
  return {
    memoryTotal: values.MemTotal,
    memoryUsed: values.MemTotal - values.MemAvailable,
  };
}
export function parseCpu(text: string) {
  const values = text
    .split("\n")[0]
    .trim()
    .split(/\s+/)
    .slice(1, 9)
    .map(Number);
  if (values.length < 4 || values.some(Number.isNaN))
    throw new Error("Host CPU data unavailable");
  return {
    total: values.reduce((sum, value) => sum + value, 0),
    idle: values[3] + (values[4] ?? 0),
  };
}
export function parseNetwork(text: string) {
  return text
    .split("\n")
    .slice(2)
    .reduce(
      (sum, line) => {
        const [name, counters] = line.split(":");
        if (
          !counters ||
          name.trim() === "lo" ||
          /^(veth|docker|br-)/.test(name.trim())
        )
          return sum;
        const fields = counters.trim().split(/\s+/).map(Number);
        return { rx: sum.rx + fields[0], tx: sum.tx + fields[8] };
      },
      { rx: 0, tx: 0 },
    );
}
export class HostMetrics {
  private previous?: {
    total: number;
    idle: number;
    rx: number;
    tx: number;
    time: number;
  };
  constructor(private config: Config) {}
  private proc(file: string) {
    return readFile(`${this.config.HOST_PROC}/${file}`, "utf8");
  }
  async temperature(): Promise<number | null> {
    try {
      const zones = (
        await readdir(`${this.config.HOST_SYS}/class/thermal`)
      ).filter((name) => name.startsWith("thermal_zone"));
      for (const zone of zones) {
        const base = `${this.config.HOST_SYS}/class/thermal/${zone}`;
        const type = await readFile(`${base}/type`, "utf8");
        if (!/cpu|soc|bcm/i.test(type)) continue;
        const value = Number(await readFile(`${base}/temp`, "utf8")) / 1000;
        if (Number.isFinite(value)) return value;
      }
    } catch {
      /* Hardware can lack a readable temperature sensor. */
    }
    return null;
  }
  async sample(): Promise<Metric> {
    const [
      cpuText,
      memoryText,
      networkText,
      uptimeText,
      loadText,
      hostname,
      temperature,
      disk,
    ] = await Promise.all([
      this.proc("stat"),
      this.proc("meminfo"),
      this.proc("net/dev"),
      this.proc("uptime"),
      this.proc("loadavg"),
      this.proc("sys/kernel/hostname"),
      this.temperature(),
      statfs(this.config.HOST_ROOT).catch(() => null),
    ]);
    const cpu = parseCpu(cpuText);
    const network = parseNetwork(networkText);
    const now = Date.now();
    const previous = this.previous;
    const seconds = previous ? (now - previous.time) / 1000 : 0;
    const delta = previous ? cpu.total - previous.total : 0;
    this.previous = { ...cpu, ...network, time: now };
    return {
      time: new Date(now).toISOString(),
      hostname: hostname.trim(),
      cpu:
        previous && delta > 0
          ? Math.max(
              0,
              Math.min(100, 100 * (1 - (cpu.idle - previous.idle) / delta)),
            )
          : null,
      ...parseMemory(memoryText),
      diskUsed: disk ? (disk.blocks - disk.bfree) * disk.bsize : null,
      diskTotal: disk ? disk.blocks * disk.bsize : null,
      temperature,
      load: loadText.trim().split(/\s+/).slice(0, 3).map(Number),
      uptime: Number(uptimeText.split(" ")[0]),
      rx:
        previous && seconds > 0
          ? Math.max(0, (network.rx - previous.rx) / seconds)
          : null,
      tx:
        previous && seconds > 0
          ? Math.max(0, (network.tx - previous.tx) / seconds)
          : null,
    };
  }
  async info(): Promise<Omit<SystemInfo, "dockerVersion">> {
    const [hostname, kernel, cpu, release] = await Promise.all([
      this.proc("sys/kernel/hostname"),
      this.proc("sys/kernel/osrelease"),
      this.proc("cpuinfo"),
      readFile(`${this.config.HOST_ROOT}/etc/os-release`, "utf8").catch(
        () => "",
      ),
    ]);
    return {
      hostname: hostname.trim(),
      kernel: kernel.trim(),
      architecture: os.arch(),
      os: release.match(/^PRETTY_NAME="?([^"\n]+)/m)?.[1] ?? "Linux",
      cpuModel:
        cpu.match(/^(?:model name|Model|Hardware)\s*:\s*(.+)$/m)?.[1] ??
        os.cpus()[0]?.model ??
        "Unknown",
      cores: (cpu.match(/^processor\s*:/gm) ?? []).length || os.cpus().length,
      // host network mode in production makes these interfaces the host's interfaces.
      interfaces: Object.entries(os.networkInterfaces()).map(
        ([name, addresses]) => ({
          name,
          addresses: (addresses ?? []).map((address) => address.address),
        }),
      ),
    };
  }
}
