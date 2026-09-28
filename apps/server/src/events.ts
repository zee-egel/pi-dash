import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import type { Activity, Snapshot } from "../../../shared/types.js";
import type { Config } from "./config.js";

export class Events {
  activity: Activity[] = [];
  clients = new Set<ServerResponse>();
  private writes = Promise.resolve();
  private webhooks = 0;
  constructor(private config: Config) {}
  async load() {
    await mkdir(this.config.DATA_DIR, { recursive: true, mode: 0o700 });
    try {
      this.activity = JSON.parse(
        await readFile(`${this.config.DATA_DIR}/activity.json`, "utf8"),
      ) as Activity[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "Cannot read activity store; restore or remove corrupt data/activity.json",
        );
    }
  }
  send(response: ServerResponse, event: string, data: unknown) {
    if (response.writableLength > 1024 * 1024) {
      response.destroy();
      return;
    }
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  broadcast(event: string, data: unknown) {
    for (const client of this.clients) this.send(client, event, data);
  }
  snapshot(snapshot: Snapshot) {
    this.broadcast("snapshot", snapshot);
  }
  add(type: string, message: string, level: Activity["level"] = "info") {
    const event: Activity = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      message,
      level,
    };
    this.activity = [event, ...this.activity].slice(0, 500);
    this.broadcast("activity", event);
    // ponytail: bounded JSON history is enough for one Pi; use SQLite for larger retention.
    const json = JSON.stringify(this.activity);
    this.writes = this.writes
      .then(async () => {
        const file = `${this.config.DATA_DIR}/activity.json`;
        await writeFile(`${file}.tmp`, json, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      })
      .catch((error) => {
        console.error("Activity persistence failed:", (error as Error).message);
      });
    if (
      this.config.N8N_WEBHOOK_URL &&
      /^(container\.(unhealthy|crashed)|deployment\.|system\.)/.test(type) &&
      this.webhooks < 4
    ) {
      this.webhooks++;
      void fetch(this.config.N8N_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          timestamp: event.timestamp,
          source: "pi-control-center",
          data: { message, level },
        }),
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      })
        .then((response) => {
          if (!response.ok) console.error("n8n returned HTTP", response.status);
        })
        .catch(() => console.error("n8n webhook unavailable"))
        .finally(() => {
          this.webhooks--;
        });
    }
  }
  async close() {
    for (const client of this.clients) client.end();
    await this.writes;
  }
}
