export interface Metric {
  time: string;
  hostname: string;
  cpu: number | null;
  memoryUsed: number;
  memoryTotal: number;
  diskUsed: number | null;
  diskTotal: number | null;
  temperature: number | null;
  load: number[];
  uptime: number;
  rx: number | null;
  tx: number | null;
}
export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  health: string;
  started: string;
  ports: string[];
  cpu: number | null;
  memory: number | null;
  memoryLimit: number | null;
  rx: number | null;
  tx: number | null;
  restarts: number;
  project: string | null;
}
export interface ContainerDetail extends Container {
  created: string;
  restartPolicy: string;
  networks: string[];
  mounts: { type: string; destination: string; readOnly: boolean }[];
  environmentNames: string[];
}
export interface Activity {
  id: string;
  type: string;
  timestamp: string;
  message: string;
  level: "info" | "success" | "error" | "warning";
}
export interface Deployment {
  id: string;
  name: string;
  branch: string;
  project: string;
  commit: string | null;
  status: "idle" | "running" | "succeeded" | "failed";
  lastDeployment: string | null;
  output: string[];
}
export interface Snapshot {
  metrics: Metric | null;
  history: Metric[];
  containers: Container[];
  activity: Activity[];
  deployments: Deployment[];
  errors: { metrics: string | null; docker: string | null };
  refreshedAt: string | null;
}
export interface SystemInfo {
  hostname: string;
  os: string;
  kernel: string;
  architecture: string;
  cpuModel: string;
  cores: number;
  interfaces: { name: string; addresses: string[] }[];
  dockerVersion: string | null;
}
export interface Settings {
  username: string;
  origin: string;
  secureCookies: boolean;
  webhookEnabled: boolean;
  sampleSeconds: number;
  hostMetrics: boolean;
}
