import { spawn } from "node:child_process";
import { readFile, writeFile, rename, realpath } from "node:fs/promises";
import path from "node:path";
import type { AppConfig, Config } from "./config.js";
import type { Deployment } from "../../../shared/types.js";
import type { Events } from "./events.js";
import type { DockerService } from "./docker.js";

export function deploymentCommands(
  app: AppConfig,
): { command: string; args: string[] }[] {
  const compose = [
    "compose",
    "--project-name",
    app.project ?? app.id,
    "--file",
    app.composeFile,
  ];
  return [
    { command: "git", args: ["fetch", "--prune", "origin", app.branch] },
    {
      command: "git",
      args: ["merge", "--ff-only", `refs/remotes/origin/${app.branch}`],
    },
    { command: "docker", args: [...compose, "pull"] },
    ...(app.build ? [{ command: "docker", args: [...compose, "build"] }] : []),
    {
      command: "docker",
      args: [...compose, "up", "-d", "--wait", "--wait-timeout", "120"],
    },
  ];
}
export class Deployments {
  state: Deployment[];
  private busy = false;
  private active?: ReturnType<typeof spawn>;
  constructor(
    private apps: AppConfig[],
    private config: Config,
    private events: Events,
    private docker: DockerService,
  ) {
    this.state = apps.map((app) => ({
      id: app.id,
      name: app.name,
      branch: app.branch,
      project: app.project ?? app.id,
      commit: null,
      status: "idle",
      lastDeployment: null,
      output: [],
    }));
  }
  private command(
    app: AppConfig,
    command: string,
    args: string[],
    output?: (text: string) => void,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      // No shell. Only this module's fixed executables and server-configured arguments reach spawn.
      // Do not pass session secrets, password hashes or webhook credentials to child processes.
      const child = spawn(command, args, {
        cwd: app.directory,
        shell: false,
        detached: process.platform !== "win32",
        env: {
          PATH: process.env.PATH,
          HOME: process.env.DEPLOY_HOME ?? "/tmp",
          LANG: "C.UTF-8",
          DOCKER_HOST: `unix://${this.config.DOCKER_SOCKET}`,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.active = child;
      let text = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        this.kill(child);
      }, 10 * 60_000).unref();
      const collect = (chunk: Buffer) => {
        const value = chunk.toString("utf8");
        text = (text + value).slice(-64_000);
        output?.(value);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.on("error", (error) => {
        clearTimeout(timer);
        if (this.active === child) this.active = undefined;
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (this.active === child) this.active = undefined;
        if (code === 0 && !timedOut) resolve(text.trim());
        else
          reject(
            new Error(
              timedOut
                ? `${command} timed out`
                : `${command} failed (exit ${code})`,
            ),
          );
      });
    });
  }
  private kill(child: ReturnType<typeof spawn>) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  async init() {
    try {
      const saved = JSON.parse(
        await readFile(`${this.config.DATA_DIR}/deployments.json`, "utf8"),
      ) as Deployment[];
      for (const state of this.state) {
        const old = saved.find((item) => item.id === state.id);
        if (old) {
          state.lastDeployment = old.lastDeployment;
          state.status = old.status === "running" ? "failed" : old.status;
          state.output = old.output.slice(-500);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Cannot read deployment history");
    }
    for (const app of this.apps) {
      const state = this.state.find((item) => item.id === app.id)!;
      state.commit = await this.command(app, "git", [
        "rev-parse",
        "--short",
        "HEAD",
      ]).catch(() => null);
    }
  }
  start(id: string) {
    const app = this.apps.find((item) => item.id === id);
    if (!app)
      throw Object.assign(new Error("Unknown configured application"), {
        statusCode: 404,
      });
    // ponytail: one deployment at a time protects a small Pi; use per-app locks only if necessary.
    if (this.busy)
      throw Object.assign(new Error("Another deployment is running"), {
        statusCode: 409,
      });
    this.busy = true;
    const state = this.state.find((item) => item.id === id)!;
    state.status = "running";
    state.output = [];
    state.lastDeployment = new Date().toISOString();
    void this.run(app, state);
    return state;
  }
  private async persist() {
    const file = `${this.config.DATA_DIR}/deployments.json`;
    await writeFile(`${file}.tmp`, JSON.stringify(this.state), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
  private async run(app: AppConfig, state: Deployment) {
    const log = (text: string) => {
      // Bound both the number and length of chunks from potentially noisy builds.
      state.output = [...state.output, text.slice(-8000)].slice(-500);
      this.events.broadcast("deployment", state);
    };
    this.events.add("deployment.started", `${app.name} deployment started`);
    try {
      await this.persist();
      const directory = await realpath(app.directory);
      const composePath = await realpath(path.join(directory, app.composeFile));
      if (!composePath.startsWith(`${directory}${path.sep}`))
        throw new Error("Compose file resolves outside configured directory");
      if (await this.command(app, "git", ["status", "--porcelain"]))
        throw new Error(
          "Working tree is dirty. Resolve local changes before deploying.",
        );
      if (
        (await this.command(app, "git", ["branch", "--show-current"])) !==
        app.branch
      )
        throw new Error(
          "Checkout is not on the configured branch. Switch it on the host first.",
        );
      for (const step of deploymentCommands(app)) {
        log(`\n› ${step.command} ${step.args.join(" ")}\n`);
        await this.command(app, step.command, step.args, log);
      }
      // Compose --wait checks health checks where provided, running state otherwise.
      const containers = (await this.docker.list()).filter(
        (item) => item.project === state.project,
      );
      if (
        !containers.length ||
        containers.some(
          (item) => item.state !== "running" || item.health === "unhealthy",
        )
      )
        throw new Error(
          "Application containers are not all running and healthy",
        );
      state.status = "succeeded";
      log("\nDeployment successful.\n");
      this.events.add(
        "deployment.completed",
        `${app.name} deployed successfully`,
        "success",
      );
    } catch (error) {
      state.status = "failed";
      log(`\nDeployment failed: ${(error as Error).message}\n`);
      this.events.add(
        "deployment.failed",
        `${app.name} deployment failed`,
        "error",
      );
    } finally {
      state.commit = await this.command(app, "git", [
        "rev-parse",
        "--short",
        "HEAD",
      ]).catch(() => null);
      await this.persist().catch(() =>
        log("Warning: deployment history could not be saved."),
      );
      this.busy = false;
      this.events.broadcast("deployment", state);
    }
  }
  close() {
    if (this.active) this.kill(this.active);
  }
}
