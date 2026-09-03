import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.basename(moduleDir) === "src" || path.basename(moduleDir) === "dist"
  ? path.resolve(moduleDir, "..")
  : moduleDir;
const workspaceRoot = path.resolve(packageRoot, "..");
// MCP source is shipped in the same repository as app/. Installed instances
// supply explicit runtime paths; no sibling checkout is required.
const defaultProjectRoot = workspaceRoot;

export interface NoraMcpConfig {
  mcpRoot: string;
  projectRoot: string;
  stRoot: string;
  configPath: string;
  stateRoot: string;
  nativeDataRoot: string;
  userDataRoot: string;
  baseUrl: string;
  timeoutMs: number;
  modelTimeoutMs: number;
  mode: "read-only" | "operator";
  uploadRoot: string;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(): NoraMcpConfig {
  const mode = process.env.NORA_MCP_MODE || "read-only";
  if (mode !== "read-only" && mode !== "operator") throw new Error("NORA_MCP_MODE must be read-only or operator.");
  if (!process.env.NORA_MCP_STATE_ROOT) throw new Error("NORA_MCP_STATE_ROOT is required; refusing to guess a test or production directory.");
  const projectRoot = path.resolve(process.env.NORA_MCP_PROJECT_ROOT || defaultProjectRoot);
  const stRoot = path.resolve(process.env.NORA_MCP_ST_ROOT || path.join(projectRoot, "app", "engine", "sillytavern"));
  const stateRoot = path.resolve(process.env.NORA_MCP_STATE_ROOT);
  const nativeDataRoot = path.resolve(process.env.NORA_MCP_NATIVE_DATA_ROOT || path.join(stateRoot, "native"));
  const userDataRoot = path.resolve(process.env.NORA_MCP_USER_DATA_ROOT || path.join(nativeDataRoot, "default-user"));
  const configPath = path.resolve(process.env.NORA_MCP_CONFIG_PATH || path.join(stateRoot, "native-runtime", "config.yaml"));
  const baseUrl = String(process.env.NORA_MCP_BASE_URL || "http://127.0.0.1:8799").replace(/\/+$/, "");
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Use a loopback HTTP origin. Launch MCP on the Tavern machine over SSH, not against Liveware.");
  }

  return {
    mcpRoot: packageRoot,
    projectRoot,
    stRoot,
    configPath,
    stateRoot,
    nativeDataRoot,
    userDataRoot,
    baseUrl,
    timeoutMs: envNumber("NORA_MCP_TIMEOUT_MS", 30000),
    modelTimeoutMs: envNumber("NORA_MCP_MODEL_TIMEOUT_MS", 390000),
    mode,
    uploadRoot: path.resolve(process.env.NORA_MCP_UPLOAD_ROOT || path.join(stateRoot, "imports")),
  };
}
