#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { NoraControlPlane } from "./nora-control-plane.js";
import { NoraHttpClient } from "./http.js";
import { StControlPlane } from "./st/control-plane.js";
import type { StMcpConfig } from "./st/config.js";
import { createToolRegistrar, READ_TOOLS, WRITE_TOOLS } from "./tool-policy.js";

const config = loadConfig();
const stConfig: StMcpConfig = {
  mcpRoot: config.mcpRoot,
  projectRoot: config.projectRoot,
  stRoot: config.stRoot,
  configPath: config.configPath,
  userDataRoot: config.userDataRoot,
  baseUrl: config.baseUrl,
  snapshotRoot: config.snapshotRoot,
  timeoutMs: config.timeoutMs,
  runtimeCommands: {},
};
const http = new NoraHttpClient(config.baseUrl, config.timeoutMs);
const control = new StControlPlane(stConfig, http);
const nora = new NoraControlPlane(config, http);
const mcp = new McpServer({
  name: "nora-mcp",
  version: "0.3.1",
});
const server = { tool: createToolRegistrar(mcp, config, http) };

const fileScopeSchema = z.enum(["project-root", "st-root", "st-mcp"]);
const promptInjectionPositionSchema = z.union([
  z.enum([
    "none",
    "in_prompt",
    "after_prompt",
    "after",
    "in_chat",
    "chat",
    "before_prompt",
    "before",
    "after_char",
    "top_an",
    "bottom_an",
    "at_depth",
  ]),
  z.number().int(),
]);
const promptInjectionRoleSchema = z.union([
  z.enum(["system", "user", "assistant"]),
  z.number().int(),
]);
const regexPlacementSchema = z.union([
  z.enum(["user_input", "ai_output", "slash_command", "world_info", "reasoning"]),
  z.number().int(),
]);
const quickReplySchema = z.object({
  id: z.number().int().positive().optional(),
  icon: z.string().optional(),
  label: z.string().min(1),
  showLabel: z.boolean().optional(),
  title: z.string().optional(),
  message: z.string().optional(),
  contextList: z.array(z.unknown()).optional(),
  preventAutoExecute: z.boolean().optional(),
  hidden: z.boolean().optional(),
  isHidden: z.boolean().optional(),
  executeOnStartup: z.boolean().optional(),
  executeOnUser: z.boolean().optional(),
  executeOnAi: z.boolean().optional(),
  executeOnChatChange: z.boolean().optional(),
  executeOnGroupMemberDraft: z.boolean().optional(),
  executeOnNewChat: z.boolean().optional(),
  executeBeforeGeneration: z.boolean().optional(),
  automationId: z.string().optional(),
});
const chatLocatorSchema = {
  avatar: z.string().min(1),
  fileName: z.string().min(1),
};
const chatMessageSchema = z.record(z.unknown());
const dottedPatchSchema = {
  updates: z.record(z.unknown()).optional(),
  unset: z.array(z.string().min(1)).optional(),
  allowUnknown: z.boolean().optional(),
  confirm: z.boolean().optional(),
  snapshotLabel: z.string().optional(),
};

function textResult(value: unknown) {
  const result = value as { ok?: boolean; operation?: { status?: string } } | null;
  return {
    isError: result?.ok === false || result?.operation?.status === "FAILED" || ["failed", "unknown", "expired"].includes(String((value as { status?: string })?.status)),
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

server.tool("st.doctor", "Check whether the target SillyTavern runtime is controllable.", {}, async () => {
  return textResult(await control.doctor());
});

server.tool(
  "st.config_locations",
  "Map high-level SillyTavern configuration domains to their real storage locations and semantic tools.",
  {},
  async () => textResult(await control.configLocations()),
);

server.tool(
  "st.resource.read",
  "Read a standard ST resource by URI, for example st://characters or st://extensions.",
  { uri: z.string().startsWith("st://") },
  async ({ uri }) => textResult(await control.readResource(uri)),
);

server.tool(
  "st.plan_change",
  "Plan a controlled ST change without writing. Use this before any destructive or complex action.",
  {
    goal: z.string().min(1),
    targetUri: z.string().startsWith("st://"),
    changes: z.unknown(),
  },
  async ({ goal, targetUri, changes }) => textResult(await control.planChange(goal, targetUri, changes)),
);

server.tool(
  "st.resource.patch",
  "Patch a supported ST resource. Requires confirm: true and creates a snapshot before writing.",
  {
    uri: z.string().startsWith("st://"),
    patch: z.record(z.unknown()),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.patchResource(request)),
);

server.tool(
  "st.character.list",
  "List existing SillyTavern characters. This reads imported cards but does not create cards.",
  {},
  async () => textResult(await control.listCharacters()),
);

server.tool(
  "st.character.inspect",
  "Read one character card with the core editable field list.",
  {
    avatar: z.string().min(1),
  },
  async ({ avatar }) => textResult(await control.inspectCharacter(avatar)),
);

server.tool(
  "st.character.configure",
  "Patch core character card fields such as description, personality, scenario, greetings, and prompts. Requires confirm: true.",
  {
    avatar: z.string().min(1),
    fields: z.record(z.unknown()),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.configureCharacter(request)),
);

server.tool(
  "st.character.chats",
  "List chat files for one character avatar.",
  {
    avatar: z.string().min(1),
    metadata: z.boolean().optional(),
    simple: z.boolean().optional(),
  },
  async (request) => textResult(await control.listCharacterChats(request)),
);

server.tool(
  "st.worldbook.list",
  "List existing worldbooks.",
  {},
  async () => textResult(await control.listWorldbooks()),
);

server.tool(
  "st.worldbook.inspect",
  "Read one worldbook including entries and extension metadata.",
  {
    book: z.string().min(1),
  },
  async ({ book }) => textResult(await control.inspectWorldbook(book)),
);

server.tool(
  "st.worldbook.create_empty",
  "Create an empty worldbook shell for later entry management. Requires confirm: true.",
  {
    name: z.string().min(1),
    overwrite: z.boolean().optional(),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.createEmptyWorldbook(request)),
);

server.tool(
  "st.worldbook.delete",
  "Delete a worldbook file. Requires confirm: true and snapshots first.",
  {
    name: z.string().min(1),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.deleteWorldbook(request)),
);

server.tool(
  "st.worldbook.entries",
  "List entries from one worldbook with core trigger and insertion fields.",
  {
    book: z.string().min(1),
  },
  async ({ book }) => textResult(await control.listWorldbookEntries(book)),
);

server.tool(
  "st.worldbook.entry.configure",
  "Create, update, enable/disable, or delete a single worldbook entry. Requires confirm: true.",
  {
    book: z.string().min(1),
    action: z.enum(["upsert", "set_enabled", "delete"]).optional(),
    uid: z.number().int().nonnegative().optional(),
    comment: z.string().optional(),
    fields: z.record(z.unknown()).optional(),
    enabled: z.boolean().optional(),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.configureWorldbookEntry(request)),
);

server.tool(
  "st.mvu.settings.get",
  "Read MagVarUpdate/MVU global settings and report their exact extension_settings storage path.",
  {},
  async () => textResult(await control.getMvuSettings()),
);

server.tool(
  "st.mvu.settings.configure",
  "Configure MagVarUpdate/MVU global settings through semantic fields. Requires confirm: true.",
  {
    enabled: z.boolean().optional(),
    updateMode: z.string().optional(),
    modelSource: z.string().optional(),
    modelName: z.string().optional(),
    apiUrl: z.string().optional(),
    apiKey: z.string().optional(),
    maxChatHistory: z.number().int().nonnegative().optional(),
    maxReplyTokens: z.number().int().nonnegative().optional(),
    temperature: z.number().optional(),
    updates: z.record(z.unknown()).optional(),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.configureMvuSettings(request)),
);

server.tool(
  "st.mvu.entries",
  "List MVU-related worldbook entries and their exact disable/enabled storage field.",
  {
    book: z.string().min(1).optional(),
    includeContent: z.boolean().optional(),
  },
  async (request) => textResult(await control.listMvuEntries(request)),
);

server.tool(
  "st.mvu.entry.set_enabled",
  "Enable or disable one MVU-related worldbook entry. Requires confirm: true.",
  {
    book: z.string().min(1),
    uid: z.number().int().nonnegative().optional(),
    comment: z.string().optional(),
    enabled: z.boolean(),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.setMvuEntryEnabled(request)),
);

server.tool(
  "st.config.get",
  "Read parsed config.yaml or one dotted config path with default value and code usage hints.",
  {
    path: z.string().min(1).optional(),
    includeDefault: z.boolean().optional(),
  },
  async ({ path, includeDefault }) => textResult(await control.getConfigValue(path, includeDefault !== false)),
);

server.tool(
  "st.config.patch",
  "Patch config.yaml by dotted paths. Requires confirm: true, snapshots first, and usually requires ST restart.",
  dottedPatchSchema,
  async (request) => textResult(await control.patchConfig(request)),
);

server.tool(
  "st.snapshot",
  "Create a filesystem snapshot of important ST config, user data, extension, and plugin paths.",
  { label: z.string().optional() },
  async ({ label }) => textResult(await control.snapshots.create(label)),
);

server.tool(
  "st.rollback",
  "Restore a snapshot created by st.snapshot or a confirmed write operation.",
  { id: z.string().min(1), confirm: z.boolean().optional() },
  async ({ id, confirm }) => {
    if (!confirm) throw new Error("rollback requires confirm: true");
    return textResult(await control.snapshots.rollback(id));
  },
);

server.tool(
  "st.extension.install",
  "Install a SillyTavern frontend extension from a Git URL via the ST extension endpoint.",
  {
    url: z.string().url(),
    global: z.boolean().optional(),
    branch: z.string().optional(),
    confirm: z.boolean().optional(),
  },
  async ({ url, global, branch, confirm }) => textResult(await control.installExtension(url, Boolean(confirm), Boolean(global), branch)),
);

server.tool(
  "st.extension.set_enabled",
  "Enable or disable a discovered SillyTavern frontend extension. Requires confirm: true.",
  {
    name: z.string().min(1),
    enabled: z.boolean(),
    confirm: z.boolean().optional(),
  },
  async ({ name, enabled, confirm }) => textResult(await control.setExtensionEnabled(name, enabled, Boolean(confirm))),
);

server.tool(
  "st.extension.registry",
  "List discovered frontend extensions with enabled state, inferred extension_settings config keys, and current config.",
  {},
  async () => textResult(await control.extensionRegistry()),
);

server.tool(
  "st.extension.configure",
  "Configure a frontend extension through extension_settings and/or enabled state. Requires confirm: true.",
  {
    name: z.string().min(1).optional(),
    configKey: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    updates: z.record(z.unknown()).optional(),
    unset: z.array(z.string().min(1)).optional(),
    allowCreate: z.boolean().optional(),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.configureExtension(request)),
);

server.tool(
  "st.plugin.install",
  "Install a SillyTavern server plugin from a Git URL into the plugins directory. Requires confirm: true.",
  {
    url: z.string().url(),
    name: z.string().optional(),
    branch: z.string().optional(),
    installDependencies: z.boolean().optional(),
    confirm: z.boolean().optional(),
  },
  async ({ url, name, branch, installDependencies, confirm }) => textResult(await control.installServerPlugin(url, Boolean(confirm), {
    name,
    branch,
    installDependencies,
  })),
);

server.tool(
  "st.plugin.scaffold",
  "Create a loadable SillyTavern server plugin skeleton. Requires confirm: true.",
  {
    id: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    confirm: z.boolean().optional(),
  },
  async (request) => textResult(await control.scaffoldServerPlugin(request)),
);

server.tool(
  "st.plugin.registry",
  "List server plugin runtime state, installed plugin manifests, and server plugin config flags.",
  {},
  async () => textResult(await control.pluginRegistry()),
);

server.tool(
  "st.plugin.configure",
  "Configure SillyTavern server plugin flags in config.yaml. Requires confirm: true and restart.",
  {
    enableServerPlugins: z.boolean().optional(),
    enableServerPluginsAutoUpdate: z.boolean().optional(),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.configurePlugin(request)),
);

server.tool(
  "st.source.read",
  "Read a source file from project-root, st-root, or st-mcp without leaving that scope.",
  {
    scope: fileScopeSchema,
    path: z.string().min(1),
    maxBytes: z.number().int().positive().optional(),
  },
  async ({ scope, path, maxBytes }) => textResult(await control.readSourceFile(scope, path, maxBytes)),
);

server.tool(
  "st.source.write",
  "Write a source file within project-root, st-root, or st-mcp. Requires confirm: true and snapshots first.",
  {
    scope: fileScopeSchema,
    path: z.string().min(1),
    content: z.string(),
    snapshotLabel: z.string().optional(),
    confirm: z.boolean().optional(),
  },
  async (request) => textResult(await control.writeSourceFile(request)),
);

server.tool(
  "st.dev.run",
  "Run a controlled development command in project-root, st-root, or st-mcp. Requires confirm: true.",
  {
    scope: fileScopeSchema,
    command: z.enum(["npm", "node", "npx", "git", "sh", "bash", "python3"]),
    args: z.array(z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
    confirm: z.boolean().optional(),
  },
  async (request) => textResult(await control.runDevCommand(request)),
);

server.tool(
  "st.runtime.control",
  "Run configured SillyTavern runtime status/start/stop/restart commands. Mutating actions require confirm: true.",
  {
    action: z.enum(["status", "start", "stop", "restart"]),
    confirm: z.boolean().optional(),
  },
  async ({ action, confirm }) => textResult(await control.controlRuntime(action, Boolean(confirm))),
);

server.tool(
  "st.bridge.install",
  "Install the ST MCP runtime bridge server plugin and frontend extension. Requires confirm: true.",
  {
    confirm: z.boolean().optional(),
  },
  async ({ confirm }) => textResult(await control.installRuntimeBridge(Boolean(confirm))),
);

server.tool(
  "st.bridge.health",
  "Read the runtime bridge server plugin health endpoint.",
  {},
  async () => textResult(await control.runtimeBridgeHealth()),
);

server.tool(
  "st.bridge.read",
  "Read the latest browser runtime snapshot published by the ST MCP runtime bridge.",
  {
    history: z.boolean().optional(),
  },
  async ({ history }) => textResult(await control.readRuntimeBridgeSnapshot(Boolean(history))),
);

server.tool(
  "st.index.refresh",
  "Regenerate the static upstream ST codebase index used by st://index and st://index/markdown. Requires confirm: true.",
  {
    confirm: z.boolean().optional(),
  },
  async ({ confirm }) => textResult(await control.refreshCodebaseIndex(Boolean(confirm))),
);

server.tool(
  "st.prompt.inspect",
  "Inspect the prompt/context assembly surface: indexed seams, live prompt-related settings, and optional runtime bridge state.",
  {
    includeRuntime: z.boolean().optional(),
  },
  async ({ includeRuntime }) => textResult(await control.inspectPrompt({ includeRuntime })),
);

server.tool(
  "st.prompt.set_injection",
  "Change prompt injection semantics without knowing raw ST setting paths. Requires confirm: true and snapshots first.",
  {
    target: z.enum(["authors_note", "persona", "world_info", "system_prompt", "instruct", "context"]),
    enabled: z.boolean().optional(),
    text: z.string().optional(),
    position: promptInjectionPositionSchema.optional(),
    depth: z.number().int().nonnegative().optional(),
    role: promptInjectionRoleSchema.optional(),
    budget: z.number().int().nonnegative().optional(),
    budgetCap: z.number().int().nonnegative().optional(),
    interval: z.number().int().nonnegative().optional(),
    scan: z.boolean().optional(),
    recursive: z.boolean().optional(),
    includeNames: z.boolean().optional(),
    overflowAlert: z.boolean().optional(),
    caseSensitive: z.boolean().optional(),
    matchWholeWords: z.boolean().optional(),
    characterStrategy: z.number().int().nonnegative().optional(),
    preset: z.string().optional(),
    name: z.string().optional(),
    postHistory: z.string().optional(),
    updates: z.record(z.unknown()).optional(),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.setPromptInjection(request)),
);

server.tool(
  "st.regex.registry",
  "List global ST regex scripts with normalized placement metadata.",
  {},
  async () => textResult(await control.regexRegistry()),
);

server.tool(
  "st.regex.configure",
  "Create, update, enable/disable, or delete a global ST regex script. Requires confirm: true.",
  {
    name: z.string().min(1),
    action: z.enum(["upsert", "set_enabled", "delete"]).optional(),
    enabled: z.boolean().optional(),
    findRegex: z.string().optional(),
    replaceString: z.string().optional(),
    placements: z.array(regexPlacementSchema).optional(),
    trimStrings: z.array(z.string()).optional(),
    substituteRegex: z.union([z.enum(["none", "raw", "escaped"]), z.number().int()]).optional(),
    markdownOnly: z.boolean().optional(),
    promptOnly: z.boolean().optional(),
    runOnEdit: z.boolean().optional(),
    minDepth: z.number().int().nonnegative().nullable().optional(),
    maxDepth: z.number().int().nonnegative().nullable().optional(),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.configureRegex(request)),
);

server.tool(
  "st.variables.registry",
  "List global ST slash/macro variables stored in extension_settings.variables.global.",
  {},
  async () => textResult(await control.variablesRegistry()),
);

server.tool(
  "st.variables.set",
  "Set or unset a global ST slash/macro variable. Requires confirm: true.",
  {
    name: z.string().min(1),
    value: z.string().optional(),
    unset: z.boolean().optional(),
    asJson: z.boolean().optional(),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.setVariable(request)),
);

server.tool(
  "st.quick_reply.registry",
  "List Quick Reply V2 settings and saved slash-command quick reply sets.",
  {},
  async () => textResult(await control.quickReplyRegistry()),
);

server.tool(
  "st.quick_reply.configure",
  "Enable Quick Reply, activate a set, create/update/delete a set, or upsert/delete a slash-command quick reply. Requires confirm: true.",
  {
    enabled: z.boolean().optional(),
    activeSet: z.string().min(1).optional(),
    set: z.string().min(1).optional(),
    setOptions: z.record(z.unknown()).optional(),
    reply: quickReplySchema.optional(),
    deleteReplyLabel: z.string().min(1).optional(),
    deleteSet: z.boolean().optional(),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.configureQuickReply(request)),
);

server.tool(
  "st.chat.inspect",
  "Read a chat file header, chat_metadata, and messages. Requires explicit avatar and fileName.",
  chatLocatorSchema,
  async (request) => textResult(await control.inspectChat(request)),
);

server.tool(
  "st.chat.metadata.get",
  "Read chat_metadata from a specific ST chat file. Requires explicit avatar and fileName.",
  chatLocatorSchema,
  async (request) => textResult(await control.getChatMetadata(request)),
);

server.tool(
  "st.chat.metadata.patch",
  "Patch chat_metadata dotted paths in a specific ST chat file. Requires confirm: true.",
  {
    ...chatLocatorSchema,
    updates: z.record(z.unknown()).optional(),
    unset: z.array(z.string().min(1)).optional(),
    force: z.boolean().optional(),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.patchChatMetadata(request)),
);

server.tool(
  "st.chat.authors_note.set",
  "Set the current-chat Author's Note override fields in chat_metadata. Requires explicit avatar/fileName and confirm: true.",
  {
    ...chatLocatorSchema,
    enabled: z.boolean().optional(),
    text: z.string().optional(),
    position: promptInjectionPositionSchema.optional(),
    depth: z.number().int().nonnegative().optional(),
    role: promptInjectionRoleSchema.optional(),
    interval: z.number().int().nonnegative().optional(),
    force: z.boolean().optional(),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.setChatAuthorsNote(request)),
);

server.tool(
  "st.chat.variables.set",
  "Set or unset a local slash/macro variable stored in a specific chat's chat_metadata.variables. Requires confirm: true.",
  {
    ...chatLocatorSchema,
    name: z.string().min(1),
    value: z.string().optional(),
    unset: z.boolean().optional(),
    asJson: z.boolean().optional(),
    force: z.boolean().optional(),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.setChatVariable(request)),
);

server.tool(
  "st.chat.script_inject.configure",
  "Create, update, or delete a persistent slash-command-style prompt injection in chat_metadata.script_injects. Requires confirm: true.",
  {
    ...chatLocatorSchema,
    id: z.string().min(1),
    value: z.string().optional(),
    position: promptInjectionPositionSchema.optional(),
    depth: z.number().int().nonnegative().optional(),
    role: promptInjectionRoleSchema.optional(),
    scan: z.boolean().optional(),
    filter: z.string().nullable().optional(),
    delete: z.boolean().optional(),
    force: z.boolean().optional(),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.configureChatScriptInject(request)),
);

server.tool(
  "st.chat.worldbook.bind",
  "Bind or unbind a worldbook to one chat through chat_metadata.world_info. Requires confirm: true.",
  {
    ...chatLocatorSchema,
    book: z.string().min(1).optional(),
    unset: z.boolean().optional(),
    force: z.boolean().optional(),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.bindChatWorldbook(request)),
);

server.tool(
  "st.chat.message.append",
  "Append a caller-provided message to a chat transcript. Requires confirm: true; does not generate message content.",
  {
    ...chatLocatorSchema,
    message: chatMessageSchema,
    force: z.boolean().optional(),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.appendChatMessage(request)),
);

server.tool(
  "st.chat.message.edit",
  "Edit one existing chat message by zero-based transcript index. Requires confirm: true.",
  {
    ...chatLocatorSchema,
    index: z.number().int().nonnegative(),
    message: chatMessageSchema.optional(),
    fields: chatMessageSchema.optional(),
    force: z.boolean().optional(),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.editChatMessage(request)),
);

server.tool(
  "st.chat.message.delete",
  "Delete one existing chat message by zero-based transcript index. Requires confirm: true.",
  {
    ...chatLocatorSchema,
    index: z.number().int().nonnegative(),
    force: z.boolean().optional(),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.deleteChatMessage(request)),
);

server.tool(
  "st.mvu.chat_state.inspect",
  "Inspect MVU runtime variable snapshots stored in chat message variables[].stat_data.",
  chatLocatorSchema,
  async (request) => textResult(await control.inspectMvuChatState(request)),
);

server.tool(
  "st.mvu.chat_state.patch",
  "Patch MVU runtime stat_data on one chat message, defaulting to the latest message. Requires confirm: true.",
  {
    ...chatLocatorSchema,
    index: z.number().int().nonnegative().optional(),
    updates: z.record(z.unknown()).optional(),
    unset: z.array(z.string().min(1)).optional(),
    force: z.boolean().optional(),
    confirm: z.boolean().optional(),
    snapshotLabel: z.string().optional(),
  },
  async (request) => textResult(await control.patchMvuChatState(request)),
);

server.tool(
  "st.verify",
  "Verify that a resource can be read after a change. This is a technical check, not a UX proof.",
  { targetUri: z.string().startsWith("st://").optional() },
  async ({ targetUri }) => textResult(await control.verify(targetUri)),
);

server.tool("nora.status", "Check Nora Tavern product endpoints and embedded ST core controls.", {}, async () => {
  return textResult(await nora.status(() => control.doctor()));
});

server.tool("nora.control_map", "Explain the single Nora MCP control surface: nora.* for product logic, st.* for embedded ST core logic.", {}, async () => {
  return textResult({ ...await nora.controlMap(), mode: config.mode,
    availableTools: [...READ_TOOLS, ...(config.mode === "operator" ? WRITE_TOOLS : [])],
    frontendExecution: "available-when-target-page-connected", maintenanceTools: "not-exposed" });
});

server.tool("nora.config_locations", "Map Nora product domains to real storage locations, runtime routes, and semantic tools.", {}, async () => {
  return textResult(await nora.configLocations());
});

server.tool("nora.read", "Read a Nora resource URI such as nora://worlds or nora://story-profile/card.", {
  uri: z.string().startsWith("nora://"),
}, async ({ uri }) => textResult(await nora.readResource(uri)));

server.tool("nora.boot.bootstrap", "Read Nora boot/bootstrap state used by the app shell.", {}, async () => {
  return textResult(await nora.bootstrap());
});

server.tool("nora.local_index", "Inspect local Nora/ST product data counts without modifying files.", {}, async () => {
  return textResult(await nora.localIndex());
});

server.tool("nora.world.list", "List authoritative Nora Worlds from Nora World Core.", {}, async () => {
  return textResult(await nora.listWorlds());
});

server.tool("nora.world.inspect", "Inspect one Nora World plus its open plan.", {
  worldId: z.string(),
}, async ({ worldId }) => textResult(await nora.inspectWorld(worldId)));

server.tool("nora.world.open_plan", "Read the ST activation plan Nora would execute when opening a World.", {
  worldId: z.string(),
}, async ({ worldId }) => textResult(await nora.worldOpenPlan(worldId)));

server.tool("nora.world.snapshot", "Read the activation snapshot for a Nora World.", {
  worldId: z.string(),
}, async ({ worldId }) => textResult(await nora.worldSnapshot(worldId)));

server.tool("nora.world.repair", "Run Nora's non-destructive World repair flow. Requires confirm: true.", {
  worldId: z.string(),
  idempotencyKey: z.string().trim().min(1).max(200),
  confirm: z.boolean().optional(),
}, async ({ worldId, idempotencyKey, confirm }) => textResult(await nora.repairWorld(worldId, idempotencyKey, confirm)));

server.tool("nora.world.delete", "Delete a Nora World through the durable Nora World Core mutation flow. Requires confirm: true.", {
  worldId: z.string(),
  idempotencyKey: z.string().trim().min(1).max(200),
  confirm: z.boolean().optional(),
}, async ({ worldId, idempotencyKey, confirm }) => textResult(await nora.deleteWorld(worldId, idempotencyKey, confirm)));

server.tool("nora.operation.get", "Read a Nora World operation by operation id.", {
  operationId: z.string(),
}, async ({ operationId }) => textResult(await nora.getOperation(operationId)));

server.tool("nora.operation.retry", "Retry a failed Nora World operation. Requires confirm: true.", {
  operationId: z.string(),
  confirm: z.boolean().optional(),
}, async ({ operationId, confirm }) => textResult(await nora.retryOperation(operationId, confirm)));

server.tool("nora.capability.begin", "Begin a Nora World capability attempt. Requires confirm: true.", {
  worldId: z.string(),
  capability: z.string(),
  confirm: z.boolean().optional(),
}, async ({ worldId, capability, confirm }) => textResult(await nora.beginCapabilityAttempt(worldId, capability, confirm)));

server.tool("nora.capability.settle", "Settle a Nora World capability attempt as READY or DEGRADED. Requires confirm: true.", {
  worldId: z.string(),
  capability: z.string(),
  attemptId: z.string(),
  status: z.enum(["READY", "DEGRADED"]),
  evidence: z.record(z.unknown()).optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean().optional(),
  }).optional(),
  confirm: z.boolean().optional(),
}, async (request) => textResult(await nora.settleCapabilityAttempt(request)));

server.tool("nora.story.card", "Read Nora Story Profile actor card.", {}, async () => {
  return textResult(await nora.storyCard());
});

server.tool("nora.story.checkpoint.status", "Read Story Profile checkpoint status for a Nora World.", {
  worldId: z.string(),
}, async ({ worldId }) => textResult(await nora.storyCheckpointStatus(worldId)));

server.tool("nora.story.checkpoint", "Schedule or run Story Profile checkpoint for a Nora World. Requires confirm: true.", {
  worldId: z.string(),
  allowModelCall: z.literal(true),
  confirm: z.boolean().optional(),
}, async ({ worldId, confirm }) => textResult(await nora.storyCheckpoint(worldId, confirm)));

server.tool("nora.story.reflect_preview", "PAID model reflection preview without saving; not a free context inspection. Do not retry automatically after timeout.", {
  worldId: z.string(),
  confirm: z.literal(true),
  allowModelCall: z.literal(true),
}, async ({ worldId }) => textResult(await nora.storyReflectPreview(worldId)));

server.tool("nora.story.learn", "Write Story Profile learning data through Nora's adapter. Requires confirm: true.", {
  payload: z.object({ change: z.string().trim().min(1).max(10000), reason: z.string().max(10000).optional() }),
  allowModelCall: z.literal(true),
  confirm: z.boolean().optional(),
}, async ({ payload, confirm }) => textResult(await nora.storyLearn(payload, confirm)));

server.tool("nora.story.refresh", "Refresh Story Profile taste/personality state. Requires confirm: true.", {
  allowModelCall: z.literal(true),
  confirm: z.boolean().optional(),
}, async ({ confirm }) => textResult(await nora.storyRefresh(confirm)));

server.tool("nora.mvu_model.get", "Read Nora's independent MVU parser model configuration.", {}, async () => {
  return textResult(await nora.mvuModelConfig());
});

server.tool("nora.mvu_model.configure", "Configure Nora's independent MVU parser model. Requires confirm: true.", {
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  confirm: z.boolean().optional(),
}, async (request) => textResult(await nora.configureMvuModel(request)));

const transport = new StdioServerTransport();
server.tool("nora.background.import", "Import a PNG/JPEG/WebP within the configured upload directory, at most 12 MiB. Returns a persistent content-addressed background URL; does NOT change any World. Applying it uses theme.apply.", {
  filePath: z.string().min(1), confirm: z.literal(true),
}, async request => textResult(await nora.importBackground(request.filePath)));
const scopeSchema = { worldId: z.string().min(1), sessionId: z.string().min(1) };
const operationSchema = { idempotencyKey: z.string().trim().min(1).max(200), confirm: z.literal(true) };
server.tool("nora.world.create", "Create a blank World through World Core. Reuse idempotencyKey on uncertain outcomes; does not open a browser.", {
  ...operationSchema, name: z.string().trim().min(1).max(200), personaName: z.string().max(200).optional(), personaDescription: z.string().max(10000).optional(),
}, async request => textResult(await nora.createWorld(request)));
server.tool("nora.world.import_library", "Create a NEW World from an existing library card. Reuse the same idempotencyKey for retries, not for intentional new Worlds.", {
  ...operationSchema, avatar: z.string().min(1),
}, async request => textResult(await nora.importLibrary(request.avatar, request.idempotencyKey)));
server.tool("nora.world.import", "Import a card within the configured upload directory. World Core owns parsing and idempotency; browser MVU activation is separate.", {
  ...operationSchema, filePath: z.string().min(1), name: z.string().max(200).optional(), personaName: z.string().max(200).optional(), personaDescription: z.string().max(10000).optional(),
}, async request => textResult(await nora.importWorld(request)));
server.tool("nora.ledger.status", "Read ledger state WITHOUT scheduling models, repairing state or updating memory. pending is not active.", scopeSchema,
  async request => textResult(await nora.ledgerInspect({ ...request, limit: 0 })));
server.tool("nora.session.read", "Read a bounded narrative window and its full-history expectedSignature. IDs are message indexes, not turn numbers. No generation.", {
  ...scopeSchema, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(30),
}, async request => textResult(await nora.ledgerInspect(request)));
server.tool("nora.ledger.configure", "Enable/disable ledger. Enabling may schedule PAID background compression. Disabling does not unlock active history.", {
  ...scopeSchema, enabled: z.boolean(), confirm: z.literal(true), allowModelCall: z.boolean().optional(),
}, async request => textResult(await nora.ledgerConfigure(request)));
server.tool("nora.ledger.compress", "Schedule/retry PAID compression; returns current state, not a completion claim. Inspect with nora.ledger.status.", {
  ...scopeSchema, confirm: z.literal(true), allowModelCall: z.literal(true),
}, async request => textResult(await nora.ledgerCompress(request)));
server.tool("nora.session.edit", "Edit an unlocked narrative message and DELETE ALL FOLLOWING MESSAGES via Nora. Requires the signature from session.read. May resume PAID background compression; no frontend execution claim.", {
  ...scopeSchema, messageId: z.number().int().min(0), text: z.string().max(100000).refine(value => value.trim().length > 0, "Non-empty narrative text is required"), expectedSignature: z.string().regex(/^[a-f0-9]{64}$/),
  confirm: z.literal(true), allowModelCall: z.literal(true),
}, async request => textResult(await nora.editSession(request)));
server.tool("nora.control.catalog", "List the actual World/Persona/worldbook/text-model and plugin/script actions, parameter types, and authorization requirements.", {},
  async () => textResult(await nora.controlCatalog()));
server.tool("nora.control.clients", "List live Tavern pages with client IDs and World/Session identities. Never guess a target or select the first tab silently.", {},
  async () => textResult(await nora.controlClients()));
server.tool("nora.control.operation", "Query a control operation. queued/running is NOT success; unknown must not be blindly retried. Completed result may require page reload.", {
  operationId: z.string().min(1),
}, async request => textResult(await nora.controlOperation(request.operationId)));
const controlTarget = {
  clientId: z.string().min(8).max(100), worldId: z.string().max(192), sessionId: z.string().max(192),
  action: z.string().min(1).max(100), params: z.record(z.unknown()).default({}), idempotencyKey: z.string().min(1).max(200),
};
server.tool("nora.control.read", "Request a live READ-ONLY World/Persona/worldbook/model/plugin inspection from the exact page/World. Get operation ID then query nora.control.operation. Read endpoint forbids mutations.", controlTarget,
  async request => textResult(await nora.controlRequest(request, true)));
server.tool("nora.control.execute", "Execute one catalogued World/Persona/worldbook/model/plugin action on the exact target page. Explicit model/script consent required when catalog says so. Reuse idempotencyKey after transport failure; never claim success before acknowledgment.", {
  ...controlTarget, confirm: z.literal(true), allowModelCall: z.boolean().optional(), allowScriptExecution: z.boolean().optional(),
}, async request => textResult(await nora.controlRequest(request, false)));
await mcp.connect(transport);
