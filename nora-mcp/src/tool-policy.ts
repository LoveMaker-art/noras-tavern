import fs from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { NoraMcpConfig } from "./config.js";
import { NoraRequestError } from "./errors.js";
import type { NoraHttpClient } from "./http.js";

export const READ_TOOLS = new Set([
  "nora.control.catalog", "nora.control.clients", "nora.control.read", "nora.control.operation",
  "nora.status", "nora.control_map", "nora.config_locations", "nora.local_index",
  "nora.world.list", "nora.world.inspect", "nora.world.open_plan", "nora.world.snapshot", "nora.operation.get",
  "nora.story.card", "nora.story.checkpoint.status", "nora.mvu_model.get", "nora.ledger.status", "nora.session.read",
  "st.character.list", "st.character.inspect", "st.character.chats", "st.worldbook.list", "st.worldbook.inspect", "st.worldbook.entries",
  "st.mvu.settings.get", "st.mvu.entries", "st.extension.registry", "st.plugin.registry", "st.regex.registry", "st.quick_reply.registry",
]);
export const WRITE_TOOLS = new Set([
  "nora.background.import",
  "nora.control.execute",
  "nora.world.create", "nora.world.import", "nora.world.import_library", "nora.world.repair", "nora.world.delete", "nora.operation.retry",
  "nora.story.checkpoint", "nora.story.reflect_preview", "nora.story.learn", "nora.story.refresh", "nora.mvu_model.configure",
  "nora.ledger.configure", "nora.ledger.compress", "nora.session.edit",
]);
export function allowedTool(name: string, mode: NoraMcpConfig["mode"]): boolean {
  return READ_TOOLS.has(name) || (mode === "operator" && WRITE_TOOLS.has(name));
}
export async function assertInstance(config: NoraMcpConfig, http: NoraHttpClient): Promise<void> {
  const remote = await http.get("/api/nora-worlds-v2/status") as { userDataRoot?: string };
  if (!remote?.userDataRoot) throw new NoraRequestError("Backend instance identity is required before writes.", "NORA_INSTANCE_UNVERIFIED");
  const [expected, actual] = await Promise.all([fs.realpath(config.userDataRoot), fs.realpath(remote.userDataRoot)]);
  if (expected !== actual) throw new NoraRequestError("HTTP backend and data directory are different instances.", "NORA_INSTANCE_MISMATCH");
}
export function createToolRegistrar(server: McpServer, config: NoraMcpConfig, http: NoraHttpClient) {
  return function tool<S extends z.ZodRawShape>(name: string, description: string, schema: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>) {
    if (!allowedTool(name, config.mode)) return;
    const readOnly = READ_TOOLS.has(name);
    return server.registerTool<z.ZodRawShape, z.ZodRawShape>(name, { description, inputSchema: schema, annotations: {
      readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: !readOnly,
    } }, async (args): Promise<CallToolResult> => {
      try {
        if (!readOnly && args.confirm !== true) throw new NoraRequestError("This write requires the user's confirmation.", "NORA_CONFIRMATION_REQUIRED");
        const modelAction = ["nora.story.checkpoint", "nora.story.reflect_preview", "nora.story.learn", "nora.story.refresh", "nora.ledger.compress", "nora.session.edit"].includes(name)
          || (name === "nora.ledger.configure" && args.enabled === true);
        if (modelAction && args.allowModelCall !== true) throw new NoraRequestError("This operation can call a model, including background compression. Explicit allowModelCall is required.", "NORA_MODEL_CALL_NOT_AUTHORIZED");
        // Metadata/diagnostics remain available when disconnected. All domain
        // reads and writes must address the same filesystem/HTTP instance.
        if (!["nora.status", "nora.control_map", "nora.config_locations"].includes(name)) await assertInstance(config, http);
        return await handler(args as z.infer<z.ZodObject<S>>);
      } catch (error) {
        const request = error instanceof NoraRequestError ? error : null;
        return { isError: true, content: [{ type: "text", text: JSON.stringify({
          ok: false, code: request?.code || "NORA_TOOL_FAILED", outcome: request?.outcome || "rejected",
          message: request?.message || "Operation failed. Check input and instance; do not blindly retry writes.",
          ...request?.details,
        }) }] };
      }
    });
  };
}
