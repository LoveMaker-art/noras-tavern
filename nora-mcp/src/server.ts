#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { NoraControlPlane } from "./nora-control-plane.js";
import { NoraHttpClient } from "./http.js";
import { StInspectionPlane } from "./st/inspection-plane.js";
import { createToolRegistrar, READ_TOOLS, WRITE_TOOLS } from "./tool-policy.js";

const config = loadConfig();
const http = new NoraHttpClient(config.baseUrl, config.timeoutMs);
const control = new StInspectionPlane(config, http);
const nora = new NoraControlPlane(config, http);
const mcp = new McpServer({
  name: "nora-mcp",
  version: "0.3.1",
});
const server = { tool: createToolRegistrar(mcp, config, http) };

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

server.tool(
  "st.character.list",
  "List existing SillyTavern characters. This reads imported cards but does not create cards.",
  {},
  async () => textResult(await control.listCharacters()),
);

server.tool(
  "st.character.inspect",
  "Read one character card with its core narrative field list.",
  {
    avatar: z.string().min(1),
  },
  async ({ avatar }) => textResult(await control.inspectCharacter(avatar)),
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
  "st.worldbook.entries",
  "List entries from one worldbook with core trigger and insertion fields.",
  {
    book: z.string().min(1),
  },
  async ({ book }) => textResult(await control.listWorldbookEntries(book)),
);

server.tool(
  "st.mvu.settings.get",
  "Read MagVarUpdate/MVU global settings and report their exact extension_settings storage path.",
  {},
  async () => textResult(await control.getMvuSettings()),
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
  "st.extension.registry",
  "List discovered frontend extensions with enabled state, inferred extension_settings config keys, and current config.",
  {},
  async () => textResult(await control.extensionRegistry()),
);

server.tool(
  "st.plugin.registry",
  "List server plugin runtime state, installed plugin manifests, and server plugin config flags.",
  {},
  async () => textResult(await control.pluginRegistry()),
);

server.tool(
  "st.regex.registry",
  "List global ST regex scripts with normalized placement metadata.",
  {},
  async () => textResult(await control.regexRegistry()),
);

server.tool(
  "st.quick_reply.registry",
  "List Quick Reply V2 settings and saved slash-command quick reply sets.",
  {},
  async () => textResult(await control.quickReplyRegistry()),
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
