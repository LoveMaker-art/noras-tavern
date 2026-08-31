import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const DEFAULT_ST_ROOT = fileURLToPath(new URL('../../app/engine/sillytavern', import.meta.url));
const stRoot = path.resolve(process.argv[2] || process.env.ST_MCP_ST_ROOT || DEFAULT_ST_ROOT);
const outputDir = path.resolve(process.argv[3] || path.join(process.cwd(), "docs"));

const endpointMethods = new Set(["get", "post", "put", "patch", "delete"]);
const sourceIgnores = new Set([".git", "node_modules", "data", "backups", "plugins"]);

const index = {
  schema: "st-codebase-index/v1",
  generatedAt: new Date().toISOString(),
  stRoot,
  package: await readJsonIfExists(path.join(stRoot, "package.json")),
  git: await gitFacts(stRoot),
  serverConfig: await serverConfigIndex(),
  defaultUserSettings: await settingsIndex(),
  serverRoutes: await routeIndex(),
  configUsages: await configUsageIndex(),
  runtimeSurfaces: await runtimeSurfaceIndex(),
  dataLayout: await dataLayoutIndex(),
  mcpPlanning: mcpPlanningIndex(),
};

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, "upstream-st-index.json"), `${JSON.stringify(index, null, 2)}\n`);
await fs.writeFile(path.join(outputDir, "upstream-st-index.md"), renderMarkdown(index));

console.log(JSON.stringify({
  ok: true,
  stRoot,
  json: path.join(outputDir, "upstream-st-index.json"),
  markdown: path.join(outputDir, "upstream-st-index.md"),
  configKeys: index.serverConfig.defaultKeys.length,
  settingKeys: index.defaultUserSettings.topLevelKeys.length,
  routes: index.serverRoutes.routes.length,
  configUsages: index.configUsages.length,
}, null, 2));

async function serverConfigIndex() {
  const defaultPath = path.join(stRoot, "default", "config.yaml");
  const currentPath = path.join(stRoot, "config.yaml");
  const defaults = await readYamlIfExists(defaultPath);
  const current = await readYamlIfExists(currentPath);
  const defaultKeys = flattenKeys(defaults);
  const currentKeys = flattenKeys(current);
  return {
    defaultPath,
    currentPath,
    defaultKeys,
    currentKeys,
    missingFromCurrent: defaultKeys.filter((key) => !currentKeys.includes(key)),
    changedFromDefault: diffFlattened(defaults, current),
  };
}

async function settingsIndex() {
  const settingsPath = path.join(stRoot, "default", "content", "settings.json");
  const settings = await readJsonIfExists(settingsPath);
  return {
    path: settingsPath,
    topLevelKeys: settings ? Object.keys(settings).sort() : [],
    nestedKeys: flattenKeys(settings),
    knownLargeSections: [
      "power_user",
      "extension_settings",
      "world_info_settings",
      "oai_settings",
      "textgenerationwebui_settings",
      "koboldai_settings",
      "nai_settings",
      "horde_settings",
    ].filter((key) => settings && Object.prototype.hasOwnProperty.call(settings, key)),
  };
}

async function routeIndex() {
  const startupPath = path.join(stRoot, "src", "server-startup.js");
  const startup = await readTextIfExists(startupPath);
  const imports = new Map();
  for (const match of startup.matchAll(/import\s+\{\s*router\s+as\s+(\w+)\s*\}\s+from\s+'\.\/([^']+)'/g)) {
    imports.set(match[1], match[2].endsWith(".js") ? match[2] : `${match[2]}.js`);
  }

  const mounts = [];
  for (const match of startup.matchAll(/app\.use\('([^']+)'\s*,\s*(\w+)\)/g)) {
    mounts.push({
      prefix: match[1],
      routerVariable: match[2],
      source: imports.get(match[2]) || null,
      file: rel(startupPath),
      line: lineNumber(startup, match.index),
    });
  }

  const routes = [];
  for (const mount of mounts) {
    if (!mount.source) continue;
    const endpointPath = path.join(stRoot, "src", mount.source);
    const text = await readTextIfExists(endpointPath);
    for (const match of text.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)) {
      const method = match[1].toUpperCase();
      const localPath = match[2];
      routes.push({
        method,
        path: joinRoute(mount.prefix, localPath),
        localPath,
        mount: mount.prefix,
        file: rel(endpointPath),
        line: lineNumber(text, match.index),
      });
    }
  }

  const redirects = [];
  for (const match of startup.matchAll(/redirect\('([^']+)'\s*,\s*'([^']+)'\)/g)) {
    redirects.push({
      from: match[1],
      to: match[2],
      file: rel(startupPath),
      line: lineNumber(startup, match.index),
    });
  }

  return { mounts, routes, redirects };
}

async function configUsageIndex() {
  const files = await listFiles(path.join(stRoot, "src"), ".js");
  files.push(path.join(stRoot, "server.js"));
  const usages = [];
  for (const file of files) {
    const text = await readTextIfExists(file);
    for (const match of text.matchAll(/getConfigValue\(\s*(['"`])([^'"`]+)\1\s*(?:,\s*([^,\n)]*))?(?:,\s*(['"`])([^'"`]*)\4)?/g)) {
      usages.push({
        key: match[2],
        defaultExpression: cleanExpression(match[3]),
        converter: match[5] || null,
        file: rel(file),
        line: lineNumber(text, match.index),
      });
    }
  }
  usages.sort((a, b) => a.key.localeCompare(b.key) || a.file.localeCompare(b.file));
  return usages;
}

async function runtimeSurfaceIndex() {
  const files = [
    "public/script.js",
    "public/scripts/power-user.js",
    "public/scripts/extensions.js",
    "public/scripts/world-info.js",
    "public/scripts/openai.js",
    "public/scripts/PromptManager.js",
    "public/scripts/authors-note.js",
    "public/scripts/events.js",
    "src/plugin-loader.js",
    "src/prompt-converters.js",
    "src/endpoints/settings.js",
    "src/endpoints/extensions.js",
    "src/endpoints/characters.js",
    "src/endpoints/worldinfo.js",
    "src/endpoints/chats.js",
  ];
  const patterns = [
    /function\s+(setExtensionPrompt|getExtensionPrompt|getExtensionPromptByName|getExtensionPromptMaxDepth|getExtensionPromptRoleByName|generateQuietPrompt|addPersonaDescriptionExtensionPrompt|createRawPrompt|setPromptString|checkPromptSize|saveSettings)\b/g,
    /async\s+function\s+(Generate|generate|preparePromptsForChatCompletion|loadExtensionSettings|installExtension|loadPowerUserSettings|loadContextSettings|saveWorldInfo|loadWorldInfo|importWorldInfo)\b/g,
    /export\s+(?:async\s+)?function\s+([A-Za-z0-9_$#]+)/g,
    /export\s+class\s+([A-Za-z0-9_$#]+)/g,
    /class\s+(Prompt|PromptManager)\b/g,
    /event_types\s*=\s*\{/g,
  ];
  const surfaces = [];
  for (const file of files) {
    const absolute = path.join(stRoot, file);
    const text = await readTextIfExists(absolute);
    if (!text) continue;
    const names = new Set();
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        names.add(match[1] || "event_types");
      }
    }
    surfaces.push({
      file,
      exportsOrSeams: [...names].sort().slice(0, 80),
      lineHints: lineHints(text, [
        "setExtensionPrompt",
        "extension_prompts",
        "GENERATE_BEFORE_COMBINE_PROMPTS",
        "GENERATE_AFTER_COMBINE_PROMPTS",
        "CHAT_COMPLETION_PROMPT_READY",
        "power_user",
        "world_info_settings",
        "extension_settings",
        "loadPlugins",
        "initPlugin",
      ]),
    });
  }

  return {
    promptPipeline: [
      "public/script.js owns core non-chat-completion prompt assembly and extension prompt injection.",
      "public/scripts/openai.js owns chat-completion prompt manager preparation.",
      "src/prompt-converters.js adapts chat messages for provider-specific backends.",
      "public/scripts/world-info.js computes lore/worldbook entries before injection.",
      "public/scripts/authors-note.js and extension prompts affect prompt insertion position/depth/role.",
    ],
    extensionAndPluginPipeline: [
      "src/endpoints/extensions.js installs/discovers frontend extensions.",
      "public/scripts/extensions.js loads extension settings and frontend extension modules.",
      "src/plugin-loader.js loads server plugins when enableServerPlugins is true.",
      "server plugin routes mount under /api/plugins/{id}.",
    ],
    surfaces,
  };
}

async function dataLayoutIndex() {
  const userRoot = path.join(stRoot, "data", "default-user");
  const dirs = await listDirs(userRoot);
  return {
    userRoot,
    directories: dirs.map((dir) => path.relative(userRoot, dir) || ".").sort(),
    importantPaths: [
      "data/default-user/settings.json",
      "data/default-user/characters",
      "data/default-user/chats",
      "data/default-user/group chats",
      "data/default-user/worlds",
      "data/default-user/OpenAI Settings",
      "data/default-user/TextGen Settings",
      "data/default-user/KoboldAI Settings",
      "data/default-user/NovelAI Settings",
      "data/default-user/extensions",
      "data/default-user/secrets.json",
    ],
  };
}

function mcpPlanningIndex() {
  return {
    proposedResources: [
      "st://index",
      "st://config/schema",
      "st://config/current",
      "st://settings/schema",
      "st://settings/current",
      "st://routes",
      "st://prompt-pipeline",
      "st://prompt/inspect",
      "st://extension-registry",
      "st://plugin-registry",
      "st://data-layout",
    ],
    proposedTools: [
      "st.config.get / st.config.patch",
      "st.settings.get / st.settings.patch",
      "st.setting.explain",
      "st.prompt.inspect",
      "st.extension.registry",
      "st.extension.configure",
      "st.plugin.registry",
      "st.plugin.configure",
      "st.prompt.set_injection",
      "st.capability.plan",
      "st.apply_profile",
    ],
    designRule: "Expose intention-level tools over raw UI mirroring. The MCP interface should hide whether a change is backed by config.yaml, settings.json, an HTTP endpoint, an extension setting, or a server plugin restart.",
  };
}

function renderMarkdown(value) {
  const routeGroups = groupBy(value.serverRoutes.routes, (route) => route.mount);
  const usageGroups = groupBy(value.configUsages, (usage) => usage.key.split(".")[0]);
  return `# Upstream SillyTavern Codebase Index

Generated: ${value.generatedAt}

Target: \`${value.stRoot}\`

Package: \`${value.package?.name || "unknown"}@${value.package?.version || "unknown"}\`

Git: \`${value.git.branch || "unknown"}\` / \`${value.git.head || "unknown"}\`

## Summary

- Server config keys: ${value.serverConfig.defaultKeys.length}
- User setting top-level keys: ${value.defaultUserSettings.topLevelKeys.length}
- Mounted routers: ${value.serverRoutes.mounts.length}
- Concrete backend routes: ${value.serverRoutes.routes.length}
- Deprecated redirects: ${value.serverRoutes.redirects.length}
- Static config usages: ${value.configUsages.length}
- Default-user data directories: ${value.dataLayout.directories.length}

## Server Config

Default config: \`${rel(value.serverConfig.defaultPath)}\`

Current config: \`${rel(value.serverConfig.currentPath)}\`

Changed from default:

${renderList(value.serverConfig.changedFromDefault.slice(0, 80).map((item) => `\`${item.key}\`: \`${jsonScalar(item.defaultValue)}\` -> \`${jsonScalar(item.currentValue)}\``))}

## User Settings

Default settings: \`${rel(value.defaultUserSettings.path)}\`

Known large sections:

${renderList(value.defaultUserSettings.knownLargeSections.map((key) => `\`${key}\``))}

Top-level setting keys:

${renderColumns(value.defaultUserSettings.topLevelKeys)}

## Backend Route Mounts

${renderList(value.serverRoutes.mounts.map((mount) => `\`${mount.prefix}\` -> \`${mount.source || mount.routerVariable}\` (${mount.file}:${mount.line})`))}

## Backend Routes By Mount

${Object.entries(routeGroups).map(([mount, routes]) => {
  const shown = routes.slice(0, 40).map((route) => `\`${route.method} ${route.path}\` (${route.file}:${route.line})`);
  const suffix = routes.length > shown.length ? [`... ${routes.length - shown.length} more`] : [];
  return `### ${mount}\n\n${renderList([...shown, ...suffix])}`;
}).join("\n\n")}

## Config Usage Groups

${Object.entries(usageGroups).sort(([a], [b]) => a.localeCompare(b)).map(([group, usages]) => {
  const shown = usages.slice(0, 25).map((usage) => `\`${usage.key}\` (${usage.file}:${usage.line})`);
  const suffix = usages.length > shown.length ? [`... ${usages.length - shown.length} more`] : [];
  return `### ${group}\n\n${renderList([...shown, ...suffix])}`;
}).join("\n\n")}

## Runtime Surfaces

### Prompt Pipeline

${renderList(value.runtimeSurfaces.promptPipeline)}

### Extension And Plugin Pipeline

${renderList(value.runtimeSurfaces.extensionAndPluginPipeline)}

### Key Files

${value.runtimeSurfaces.surfaces.map((surface) => `#### ${surface.file}

Detected seams: ${surface.exportsOrSeams.length ? surface.exportsOrSeams.map((name) => `\`${name}\``).join(", ") : "none"}

Line hints:

${renderList(surface.lineHints.map((hint) => `\`${hint.pattern}\` at line ${hint.line}`))}
`).join("\n")}

## Data Layout

User root: \`${value.dataLayout.userRoot}\`

Important paths:

${renderList(value.dataLayout.importantPaths.map((item) => `\`${item}\``))}

## MCP Planning

Proposed resources:

${renderList(value.mcpPlanning.proposedResources.map((item) => `\`${item}\``))}

Proposed tools:

${renderList(value.mcpPlanning.proposedTools.map((item) => `\`${item}\``))}

Design rule: ${value.mcpPlanning.designRule}
`;
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readJsonIfExists(filePath) {
  const text = await readTextIfExists(filePath);
  if (!text) return null;
  return JSON.parse(text);
}

async function readYamlIfExists(filePath) {
  const text = await readTextIfExists(filePath);
  if (!text) return null;
  return YAML.parse(text);
}

async function gitFacts(cwd) {
  const branch = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
  const remote = await runGit(cwd, ["remote", "get-url", "origin"]);
  return { branch, head, remote };
}

async function runGit(cwd, args) {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("close", () => resolve(out.trim()));
    child.on("error", () => resolve(""));
  });
}

async function listFiles(root, suffix) {
  const out = [];
  await walk(root, async (filePath, entry) => {
    if (entry.isDirectory()) return;
    if (!suffix || filePath.endsWith(suffix)) out.push(filePath);
  });
  return out;
}

async function listDirs(root) {
  const out = [];
  await walk(root, async (filePath, entry) => {
    if (entry.isDirectory()) out.push(filePath);
  });
  return out;
}

async function walk(root, visit) {
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (sourceIgnores.has(entry.name)) continue;
    const filePath = path.join(root, entry.name);
    await visit(filePath, entry);
    if (entry.isDirectory()) await walk(filePath, visit);
  }
}

function flattenKeys(value, prefix = "") {
  if (!value || typeof value !== "object") return [];
  const keys = [];
  for (const [key, nested] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    keys.push(full);
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      keys.push(...flattenKeys(nested, full));
    }
  }
  return keys.sort();
}

function diffFlattened(defaults, current) {
  const out = [];
  const keys = new Set([...flattenKeys(defaults), ...flattenKeys(current)]);
  for (const key of [...keys].sort()) {
    const defaultValue = getPath(defaults, key);
    const currentValue = getPath(current, key);
    if (JSON.stringify(defaultValue) !== JSON.stringify(currentValue)) {
      out.push({ key, defaultValue, currentValue });
    }
  }
  return out;
}

function getPath(value, dotted) {
  return dotted.split(".").reduce((acc, key) => acc && typeof acc === "object" ? acc[key] : undefined, value);
}

function groupBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    (acc[key] ||= []).push(item);
    return acc;
  }, {});
}

function lineHints(text, patterns) {
  const hints = [];
  for (const pattern of patterns) {
    const index = text.indexOf(pattern);
    if (index >= 0) hints.push({ pattern, line: lineNumber(text, index) });
  }
  return hints;
}

function lineNumber(text, index = 0) {
  return text.slice(0, index).split("\n").length;
}

function joinRoute(prefix, localPath) {
  const left = prefix.replace(/\/+$/, "");
  const right = localPath === "/" ? "" : localPath.replace(/^\/+/, "");
  return right ? `${left}/${right}` : left || "/";
}

function cleanExpression(value) {
  if (!value) return null;
  return value.trim().replace(/\s+/g, " ").slice(0, 160);
}

function rel(filePath) {
  return path.relative(stRoot, filePath) || ".";
}

function jsonScalar(value) {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function renderList(items) {
  if (!items.length) return "- none";
  return items.map((item) => `- ${item}`).join("\n");
}

function renderColumns(items) {
  if (!items.length) return "- none";
  return items.map((item) => `- \`${item}\``).join("\n");
}
