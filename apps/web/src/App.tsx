import { useCallback, useEffect, useState } from "react";
import {
  LayoutDashboard,
  Box,
  Rocket,
  Cpu,
  Activity as ActivityIcon,
  Settings,
  ChevronRight,
  RefreshCw,
  ArrowUpRight,
  Menu,
  Search,
  X,
  CircuitBoard,
  LogOut,
} from "lucide-react";
import type { Container, Deployment, Snapshot } from "../../../shared/types";
import { api, duration, relative, setCsrf, bytes } from "./api";
import { ActivityList, Empty, Modal, Skeleton, Status } from "./components";
import type { Action } from "./components";
import { ContainerDetails, ContainerTable, LogViewer } from "./Containers";
import {
  ActivityPage,
  DeploymentsPage,
  Metrics,
  SettingsPage,
  SystemPage,
} from "./Pages";
const navigation = [
  { label: "Overview", icon: LayoutDashboard },
  { label: "Containers", icon: Box },
  { label: "Deployments", icon: Rocket },
  { label: "System", icon: Cpu },
  { label: "Activity", icon: ActivityIcon },
  { label: "Settings", icon: Settings },
];
interface User {
  username: string;
  csrf: string;
}
interface Confirmation {
  title: string;
  description: string;
  run: () => Promise<void>;
}
function Login({ ready }: { ready: (user: User) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="login-shell">
      <div className="login-decoration" />
      <form
        className="login-card"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            ready(await api<User>("/login", { username, password }));
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <span className="brand-symbol">
          <CircuitBoard size={29} />
        </span>

        <h1>Sign in</h1>
        <label>
          Username
          <input
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
            maxLength={80}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            maxLength={1024}
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
          <ArrowUpRight size={17} />
        </button>
      </form>
    </main>
  );
}
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [page, setPage] = useState("Overview");
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [connected, setConnected] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<Container | null>(null);
  const [logs, setLogs] = useState<Container | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const notify = useCallback(
    (text: string, error = false) => setToast({ text, error }),
    [],
  );
  const ready = useCallback((value: User) => {
    setCsrf(value.csrf);
    setUser(value);
  }, []);
  useEffect(() => {
    api<User>("/session")
      .then(ready)
      .catch(() => {})
      .finally(() => setChecking(false));
    const expire = () => {
      setCsrf("");
      setUser(null);
      setSnapshot(undefined);
      setDetail(null);
      setLogs(null);
      setConfirmation(null);
    };
    window.addEventListener("session-expired", expire);
    return () => window.removeEventListener("session-expired", expire);
  }, [ready]);
  useEffect(() => {
    if (!user) return;
    const stream = new EventSource("/api/events");
    stream.onopen = () => setConnected(true);
    stream.onerror = () => {
      setConnected(false);
      void api("/session").catch(() => {});
    };
    stream.addEventListener("snapshot", (event) =>
      setSnapshot(JSON.parse(event.data) as Snapshot),
    );
    stream.addEventListener("activity", (event) =>
      setSnapshot((current) =>
        current
          ? {
              ...current,
              activity: [JSON.parse(event.data), ...current.activity].slice(
                0,
                500,
              ),
            }
          : current,
      ),
    );
    stream.addEventListener("deployment", (event) => {
      const app = JSON.parse(event.data) as Deployment;
      setSnapshot((current) =>
        current
          ? {
              ...current,
              deployments: current.deployments.map((item) =>
                item.id === app.id ? app : item,
              ),
            }
          : current,
      );
    });
    stream.addEventListener("expired", () =>
      window.dispatchEvent(new Event("session-expired")),
    );
    return () => {
      stream.close();
      setConnected(false);
    };
  }, [user]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5500);
    return () => clearTimeout(timer);
  }, [toast]);
  const logout = async () => {
    try {
      await api("/logout", {});
      window.dispatchEvent(new Event("session-expired"));
    } catch (error) {
      notify((error as Error).message, true);
    }
  };
  const action = async (container: Container, value: Action) => {
    setBusy(container.id);
    try {
      await api(`/containers/${container.id}/action`, { action: value });
      notify(`${container.name}: ${value} completed`);
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  const act = (container: Container, value: Action) => {
    if (value === "start") {
      void action(container, value);
      return;
    }
    setConfirmation({
      title: `${value === "stop" ? "Stop" : "Restart"} ${container.name}?`,
      description:
        "This interrupts the service. If this is the Control Center itself, you may lose dashboard access.",
      run: () => action(container, value),
    });
  };
  const deploy = (app: Deployment) =>
    setConfirmation({
      title: `Deploy ${app.name}?`,
      description: `Fast-forward ${app.branch}, pull images${app.status === "running" ? "" : ", build if configured"}, and recreate the configured Compose services. This can interrupt service.`,
      run: async () => {
        await api(`/deployments/${app.id}`, { confirm: true });
        notify(`${app.name} deployment started`);
      },
    });
  const cleanup = () =>
    setConfirmation({
      title: "Remove dangling Docker images?",
      description:
        "Unused, untagged images will be permanently deleted. This frees storage without removing tagged images or running containers.",
      run: async () => {
        const result = await api<{ reclaimed: number }>("/images/prune", {
          confirm: true,
        });
        notify(`Cleanup completed. ${bytes(result.reclaimed)} reclaimed.`);
      },
    });
  const refresh = async () => {
    setBusy("refresh");
    try {
      setSnapshot(await api<Snapshot>("/refresh", {}));
      notify("Docker state refreshed");
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  if (checking)
    return (
      <div className="boot">
        <CircuitBoard className="spin" size={32} />
        <p>Connecting to Control Center…</p>
      </div>
    );
  if (!user) return <Login ready={ready} />;
  const running =
    snapshot?.containers.filter((container) => container.state === "running")
      .length ?? 0;
  const unhealthy =
    snapshot?.containers.filter(
      (container) =>
        container.health === "unhealthy" ||
        container.state === "dead" ||
        container.state === "restarting",
    ).length ?? 0;
  const dockerAvailable = snapshot && !snapshot.errors.docker;
  const healthy =
    connected &&
    snapshot?.metrics &&
    !snapshot.errors.metrics &&
    dockerAvailable &&
    !unhealthy;
  const tableProps = {
    busy,
    act,
    logs: (container: Container) => {
      setDetail(null);
      setLogs(container);
    },
    inspect: setDetail,
  };
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobile ? "is-open" : ""}`}>
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            setPage("Overview");
          }}
        >
          <span className="brand-symbol">
            <CircuitBoard size={24} />
          </span>
          <span>
            pi<span className="brand-light">control</span>
          </span>
        </a>
        <div className="workspace">
          <span className="pi-avatar">π</span>
          <span>{snapshot?.metrics?.hostname ?? "Raspberry Pi"}</span>
          <ChevronRight size={14} />
        </div>
        <nav>
          {navigation.map((item) => (
            <button
              key={item.label}
              className={page === item.label ? "active" : ""}
              onClick={() => {
                setPage(item.label);
                setMobile(false);
              }}
            >
              <item.icon size={18} />
              {item.label}
              {item.label === "Containers" && snapshot && (
                <span className="nav-count">{snapshot.containers.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="account"
            onClick={() => void logout()}
            title="Sign out"
          >
            <span className="avatar">
              {user.username.slice(0, 1).toUpperCase()}
            </span>
            <span>
              {user.username}
              <small>Administrator</small>
            </span>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <button
            className="mobile-toggle"
            aria-label="Toggle navigation"
            onClick={() => setMobile(!mobile)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumb">
            Workspace <ChevronRight size={13} />
            <strong>{page}</strong>
          </div>
          <div className="connection">
            <span className={`pulse-dot ${connected ? "" : "offline"}`} />
            {connected ? "Live connection" : "Reconnecting…"}
            <span className="keyboard-hint">local node</span>
          </div>
        </header>
        <main className="main-content">
          <div className="page-heading">
            <div>
              <h1>{page}</h1>
            </div>
            <button
              onClick={() => void refresh()}
              disabled={busy === "refresh"}
            >
              <RefreshCw
                size={14}
                className={busy === "refresh" ? "spin" : ""}
              />
              Refresh
            </button>
          </div>
          <section className="host-strip">
            <div className="host-name">
              <span className="host-icon">
                <Cpu size={20} />
              </span>
              <strong>{snapshot?.metrics?.hostname ?? "raspberrypi"}</strong>
              <Status value={connected ? "online" : "offline"} />
            </div>
            <div className="host-meta">
              <span>
                Uptime{" "}
                <strong>
                  {snapshot?.metrics ? duration(snapshot.metrics.uptime) : "—"}
                </strong>
              </span>
              <span>
                Refreshed{" "}
                <strong>{relative(snapshot?.refreshedAt ?? null)}</strong>
              </span>
            </div>
          </section>
          {!connected && (
            <div role="status" className="banner warning">
              Live connection interrupted. Displayed data may be stale;
              reconnecting automatically.
            </div>
          )}
          {snapshot?.errors.docker && (
            <div role="alert" className="banner error">
              {snapshot.errors.docker} Last known container state is shown.
            </div>
          )}
          {snapshot?.errors.metrics && (
            <div role="alert" className="banner warning">
              {snapshot.errors.metrics}
            </div>
          )}
          {!snapshot ? (
            <Skeleton />
          ) : (
            <>
              {page === "Overview" && (
                <>
                  <div className="section-heading">
                    <h2>System overview</h2>
                    <span
                      className={`health-label ${healthy ? "good" : "warning"}`}
                    >
                      <span
                        className={`pulse-dot ${healthy ? "" : "offline"}`}
                      />
                      {healthy ? "Systems operational" : "Check system status"}
                    </span>
                  </div>
                  <Metrics snapshot={snapshot} />
                  <section className="panel container-panel">
                    <div className="panel-heading">
                      <h2>
                        Containers{" "}
                        <span className="count">
                          {snapshot.containers.length}
                        </span>
                      </h2>
                      <div className="panel-heading-right">
                        <span className="good tiny">{running} running</span>
                        <button
                          className="text-button"
                          onClick={() => setPage("Containers")}
                        >
                          View all <ArrowUpRight size={14} />
                        </button>
                      </div>
                    </div>
                    <ContainerTable
                      containers={snapshot.containers.slice(0, 5)}
                      {...tableProps}
                    />
                  </section>
                  <div className="overview-bottom">
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>Recent activity</h2>
                        <button
                          className="text-button"
                          onClick={() => setPage("Activity")}
                        >
                          All events <ArrowUpRight size={14} />
                        </button>
                      </div>
                      <ActivityList items={snapshot.activity.slice(0, 5)} />
                    </section>
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>Deployments</h2>
                        <Rocket size={17} />
                      </div>
                      {snapshot.deployments.length ? (
                        snapshot.deployments.slice(0, 3).map((app) => (
                          <button
                            className="recent-app"
                            key={app.id}
                            onClick={() => setPage("Deployments")}
                          >
                            <span className="app-icon">
                              <Box size={17} />
                            </span>
                            <span>
                              <strong>{app.name}</strong>
                              <small>
                                {app.branch} · {relative(app.lastDeployment)}
                              </small>
                            </span>
                            <Status value={app.status} />
                          </button>
                        ))
                      ) : (
                        <Empty>
                          Add your first application in config/apps.json.
                        </Empty>
                      )}
                      <div className="panel-footer">
                        <button
                          className="text-button"
                          onClick={() => setPage("Deployments")}
                        >
                          Manage deployments <ArrowUpRight size={14} />
                        </button>
                      </div>
                    </section>
                  </div>
                </>
              )}
              {page === "Containers" && (
                <section className="panel">
                  <div className="panel-heading">
                    <h2>
                      All containers{" "}
                      <span className="count">
                        {snapshot.containers.length}
                      </span>
                    </h2>
                    <div className="search">
                      <Search size={15} />
                      <input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Find a container…"
                        aria-label="Filter containers"
                      />
                    </div>
                  </div>
                  <ContainerTable
                    containers={snapshot.containers.filter((container) =>
                      `${container.name} ${container.image}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )}
                    {...tableProps}
                  />
                </section>
              )}
              {page === "Deployments" && (
                <DeploymentsPage snapshot={snapshot} deploy={deploy} />
              )}
              {page === "System" && <SystemPage snapshot={snapshot} />}
              {page === "Activity" && <ActivityPage snapshot={snapshot} />}
              {page === "Settings" && (
                <SettingsPage cleanup={cleanup} logout={() => void logout()} />
              )}
            </>
          )}
        </main>
      </div>
      {detail && (
        <ContainerDetails
          container={
            snapshot?.containers.find((item) => item.id === detail.id) ?? detail
          }
          close={() => setDetail(null)}
          busy={busy === detail.id}
          act={act}
          logs={tableProps.logs}
        />
      )}
      {logs && <LogViewer container={logs} close={() => setLogs(null)} />}
      {confirmation && (
        <Modal
          title={confirmation.title}
          close={() => {
            if (!confirmBusy) setConfirmation(null);
          }}
        >
          <div className="pad">
            <p className="muted">{confirmation.description}</p>
            <div className="confirm-actions">
              <button
                disabled={confirmBusy}
                onClick={() => setConfirmation(null)}
              >
                Cancel
              </button>
              <button
                className="primary"
                disabled={confirmBusy}
                onClick={async () => {
                  setConfirmBusy(true);
                  try {
                    await confirmation.run();
                    setConfirmation(null);
                  } catch (error) {
                    notify((error as Error).message, true);
                  } finally {
                    setConfirmBusy(false);
                  }
                }}
              >
                {confirmBusy ? "Working…" : "Confirm"}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {toast && (
        <div className={`toast ${toast.error ? "error" : ""}`} role="status">
          {toast.text}
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
