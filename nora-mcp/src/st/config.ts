import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.basename(moduleDir) === "src" || path.basename(moduleDir) === "dist"
  ? path.resolve(moduleDir, "..")
  : moduleDir;
const workspaceRoot = path.resolve(packageRoot, "..");
const defaultProjectRoot = path.join(workspaceRoot, "tavern");

export interface StMcpConfig {
  mcpRoot: string;
  projectRoot: string;
  stRoot: string;
  configPath: string;
  userDataRoot?: string;
  baseUrl: string;
  snapshotRoot: string;
  timeoutMs: number;
  runtimeCommands: Partial<Record<"status" | "start" | "stop" | "restart", string>>;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(): StMcpConfig {
  const projectRoot = path.resolve(process.env.ST_MCP_PROJECT_ROOT || defaultProjectRoot);
  const stRoot = path.resolve(process.env.ST_MCP_ST_ROOT || path.join(projectRoot, "app", "engine", "sillytavern"));
  const configPath = path.resolve(process.env.ST_MCP_CONFIG_PATH || path.join(stRoot, "config.yaml"));
  const userDataRoot = process.env.ST_MCP_USER_DATA_ROOT
    ? path.resolve(process.env.ST_MCP_USER_DATA_ROOT)
    : undefined;
  const snapshotRoot = path.resolve(
    process.env.ST_MCP_SNAPSHOT_ROOT || path.join(projectRoot, "local-state", "st-mcp-snapshots"),
  );
  const baseUrl = String(process.env.ST_MCP_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");

  return {
    mcpRoot: packageRoot,
    projectRoot,
    stRoot,
    configPath,
    userDataRoot,
    baseUrl,
    snapshotRoot,
    timeoutMs: envNumber("ST_MCP_TIMEOUT_MS", 30000),
    runtimeCommands: {
      status: process.env.ST_MCP_RUNTIME_STATUS_CMD,
      start: process.env.ST_MCP_RUNTIME_START_CMD,
      stop: process.env.ST_MCP_RUNTIME_STOP_CMD,
      restart: process.env.ST_MCP_RUNTIME_RESTART_CMD,
    },
  };
}
