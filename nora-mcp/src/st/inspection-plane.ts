import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

import type { NoraMcpConfig } from "../config.js";
import { StMcpError } from "./errors.js";
import { StHttpClient } from "./http.js";

export class StInspectionPlane {
  constructor(
    private readonly config: Pick<NoraMcpConfig, "baseUrl" | "configPath" | "mcpRoot" | "projectRoot" | "stRoot">,
    private readonly http: StHttpClient,
  ) {}

  async doctor(): Promise<Record<string, unknown>> {
    const checks: Record<string, unknown> = {
      baseUrl: this.config.baseUrl,
      mcpRoot: this.config.mcpRoot,
      stRoot: this.config.stRoot,
      configPath: this.config.configPath,
      projectRoot: this.config.projectRoot,
    };

    try {
      checks.csrf = Boolean(await this.http.csrf());
    } catch (error) {
      checks.csrf = false;
      checks.error = String(error);
    }

    checks.stRootExists = await exists(this.config.stRoot);
    checks.configExists = await exists(this.config.configPath);
    checks.packageExists = await exists(path.join(this.config.stRoot, "package.json"));

    try {
      const extensions = await this.http.get("/api/extensions/discover");
      checks.extensionsEndpoint = Array.isArray(extensions);
      checks.extensionCount = Array.isArray(extensions) ? extensions.length : 0;
    } catch (error) {
      checks.extensionsEndpoint = false;
      checks.extensionsError = String(error);
    }

    try {
      const settings = await this.http.post("/api/settings/get", {});
      checks.settingsEndpoint = isRecord(settings);
    } catch (error) {
      checks.settingsEndpoint = false;
      checks.settingsError = String(error);
    }

    checks.ok = Boolean(checks.csrf && checks.stRootExists && checks.configExists && checks.packageExists && checks.extensionsEndpoint && checks.settingsEndpoint);
    return checks;
  }

  async inspectCharacter(avatar: string): Promise<unknown> {
    const card = await this.http.post("/api/characters/get", { avatar_url: avatar });
    if (!isRecord(card)) throw new StMcpError(`character not found: ${avatar}`);
    return {
      schema: "st-character-core/v1",
      avatar,
      card,
      coreFields: characterCoreFields(),
      configurationAvailable: false,
      reason: "Library source cards are read-only; edit the active World runtime card through nora.control.execute with cards.fields.",
    };
  }

  async listCharacters(): Promise<unknown> {
    const characters = await this.http.post("/api/characters/all", {});
    if (!Array.isArray(characters)) throw new StMcpError("characters endpoint returned non-array response");
    return {
      schema: "st-character-list/v1",
      count: characters.length,
      characters,
      inspectTool: "st.character.inspect",
      chatListTool: "st.character.chats",
    };
  }

  async listCharacterChats(request: {
    avatar: string;
    metadata?: boolean;
    simple?: boolean;
  }): Promise<unknown> {
    const chats = await this.http.post("/api/characters/chats", {
      avatar_url: request.avatar,
      metadata: Boolean(request.metadata),
      simple: request.simple !== false,
    });
    if (isRecord(chats) && chats.error) throw new StMcpError(`chat directory not found for character: ${request.avatar}`);
    if (!Array.isArray(chats)) throw new StMcpError("character chats endpoint returned non-array response");
    return {
      schema: "st-character-chats/v1",
      avatar: request.avatar,
      count: chats.length,
      chats,
      inspectTool: "nora.session.read",
      requiresWorldAndSessionId: true,
    };
  }

  async listWorldbookEntries(book: string): Promise<unknown> {
    const data = await this.readWorldbook(book);
    const entries = worldbookEntryRecords(data);
    return {
      schema: "st-worldbook-entries/v1",
      book,
      count: entries.length,
      entries: entries.map(([uid, entry]) => ({
        uid: Number(uid),
        comment: entry.comment,
        enabled: !Boolean(entry.disable),
        keys: entry.key,
        secondaryKeys: entry.keysecondary,
        order: entry.order,
        position: entry.position,
        depth: entry.depth,
        role: entry.role,
        content: entry.content,
      })),
      mutationTool: "nora.control.execute",
      mutationActions: ["worldbook.update-entry", "worldbook.delete-entry"],
      mutationScope: "active-world-owned-entries",
    };
  }

  async listWorldbooks(): Promise<unknown> {
    const books = await this.http.post("/api/worldinfo/list", {});
    if (!Array.isArray(books)) throw new StMcpError("worldbook list endpoint returned non-array response");
    return {
      schema: "st-worldbook-list/v1",
      count: books.length,
      books,
      inspectTool: "st.worldbook.inspect",
      mutationTool: "nora.control.execute",
      mutationActions: ["worldbook.update-entry", "worldbook.delete-entry"],
      mutationScope: "active-world-owned-entries",
    };
  }

  async inspectWorldbook(book: string): Promise<unknown> {
    const data = await this.readWorldbook(book);
    const entries = worldbookEntryRecords(data);
    return {
      schema: "st-worldbook/v1",
      book,
      data,
      entryCount: entries.length,
      mutationTool: "nora.control.execute",
      mutationActions: ["worldbook.update-entry", "worldbook.delete-entry"],
      mutationScope: "active-world-owned-entries",
    };
  }

  async getMvuSettings(): Promise<unknown> {
    const settings = await this.settings();
    const mvuSettings = getPath(settings, "extension_settings.mvu_settings");
    const model = getPath(settings, "extension_settings.mvu_settings.额外模型解析配置");
    return {
      schema: "st-mvu-settings/v1",
      storage: {
        settingsPath: "extension_settings.mvu_settings",
        endpoint: "/api/settings/get",
        saveEndpoint: "/api/settings/save",
      },
      configured: isRecord(mvuSettings),
      enabled: isMvuVariableModelEnabled(mvuSettings),
      updateMode: getPath(mvuSettings, "更新方式") ?? null,
      model: isRecord(model) ? {
        autoRequest: model["启用自动请求"] ?? null,
        source: model["模型来源"] ?? null,
        name: model["模型名称"] ?? null,
        apiUrl: model["api地址"] ?? null,
        maxChatHistory: model.max_chat_history ?? null,
        maxReplyTokens: model["最大回复token数"] ?? null,
        temperature: model["温度"] ?? null,
      } : null,
      // The raw third-party settings can contain API secrets. Return only the
      // explicitly selected, non-secret fields above.
      connectionTool: "nora.mvu_model.configure",
      runtimeControlTool: "nora.control.execute",
      runtimeActions: ["mvu.configure", "mvu.enabled", "mvu.model", "mvu.runtime", "mvu.retry"],
    };
  }

  async listMvuEntries(options: { book?: string; includeContent?: boolean } = {}): Promise<unknown> {
    const bookNames = options.book ? [options.book] : await this.listWorldbookNames();
    const result: Array<Record<string, unknown>> = [];
    for (const book of bookNames) {
      const data = await this.readWorldbook(book).catch((error) => ({ error: String(error), entries: {} }));
      if (!isRecord(data) || data.error) {
        result.push({ book, error: isRecord(data) ? data.error : "invalid worldbook" });
        continue;
      }
      for (const [uid, entry] of worldbookEntryRecords(data)) {
        const kind = classifyMvuWorldbookEntry(entry);
        if (!kind) continue;
        result.push({
          book,
          uid: Number(uid),
          kind,
          comment: entry.comment,
          enabled: !Boolean(entry.disable),
          keys: entry.key,
          order: entry.order,
          position: entry.position,
          depth: entry.depth,
          storage: {
            uri: `st://worldbooks/${encodeURIComponent(book)}/entries/${uid}`,
            field: "entries.{uid}.disable",
          },
          content: options.includeContent ? entry.content : previewText(entry.content),
        });
      }
    }
    return {
      schema: "st-mvu-entries/v1",
      scope: options.book ? "worldbook" : "all-worldbooks",
      book: options.book,
      count: result.filter((item) => !item.error).length,
      entries: result,
      mutationTool: "nora.control.execute",
      mutationActions: ["worldbook.update-entry", "worldbook.delete-entry"],
      mutationScope: "active-world-owned-entries",
    };
  }

  async extensionRegistry(): Promise<unknown> {
    const settings: Record<string, unknown> = await this.settings();
    const extensionSettings = isRecord(settings.extension_settings) ? settings.extension_settings : {};
    const disabled = new Set(asStringArray(extensionSettings.disabledExtensions));
    const discovered = await this.http.get("/api/extensions/discover");
    if (!Array.isArray(discovered)) throw new StMcpError("Extension discovery returned a non-array response.");
    const extensions = Array.isArray(discovered) ? discovered.filter(isRecord).map((item) => {
      const name = String(item.name || "");
      const candidates = extensionConfigCandidates(name);
      const configKey = candidates.find((candidate) => Object.prototype.hasOwnProperty.call(extensionSettings, candidate)) || null;
      return {
        ...item,
        enabled: !disabled.has(name),
        configKey,
        configCandidates: candidates,
        hasConfig: Boolean(configKey),
        configKeys: configKey && isRecord(extensionSettings[configKey]) ? Object.keys(extensionSettings[configKey] as Record<string, unknown>) : [],
      };
    }) : discovered;

    return {
      extensions,
      extensionSettingsKeys: Object.keys(extensionSettings).sort(),
      disabledExtensions: [...disabled].sort(),
      controlTool: "nora.control.execute",
      controlActions: ["plugins.enabled", "plugins.configure"],
      requiresLiveClient: true,
      settingsRoot: "extension_settings",
    };
  }

  async pluginRegistry(): Promise<unknown> {
    const config = await this.readYamlFile(this.config.configPath);
    return {
      serverPluginsEnabled: getPath(config, "enableServerPlugins"),
      serverPluginsAutoUpdate: getPath(config, "enableServerPluginsAutoUpdate"),
      plugins: await this.listServerPlugins(),
      routesMount: "/api/plugins/{pluginId}",
      configurationAvailable: false,
      reason: "Server plugins are inspection-only; frontend extension controls are exposed by st.extension.registry.",
    };
  }

  async regexRegistry(): Promise<unknown> {
    const settings: Record<string, unknown> = await this.settings();
    const extensionSettings = asRecord(settings.extension_settings);
    const scripts = Array.isArray(extensionSettings.regex) ? extensionSettings.regex.filter(isRecord) : [];
    return {
      schema: "st-regex-registry/v1",
      scope: "global",
      settingsPath: "extension_settings.regex",
      placements: {
        user_input: 1,
        ai_output: 2,
        slash_command: 3,
        world_info: 5,
        reasoning: 6,
      },
      substituteRegex: { none: 0, raw: 1, escaped: 2 },
      count: scripts.length,
      scripts: scripts.map((script, index) => ({
        index,
        id: script.id,
        name: script.scriptName,
        enabled: !Boolean(script.disabled),
        findRegex: script.findRegex,
        replaceString: script.replaceString,
        placements: script.placement,
        trimStrings: script.trimStrings,
        promptOnly: script.promptOnly,
        markdownOnly: script.markdownOnly,
        runOnEdit: script.runOnEdit,
        minDepth: script.minDepth,
        maxDepth: script.maxDepth,
        substituteRegex: script.substituteRegex,
      })),
      controlTool: "nora.control.execute",
      controlActions: ["regex.create", "regex.enabled", "regex.update", "regex.delete"],
      requiresLiveClient: true,
    };
  }

  async quickReplyRegistry(): Promise<unknown> {
    const envelope: Record<string, unknown> = await this.settingsEnvelope();
    const settings = parseSettingsFromEnvelope(envelope);
    const extensionSettings = asRecord(settings.extension_settings);
    const quickReplyV2 = normalizeQuickReplySettings(extensionSettings.quickReplyV2, extensionSettings.quickReply);
    const presets: Record<string, unknown>[] = Array.isArray(envelope.quickReplyPresets)
      ? envelope.quickReplyPresets.filter(isRecord)
      : [];
    return {
      schema: "st-quick-reply-registry/v1",
      settingsPath: "extension_settings.quickReplyV2",
      setEndpoint: "/api/quick-replies/save",
      deleteEndpoint: "/api/quick-replies/delete",
      enabled: Boolean(quickReplyV2.isEnabled),
      config: quickReplyV2.config,
      sets: presets.map((preset) => ({
        name: preset.name,
        version: preset.version,
        disableSend: preset.disableSend,
        placeBeforeInput: preset.placeBeforeInput,
        injectInput: preset.injectInput,
        color: preset.color,
        quickReplies: Array.isArray(preset.qrList)
          ? preset.qrList.filter(isRecord).map((qr) => ({
            id: qr.id,
            label: qr.label,
            title: qr.title,
            hidden: qr.isHidden,
            automationId: qr.automationId,
            message: qr.message,
          }))
          : [],
      })),
      configurationAvailable: false,
      reason: "Quick Reply mutation is not part of the Nora product control catalog.",
    };
  }

  private async settings(): Promise<Record<string, unknown>> {
    const response = await this.settingsEnvelope();
    return parseSettingsFromEnvelope(response);
  }

  private async settingsEnvelope(): Promise<Record<string, unknown>> {
    const response = await this.http.post("/api/settings/get", {});
    if (!isRecord(response)) throw new StMcpError("settings endpoint returned non-object response");
    return response;
  }

  private async listServerPlugins(): Promise<unknown> {
    const pluginsPath = path.join(this.config.stRoot, "plugins");
    const entries = await fs.readdir(pluginsPath, { withFileTypes: true }).catch(() => []);
    return Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const pluginRoot = path.join(pluginsPath, entry.name);
      const packagePath = path.join(pluginRoot, "package.json");
      const manifest = await this.readJsonFile(packagePath).catch(() => null);
      return { name: entry.name, root: pluginRoot, package: manifest };
    }));
  }

  private async readWorldbook(book: string): Promise<Record<string, unknown>> {
    const data = await this.http.post("/api/worldinfo/get", { name: book });
    if (!isRecord(data)) throw new StMcpError(`worldbook not found or invalid: ${book}`);
    if (!isRecord(data.entries)) data.entries = {};
    return data;
  }

  private async listWorldbookNames(): Promise<string[]> {
    const response = await this.http.post("/api/worldinfo/list", {});
    if (!Array.isArray(response)) throw new StMcpError("worldbook list endpoint returned non-array response");
    return response
      .filter(isRecord)
      .map((book) => String(book.file_id || book.name || "").trim())
      .filter(Boolean);
  }

  private async readJsonFile(filePath: string): Promise<unknown> {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  }

  private async readYamlFile(filePath: string): Promise<Record<string, unknown>> {
    const parsed = YAML.parse(await fs.readFile(filePath, "utf8"));
    if (!isRecord(parsed)) throw new StMcpError(`YAML file did not parse to an object: ${filePath}`);
    return parsed;
  }

}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function splitPath(dottedPath: string): string[] {
  const parts = dottedPath.split(".").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new StMcpError(`invalid dotted path: ${dottedPath}`);
  return parts;
}

function getPath(target: unknown, dottedPath: string): unknown {
  const parts = splitPath(dottedPath);
  let cursor = target;
  for (const part of parts) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function isMvuVariableModelEnabled(settings: unknown): boolean {
  return isRecord(settings)
    && settings["更新方式"] === "额外模型解析"
    && asRecord(settings["额外模型解析配置"])["启用自动请求"] !== false;
}

function classifyMvuWorldbookEntry(entry: Record<string, unknown>): string | null {
  const comment = String(entry.comment || "");
  const content = String(entry.content || "");
  const keys = Array.isArray(entry.key) ? entry.key.join("\n") : "";
  const haystack = `${comment}\n${keys}\n${content}`;
  if (/\[InitVar\]/i.test(haystack)) return "init_var";
  if (/\[mvu_update\]/i.test(haystack)) return "mvu_update";
  if (/\[mvu_plot\]/i.test(haystack)) return "mvu_plot";
  if (/format_message_variable::stat_data|get_message_variable::stat_data|{{getvar::stat_data/.test(haystack)) {
    return "mvu_state_reader";
  }
  if (/变量更新规则|变量输出格式|MUV变量规则|MVU变量规则/i.test(haystack)) return "variable_rule";
  return null;
}

function previewText(value: unknown, maxLength = 240): string {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function parseSettingsFromEnvelope(envelope: Record<string, unknown>): Record<string, unknown> {
  const raw = envelope.settings;
  if (typeof raw === "string") return JSON.parse(raw) as Record<string, unknown>;
  if (isRecord(raw)) return raw;
  throw new StMcpError("settings endpoint returned no settings object");
}

function normalizeQuickReplySettings(current: unknown, legacy: unknown): Record<string, unknown> {
  if (isRecord(current)) {
    if (!isRecord(current.config)) current.config = { setList: [{ set: "Default", isVisible: true }] };
    return current;
  }
  const legacySettings = asRecord(legacy);
  return {
    isEnabled: Boolean(legacySettings.quickReplyEnabled),
    isCombined: false,
    isPopout: false,
    showPopoutButton: true,
    config: {
      setList: [{
        set: String(legacySettings.selectedPreset || legacySettings.name || "Default"),
        isVisible: true,
      }],
    },
    characterConfigs: {},
  };
}

function characterCoreFields(): string[] {
  return [
    "name",
    "description",
    "personality",
    "scenario",
    "first_mes",
    "mes_example",
    "system_prompt",
    "post_history_instructions",
    "alternate_greetings",
  ];
}

function worldbookEntryRecords(data: Record<string, unknown>): Array<[string, Record<string, unknown>]> {
  const entries = asRecord(data.entries);
  return Object.entries(entries)
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    .sort(([left], [right]) => Number(left) - Number(right));
}

function extensionConfigCandidates(name: string): string[] {
  const clean = name.trim();
  const last = clean.split("/").filter(Boolean).at(-1) || clean;
  const withoutPrefix = clean.replace(/^third-party\//, "");
  return [...new Set([withoutPrefix, last, clean].filter(Boolean))];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
