import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import YAML from "yaml";

import {
  BRIDGE_ID,
  bridgeExtensionIndex,
  bridgeExtensionManifest,
  bridgeExtensionReadme,
  bridgeServerPluginIndex,
  bridgeServerPluginPackage,
  bridgeServerPluginReadme,
} from "./bridge-templates.js";
import { StMcpConfig } from "./config.js";
import { ConfirmationRequiredError, StMcpError } from "./errors.js";
import { StHttpClient } from "./http.js";
import { SnapshotManager } from "./snapshots.js";

const execFileAsync = promisify(execFile);

export interface PatchRequest {
  uri: string;
  patch: unknown;
  confirm?: boolean;
  snapshotLabel?: string;
}

type FileScope = "project-root" | "st-root" | "st-mcp";
type RuntimeAction = "status" | "start" | "stop" | "restart";
type ConfigDomain = "config" | "settings";
type PromptInjectionTarget = "authors_note" | "persona" | "world_info" | "system_prompt" | "instruct" | "context";
type RegexPlacementName = "user_input" | "ai_output" | "slash_command" | "world_info" | "reasoning";

export interface PromptInjectionRequest {
  target: PromptInjectionTarget;
  enabled?: boolean;
  text?: string;
  position?: string | number;
  depth?: number;
  role?: string | number;
  budget?: number;
  budgetCap?: number;
  interval?: number;
  scan?: boolean;
  recursive?: boolean;
  includeNames?: boolean;
  overflowAlert?: boolean;
  caseSensitive?: boolean;
  matchWholeWords?: boolean;
  characterStrategy?: number;
  preset?: string;
  name?: string;
  postHistory?: string;
  updates?: Record<string, unknown>;
  confirm?: boolean;
  snapshotLabel?: string;
}

const extensionPromptTypes = {
  none: -1,
  in_prompt: 0,
  after_prompt: 0,
  after: 0,
  in_chat: 1,
  chat: 1,
  before_prompt: 2,
  before: 2,
} as const;

const extensionPromptRoles = {
  system: 0,
  user: 1,
  assistant: 2,
} as const;

const personaDescriptionPositions = {
  in_prompt: 0,
  after_char: 1,
  top_an: 2,
  bottom_an: 3,
  at_depth: 4,
  none: 9,
} as const;

const regexPlacements = {
  user_input: 1,
  ai_output: 2,
  slash_command: 3,
  world_info: 5,
  reasoning: 6,
} as const;

export interface RegexConfigureRequest {
  name: string;
  action?: "upsert" | "set_enabled" | "delete";
  enabled?: boolean;
  findRegex?: string;
  replaceString?: string;
  placements?: Array<RegexPlacementName | number>;
  trimStrings?: string[];
  substituteRegex?: "none" | "raw" | "escaped" | number;
  markdownOnly?: boolean;
  promptOnly?: boolean;
  runOnEdit?: boolean;
  minDepth?: number | null;
  maxDepth?: number | null;
  confirm?: boolean;
  snapshotLabel?: string;
}

export interface QuickReplyConfigureRequest {
  enabled?: boolean;
  activeSet?: string;
  set?: string;
  setOptions?: Record<string, unknown>;
  reply?: Record<string, unknown>;
  deleteReplyLabel?: string;
  deleteSet?: boolean;
  confirm?: boolean;
  snapshotLabel?: string;
}

export interface ChatLocator {
  avatar: string;
  fileName: string;
}

export interface ChatMetadataPatchRequest extends ChatLocator {
  updates?: Record<string, unknown>;
  unset?: string[];
  confirm?: boolean;
  snapshotLabel?: string;
  force?: boolean;
}

export interface ChatMessageChangeRequest extends ChatLocator {
  index?: number;
  message?: Record<string, unknown>;
  fields?: Record<string, unknown>;
  confirm?: boolean;
  snapshotLabel?: string;
  force?: boolean;
}

export interface ChatAuthorsNoteRequest extends ChatLocator {
  enabled?: boolean;
  text?: string;
  position?: string | number;
  depth?: number;
  role?: string | number;
  interval?: number;
  confirm?: boolean;
  snapshotLabel?: string;
  force?: boolean;
}

export interface ChatScriptInjectRequest extends ChatLocator {
  id: string;
  value?: string;
  position?: string | number;
  depth?: number;
  role?: string | number;
  scan?: boolean;
  filter?: string | null;
  delete?: boolean;
  confirm?: boolean;
  snapshotLabel?: string;
  force?: boolean;
}

export interface CharacterConfigureRequest {
  avatar: string;
  fields: Record<string, unknown>;
  confirm?: boolean;
  snapshotLabel?: string;
}

export interface WorldbookEntryConfigureRequest {
  book: string;
  action?: "upsert" | "set_enabled" | "delete";
  uid?: number;
  comment?: string;
  fields?: Record<string, unknown>;
  enabled?: boolean;
  confirm?: boolean;
  snapshotLabel?: string;
}

export interface WorldbookManageRequest {
  name: string;
  overwrite?: boolean;
  confirm?: boolean;
  snapshotLabel?: string;
}

export interface ChatWorldbookBindRequest extends ChatLocator {
  book?: string;
  unset?: boolean;
  confirm?: boolean;
  snapshotLabel?: string;
  force?: boolean;
}

export interface MvuSettingsConfigureRequest {
  enabled?: boolean;
  updateMode?: string;
  modelSource?: string;
  modelName?: string;
  apiUrl?: string;
  apiKey?: string;
  maxChatHistory?: number;
  maxReplyTokens?: number;
  temperature?: number;
  updates?: Record<string, unknown>;
  confirm?: boolean;
  snapshotLabel?: string;
}

export interface MvuEntrySetEnabledRequest {
  book: string;
  uid?: number;
  comment?: string;
  enabled: boolean;
  confirm?: boolean;
  snapshotLabel?: string;
}

export interface MvuChatStatePatchRequest extends ChatLocator {
  index?: number;
  updates?: Record<string, unknown>;
  unset?: string[];
  confirm?: boolean;
  snapshotLabel?: string;
  force?: boolean;
}

export class StControlPlane {
  readonly snapshots: SnapshotManager;

  constructor(
    private readonly config: StMcpConfig,
    private readonly http: StHttpClient,
  ) {
    this.snapshots = new SnapshotManager(config);
  }

  async doctor(): Promise<Record<string, unknown>> {
    const checks: Record<string, unknown> = {
      baseUrl: this.config.baseUrl,
      mcpRoot: this.config.mcpRoot,
      stRoot: this.config.stRoot,
      configPath: this.config.configPath,
      projectRoot: this.config.projectRoot,
      snapshotRoot: this.config.snapshotRoot,
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

  async readResource(uri: string): Promise<unknown> {
    const parsed = parseStUri(uri);
    const segments = parsed.segments;

    if (uri === "st://status") return this.doctor();
    if (uri === "st://config") return this.readTextFile(this.config.configPath);
    if (uri === "st://config/current") return this.readYamlFile(this.config.configPath);
    if (uri === "st://config/default") return this.readYamlFile(path.join(this.config.stRoot, "default", "config.yaml"));
    if (uri === "st://config/schema") return this.readIndexSection("serverConfig");
    if (uri === "st://characters") return this.http.post("/api/characters/all", {});
    if (segments[0] === "characters" && segments[1] && !segments[2]) {
      return this.http.post("/api/characters/get", { avatar_url: decodeURIComponent(segments[1]) });
    }
    if (segments[0] === "characters" && segments[1] && segments[2] === "raw") {
      return this.http.post("/api/characters/get", { avatar_url: decodeURIComponent(segments[1]) });
    }
    if (uri === "st://chats/recent") return this.http.post("/api/chats/recent", {});
    if (uri === "st://chats/recent/metadata") return this.http.post("/api/chats/recent", { metadata: true });
    if (uri === "st://worldbooks") return this.http.post("/api/worldinfo/list", {});
    if (segments[0] === "worldbooks" && segments[1]) {
      return this.http.post("/api/worldinfo/get", { name: decodeURIComponent(segments[1]) });
    }
    if (uri === "st://extensions") return this.listExtensions();
    if (uri === "st://plugins") return this.listServerPlugins();
    if (uri === "st://regex") return this.regexRegistry();
    if (uri === "st://quick-replies") return this.quickReplyRegistry();
    if (uri === "st://variables") return this.variablesRegistry();
    if (uri === "st://snapshots") return this.snapshots.list();
    if (uri === "st://index") return this.readJsonFile(path.join(this.config.mcpRoot, "docs", "upstream-st-index.json"));
    if (uri === "st://index/markdown") return this.readTextFile(path.join(this.config.mcpRoot, "docs", "upstream-st-index.md"));
    if (uri === "st://routes") return this.readIndexSection("serverRoutes");
    if (uri === "st://prompt-pipeline") return this.readIndexSection("runtimeSurfaces");
    if (uri === "st://prompt/inspect") return this.inspectPrompt();
    if (uri === "st://extension-registry") return this.extensionRegistry();
    if (uri === "st://plugin-registry") return this.pluginRegistry();
    if (uri === "st://data-layout") return this.readIndexSection("dataLayout");
    if (uri === "st://logs/server") return this.readBestEffortLog();
    if (uri === "st://source/package") return this.readJsonFile(path.join(this.config.stRoot, "package.json"));

    throw new StMcpError(`unsupported ST resource URI: ${uri}`);
  }

  async planChange(goal: string, targetUri: string, changes: unknown): Promise<Record<string, unknown>> {
    const resource = await this.readResource(targetUri).catch((error) => ({ unavailable: String(error) }));
    return {
      goal,
      targetUri,
      changes,
      currentResource: resource,
      requiredFlow: ["snapshot", "apply", "verify"],
      writeRequiresConfirm: true,
      supportedApply: this.supportsPatch(targetUri),
    };
  }

  async configLocations(): Promise<unknown> {
    const userDataRoot = await this.resolveUserDataRoot().catch(() => null);
    return {
      schema: "st-config-locations/v1",
      purpose: "Map high-level Tavern control domains to their real storage locations and semantic tools.",
      roots: {
        projectRoot: this.config.projectRoot,
        stRoot: this.config.stRoot,
        userDataRoot,
        snapshotRoot: this.config.snapshotRoot,
      },
      domains: [
        {
          domain: "server_config",
          storage: "config.yaml",
          location: this.config.configPath,
          readTools: ["st.config.get"],
          writeTools: ["st.config.patch"],
          restartRequired: true,
        },
        {
          domain: "characters",
          storage: "user data characters directory plus /api/characters/*",
          location: userDataRoot ? path.join(userDataRoot, "characters") : null,
          readTools: ["st.character.list", "st.character.inspect"],
          writeTools: ["st.character.configure"],
        },
        {
          domain: "worldbooks",
          storage: "user data worlds/*.json entries",
          location: userDataRoot ? path.join(userDataRoot, "worlds") : null,
          readTools: ["st.worldbook.list", "st.worldbook.inspect", "st.worldbook.entries"],
          writeTools: ["st.worldbook.entry.configure", "st.worldbook.create_empty", "st.worldbook.delete"],
        },
        {
          domain: "chat_metadata",
          storage: "first record in chats/{avatar}/{file}.jsonl: chat_metadata",
          location: userDataRoot ? path.join(userDataRoot, "chats") : null,
          readTools: ["st.chat.inspect", "st.chat.metadata.get"],
          writeTools: ["st.chat.metadata.patch", "st.chat.worldbook.bind", "st.chat.authors_note.set", "st.chat.variables.set"],
        },
        {
          domain: "mvu_global_settings",
          storage: "settings.extension_settings.mvu_settings",
          location: "runtime /api/settings/get + /api/settings/save",
          readTools: ["st.mvu.settings.get"],
          writeTools: ["st.mvu.settings.configure"],
          reloadRequired: true,
        },
        {
          domain: "mvu_worldbook_entries",
          storage: "worldbook entries with [InitVar], [mvu_update], [mvu_plot], stat_data macros, or variable-rule markers",
          location: userDataRoot ? path.join(userDataRoot, "worlds") : null,
          readTools: ["st.mvu.entries"],
          writeTools: ["st.mvu.entry.set_enabled", "st.worldbook.entry.configure"],
        },
        {
          domain: "mvu_chat_state",
          storage: "chat message records: message.variables[].stat_data and initialized_lorebooks",
          location: userDataRoot ? path.join(userDataRoot, "chats") : null,
          readTools: ["st.mvu.chat_state.inspect"],
          writeTools: ["st.mvu.chat_state.patch"],
        },
      ],
    };
  }

  async getConfigValue(dottedPath?: string, includeDefault = true): Promise<unknown> {
    const current = await this.readYamlFile(this.config.configPath);
    const defaults = includeDefault
      ? await this.readYamlFile(path.join(this.config.stRoot, "default", "config.yaml")).catch(() => null)
      : null;
    const index = await this.readCodebaseIndex().catch(() => ({}));
    if (!dottedPath) {
      return {
        current,
        default: defaults,
        changedFromDefault: getPath(index, "serverConfig.changedFromDefault") ?? [],
      };
    }
    return {
      path: dottedPath,
      current: getPath(current, dottedPath),
      default: includeDefault ? getPath(defaults, dottedPath) : undefined,
      existsInDefault: includeDefault ? hasPath(defaults, dottedPath) : undefined,
      usages: this.configUsagesForPath(index, dottedPath),
      restartRequired: true,
    };
  }

  async patchConfig(request: {
    updates?: Record<string, unknown>;
    unset?: string[];
    allowUnknown?: boolean;
    confirm?: boolean;
    snapshotLabel?: string;
  }): Promise<unknown> {
    if (!request.confirm) throw new ConfirmationRequiredError("config patch");
    const updates = request.updates || {};
    const unset = request.unset || [];
    if (Object.keys(updates).length === 0 && unset.length === 0) {
      throw new StMcpError("config patch must include updates or unset paths");
    }

    const configPath = this.config.configPath;
    const defaults = await this.readYamlFile(path.join(this.config.stRoot, "default", "config.yaml")).catch(() => null);
    if (!request.allowUnknown) {
      for (const dottedPath of [...Object.keys(updates), ...unset]) {
        if (!hasPath(defaults, dottedPath)) {
          throw new StMcpError(`unknown config path: ${dottedPath}; pass allowUnknown: true to override`);
        }
      }
    }

    const configText = await fs.readFile(configPath, "utf8");
    const document = YAML.parseDocument(configText);
    const current = document.toJSON();
    if (!isRecord(current)) throw new StMcpError(`YAML file did not parse to an object: ${configPath}`);
    const before = selectPaths(current, [...Object.keys(updates), ...unset]);
    for (const [dottedPath, value] of Object.entries(updates)) {
      document.setIn(splitPath(dottedPath), value);
    }
    for (const dottedPath of unset) {
      document.deleteIn(splitPath(dottedPath));
    }
    const afterDocument = document.toJSON();
    if (!isRecord(afterDocument)) throw new StMcpError(`patched config did not remain an object: ${configPath}`);

    const snapshot = await this.snapshots.create(request.snapshotLabel || "config-patch", [configPath]);
    await fs.writeFile(configPath, String(document), "utf8");

    return {
      ok: true,
      snapshotId: snapshot.id,
      path: configPath,
      before,
      after: selectPaths(afterDocument, [...Object.keys(updates), ...unset]),
      restartRequired: true,
    };
  }

  async getSettingsValue(dottedPath?: string, includeDefault = true): Promise<unknown> {
    const current = await this.settings();
    const defaults = includeDefault
      ? await this.readJsonFile(path.join(this.config.stRoot, "default", "content", "settings.json")).catch(() => null)
      : null;
    if (!dottedPath) {
      return {
        current,
        default: defaults,
        largeSections: getPath(await this.readCodebaseIndex().catch(() => ({})), "defaultUserSettings.knownLargeSections") ?? [],
      };
    }
    return {
      path: dottedPath,
      current: getPath(current, dottedPath),
      default: includeDefault ? getPath(defaults, dottedPath) : undefined,
      existsInDefault: includeDefault ? hasPath(defaults, dottedPath) : undefined,
      saveEndpoint: "/api/settings/save",
      reloadRequired: true,
    };
  }

  async patchSettings(request: {
    updates?: Record<string, unknown>;
    unset?: string[];
    allowUnknown?: boolean;
    confirm?: boolean;
    snapshotLabel?: string;
  }): Promise<unknown> {
    if (!request.confirm) throw new ConfirmationRequiredError("settings patch");
    const updates = request.updates || {};
    const unset = request.unset || [];
    if (Object.keys(updates).length === 0 && unset.length === 0) {
      throw new StMcpError("settings patch must include updates or unset paths");
    }

    const defaults = await this.readJsonFile(path.join(this.config.stRoot, "default", "content", "settings.json")).catch(() => null);
    if (!request.allowUnknown) {
      for (const dottedPath of [...Object.keys(updates), ...unset]) {
        if (!hasPath(defaults, dottedPath)) {
          throw new StMcpError(`unknown settings path: ${dottedPath}; pass allowUnknown: true to override`);
        }
      }
    }

    const settings = await this.settings();
    const before = selectPaths(settings, [...Object.keys(updates), ...unset]);
    for (const [dottedPath, value] of Object.entries(updates)) {
      setPath(settings, dottedPath, value);
    }
    for (const dottedPath of unset) {
      deletePath(settings, dottedPath);
    }

    const snapshot = await this.snapshots.create(request.snapshotLabel || "settings-patch", [path.join(await this.resolveUserDataRoot(), "settings.json")]);
    await this.http.post("/api/settings/save", settings);

    return {
      ok: true,
      snapshotId: snapshot.id,
      before,
      after: selectPaths(settings, [...Object.keys(updates), ...unset]),
      reloadRequired: true,
    };
  }

  async explainSetting(domain: ConfigDomain, dottedPath: string): Promise<unknown> {
    if (domain === "config") {
      const value = await this.getConfigValue(dottedPath, true);
      const index = await this.readCodebaseIndex().catch(() => ({}));
      return {
        domain,
        ...asRecord(value),
        keyFamily: dottedPath.split(".")[0],
        affectedFiles: this.configUsagesForPath(index, dottedPath).map((usage) => usage.file),
        writeTool: "st.config.patch",
        restartRequired: true,
      };
    }

    const value = await this.getSettingsValue(dottedPath, true);
    return {
      domain,
      ...asRecord(value),
      keyFamily: dottedPath.split(".")[0],
      writeTool: "no public generic settings patch; use semantic core tools",
      reloadRequired: true,
    };
  }

  async patchResource(request: PatchRequest): Promise<unknown> {
    if (!request.confirm) throw new ConfirmationRequiredError(`patch ${request.uri}`);
    if (!this.supportsPatch(request.uri)) throw new StMcpError(`patch is not supported for ${request.uri}`);

    const parsed = parseStUri(request.uri);
    const folder = parsed.segments[0] === "characters" ? "characters" : "worlds";
    const leaf = decodeURIComponent(parsed.segments[1] || "");
    if (!leaf || path.basename(leaf) !== leaf) throw new StMcpError("Invalid resource name");
    const snapshot = await this.snapshots.create(request.snapshotLabel || `patch-${request.uri}`, [path.join(await this.resolveUserDataRoot(), folder, folder === "worlds" ? leaf + ".json" : leaf)]);
    const patch = request.patch;
    if (!isRecord(patch)) throw new StMcpError("patch must be a JSON object");

    if (parsed.segments[0] === "characters" && parsed.segments[1]) {
      const avatar = decodeURIComponent(parsed.segments[1]);
      const allowed = new Set([
        "name",
        "description",
        "personality",
        "scenario",
        "first_mes",
        "mes_example",
        "system_prompt",
        "post_history_instructions",
        "alternate_greetings",
      ]);
      const applied: string[] = [];
      for (const [field, value] of Object.entries(patch)) {
        if (!allowed.has(field)) throw new StMcpError(`unsupported character field: ${field}`);
        await this.patchCharacterField(avatar, field, value);
        applied.push(field);
      }
      return { ok: true, uri: request.uri, snapshotId: snapshot.id, applied };
    }

    if (parsed.segments[0] === "worldbooks" && parsed.segments[1]) {
      const name = decodeURIComponent(parsed.segments[1]);
      if (!isRecord(patch.data)) throw new StMcpError("worldbook patch must include data object");
      await this.http.post("/api/worldinfo/edit", { name, data: patch.data });
      return { ok: true, uri: request.uri, snapshotId: snapshot.id, name };
    }

    throw new StMcpError(`patch is not implemented for ${request.uri}`);
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

  async configureCharacter(request: CharacterConfigureRequest): Promise<unknown> {
    if (!request.confirm) throw new ConfirmationRequiredError("character configure");
    const fields = request.fields || {};
    if (Object.keys(fields).length === 0) throw new StMcpError("character configure must include fields");
    const allowed = new Set(characterCoreFields());
    for (const field of Object.keys(fields)) {
      if (!allowed.has(field)) throw new StMcpError(`unsupported character core field: ${field}`);
    }

    const before = await this.http.post("/api/characters/get", { avatar_url: request.avatar });
    if (!isRecord(before)) throw new StMcpError(`character not found: ${request.avatar}`);
    const snapshot = await this.snapshots.create(request.snapshotLabel || "character-configure", [path.join(await this.resolveUserDataRoot(), "characters", request.avatar)]);
    const applied: string[] = [];
    for (const [field, value] of Object.entries(fields)) {
      await this.patchCharacterField(request.avatar, field, normalizeCharacterField(field, value));
      applied.push(field);
    }
    const after = await this.http.post("/api/characters/get", { avatar_url: request.avatar });
    return {
      ok: true,
      avatar: request.avatar,
      snapshotId: snapshot.id,
      applied,
      before: selectCharacterFields(before, applied),
      after: selectCharacterFields(after, applied),
      reloadRequired: true,
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
      configurationAvailable: false,
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
      createTool: "st.worldbook.create_empty",
      deleteTool: "st.worldbook.delete",
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
      entryTool: "st.worldbook.entry.configure",
    };
  }

  async createEmptyWorldbook(request: WorldbookManageRequest): Promise<unknown> {
    if (!request.confirm) throw new ConfirmationRequiredError("worldbook create");
    const name = request.name.trim();
    if (!name) throw new StMcpError("worldbook name is required");
    const existing = await this.http.post("/api/worldinfo/list", {});
    if (!Array.isArray(existing)) throw new StMcpError("worldbook list endpoint returned non-array response");
    const books = existing.filter(isRecord);
    const alreadyExists = books.some((book) => String(book.file_id || book.name) === name || equalsCaseFold(book.name, name));
    if (alreadyExists && !request.overwrite) {
      throw new StMcpError(`worldbook already exists: ${name}; pass overwrite: true to replace with an empty book`);
    }
    const snapshot = await this.snapshots.create(request.snapshotLabel || "worldbook-create-empty", [path.join(await this.resolveUserDataRoot(), "worlds", name + ".json")]);
    const data = { entries: {}, name };
    await this.http.post("/api/worldinfo/edit", { name, data });
    return {
      ok: true,
      name,
      overwritten: alreadyExists,
      snapshotId: snapshot.id,
      data,
      reloadRequired: true,
    };
  }

  async deleteWorldbook(request: WorldbookManageRequest): Promise<unknown> {
    if (!request.confirm) throw new ConfirmationRequiredError("worldbook delete");
    const name = request.name.trim();
    if (!name) throw new StMcpError("worldbook name is required");
    const before = await this.readWorldbook(name);
    const snapshot = await this.snapshots.create(request.snapshotLabel || "worldbook-delete", [path.join(await this.resolveUserDataRoot(), "worlds", name + ".json")]);
    await this.http.post("/api/worldinfo/delete", { name });
    return {
      ok: true,
      name,
      snapshotId: snapshot.id,
      deletedEntryCount: worldbookEntryRecords(before).length,
      reloadRequired: true,
    };
  }

  async configureWorldbookEntry(request: WorldbookEntryConfigureRequest): Promise<unknown> {
    if (!request.confirm) throw new ConfirmationRequiredError("worldbook entry configure");
    const action = request.action || "upsert";
    const book = request.book.trim();
    if (!book) throw new StMcpError("worldbook name is required");
    const data = await this.readWorldbook(book);
    const entries = ensureRecord(data, "entries");
    const uid = resolveWorldbookUid(entries, request, action !== "upsert");
    let affectedUid = uid;
    const before = uid === null ? null : structuredClone(asRecord(entries[String(uid)]));

    if (action === "delete") {
      if (uid === null) throw new StMcpError("worldbook entry uid or comment is required for delete");
      delete entries[String(uid)];
    } else if (action === "set_enabled") {
      if (uid === null) throw new StMcpError("worldbook entry uid or comment is required for set_enabled");
      const entry = asRecord(entries[String(uid)]);
      if (!isRecord(entry)) throw new StMcpError(`worldbook entry not found: ${uid}`);
      entry.disable = request.enabled === undefined ? !Boolean(entry.disable) : !request.enabled;
      entries[String(uid)] = entry;
    } else if (action === "upsert") {
      const nextUid = uid ?? nextWorldbookUid(entries);
      affectedUid = nextUid;
      const existing = isRecord(entries[String(nextUid)]) ? asRecord(entries[String(nextUid)]) : {};
      const entry = normalizeWorldbookEntry({
        ...existing,
        uid: nextUid,
        ...(request.comment !== undefined ? { comment: request.comment } : {}),
        ...(request.fields || {}),
      });
      if (request.enabled !== undefined) entry.disable = !request.enabled;
      entries[String(nextUid)] = entry;
    } else {
      throw new StMcpError(`unsupported worldbook entry action: ${action}`);
    }

    const snapshot = await this.snapshots.create(request.snapshotLabel || `worldbook-entry-${action}`, [path.join(await this.resolveUserDataRoot(), "worlds", book + ".json")]);
    await this.http.post("/api/worldinfo/edit", { name: book, data });
    return {
      ok: true,
      book,
      action,
      uid: affectedUid,
      snapshotId: snapshot.id,
      before,
      after: action === "delete" || affectedUid === null ? null : entries[String(affectedUid)] ?? null,
      reloadRequired: true,
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
      writeTool: "nora.mvu_model.configure",
    };
  }

  async configureMvuSettings(request: MvuSettingsConfigureRequest): Promise<unknown> {
    const updates: Record<string, unknown> = {};
    if (request.enabled !== undefined) {
      updates["extension_settings.mvu_settings.更新方式"] = request.updateMode || "额外模型解析";
      updates["extension_settings.mvu_settings.额外模型解析配置.启用自动请求"] = request.enabled;
    }
    if (request.updateMode !== undefined) updates["extension_settings.mvu_settings.更新方式"] = request.updateMode;
    if (request.modelSource !== undefined) updates["extension_settings.mvu_settings.额外模型解析配置.模型来源"] = request.modelSource;
    if (request.modelName !== undefined) updates["extension_settings.mvu_settings.额外模型解析配置.模型名称"] = request.modelName;
    if (request.apiUrl !== undefined) updates["extension_settings.mvu_settings.额外模型解析配置.api地址"] = request.apiUrl;
    if (request.apiKey !== undefined) updates["extension_settings.mvu_settings.额外模型解析配置.密钥"] = request.apiKey;
    if (request.maxChatHistory !== undefined) {
      updates["extension_settings.mvu_settings.额外模型解析配置.max_chat_history"] = normalizeNonNegativeInteger(
        request.maxChatHistory,
        "maxChatHistory",
      );
    }
    if (request.maxReplyTokens !== undefined) {
      updates["extension_settings.mvu_settings.额外模型解析配置.最大回复token数"] = normalizeNonNegativeInteger(
        request.maxReplyTokens,
        "maxReplyTokens",
      );
    }
    if (request.temperature !== undefined) updates["extension_settings.mvu_settings.额外模型解析配置.温度"] = request.temperature;
    applyRelativeUpdates(updates, "extension_settings.mvu_settings", request.updates);
    if (Object.keys(updates).length === 0) {
      throw new StMcpError("MVU settings configure must include enabled, model fields, updateMode, or updates");
    }
    const patch = await this.patchSettings({
      updates,
      allowUnknown: true,
      confirm: request.confirm,
      snapshotLabel: request.snapshotLabel || "mvu-settings-configure",
    });
    return {
      ok: true,
      updates,
      patch,
      settings: await this.getMvuSettings(),
      reloadRequired: true,
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
      configurationAvailable: false,
    };
  }

  async setMvuEntryEnabled(request: MvuEntrySetEnabledRequest): Promise<unknown> {
    const result = await this.configureWorldbookEntry({
      book: request.book,
      uid: request.uid,
      comment: request.comment,
      action: "set_enabled",
      enabled: request.enabled,
      confirm: request.confirm,
      snapshotLabel: request.snapshotLabel || "mvu-entry-set-enabled",
    });
    return {
      ok: true,
      operation: result,
      entries: await this.listMvuEntries({ book: request.book }),
    };
  }

  async installExtension(url: string, confirm: boolean, global = false, branch?: string): Promise<unknown> {
    if (!confirm) throw new ConfirmationRequiredError("extension install");
    const snapshot = await this.snapshots.create("extension-install");
    const response = await this.http.post("/api/extensions/install", { url, global, branch });
    return { ok: true, snapshotId: snapshot.id, response, reloadRequired: true };
  }

  async installServerPlugin(
    url: string,
    confirm: boolean,
    options: { name?: string; branch?: string; installDependencies?: boolean } = {},
  ): Promise<unknown> {
    if (!confirm) throw new ConfirmationRequiredError("server plugin install");
    const parsedUrl = new URL(url);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new StMcpError("server plugin URL must use http or https");
    }
    const pluginName = sanitizeName(options.name || path.basename(parsedUrl.pathname, ".git"));
    if (!pluginName) throw new StMcpError("could not determine plugin name");

    const pluginsRoot = path.join(this.config.stRoot, "plugins");
    const pluginRoot = path.join(pluginsRoot, pluginName);
    if (await exists(pluginRoot)) throw new StMcpError(`server plugin already exists: ${pluginRoot}`);

    const snapshot = await this.snapshots.create("server-plugin-install");
    await fs.mkdir(pluginsRoot, { recursive: true });
    const cloneArgs = ["clone", "--depth", "1"];
    if (options.branch) cloneArgs.push("--branch", options.branch);
    cloneArgs.push(parsedUrl.href, pluginRoot);
    await runCommand("git", cloneArgs, this.config.stRoot);

    const packagePath = path.join(pluginRoot, "package.json");
    const hasPackage = await exists(packagePath);
    let npmInstall: Record<string, unknown> | null = null;
    if (hasPackage && options.installDependencies !== false) {
      const result = await runCommand("npm", ["install"], pluginRoot);
      npmInstall = { stdout: result.stdout.slice(-2000), stderr: result.stderr.slice(-2000) };
    }

    return {
      ok: true,
      snapshotId: snapshot.id,
      name: pluginName,
      root: pluginRoot,
      hasPackage,
      npmInstall,
      restartRequired: true,
      configReminder: "SillyTavern config.yaml must have enableServerPlugins: true for server plugins to load.",
    };
  }

  async scaffoldServerPlugin(request: {
    id: string;
    name?: string;
    description?: string;
    confirm?: boolean;
  }): Promise<unknown> {
    if (!request.confirm) throw new ConfirmationRequiredError("server plugin scaffold");
    const id = sanitizePluginId(request.id);
    if (!id) throw new StMcpError("server plugin id must contain lowercase letters, numbers, hyphens, or underscores");
    const pluginRoot = path.join(this.config.stRoot, "plugins", id);
    if (await exists(pluginRoot)) throw new StMcpError(`server plugin already exists: ${pluginRoot}`);

    const snapshot = await this.snapshots.create("server-plugin-scaffold");
    await fs.mkdir(pluginRoot, { recursive: true });
    const displayName = request.name || id;
    const description = request.description || "Agent-created SillyTavern server plugin.";

    await fs.writeFile(path.join(pluginRoot, "package.json"), JSON.stringify({
      name: id,
      version: "0.1.0",
      private: true,
      type: "module",
      main: "index.mjs",
    }, null, 2) + "\n");
    await fs.writeFile(path.join(pluginRoot, "index.mjs"), serverPluginTemplate(id, displayName, description));
    await fs.writeFile(path.join(pluginRoot, "README.md"), `# ${displayName}\n\n${description}\n\nRoutes are mounted under \`/api/plugins/${id}\` when SillyTavern server plugins are enabled.\n`);

    return {
      ok: true,
      snapshotId: snapshot.id,
      id,
      root: pluginRoot,
      files: ["package.json", "index.mjs", "README.md"],
      restartRequired: true,
      configReminder: "Set enableServerPlugins: true in config.yaml and restart SillyTavern.",
    };
  }

  async readSourceFile(scope: FileScope, filePath: string, maxBytes = 200000): Promise<unknown> {
    const target = this.resolveScopedPath(scope, filePath);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new StMcpError(`not a file: ${target}`);
    const file = await fs.open(target, "r");
    try {
      const length = Math.min(Math.max(maxBytes, 1), stat.size);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, 0);
      return {
        path: target,
        size: stat.size,
        truncated: stat.size > length,
        text: buffer.toString("utf8"),
      };
    } finally {
      await file.close();
    }
  }

  async writeSourceFile(request: {
    scope: FileScope;
    path: string;
    content: string;
    confirm?: boolean;
    snapshotLabel?: string;
  }): Promise<unknown> {
    if (!request.confirm) throw new ConfirmationRequiredError("source write");
    const target = this.resolveScopedPath(request.scope, request.path);
    const snapshot = await this.snapshots.create(request.snapshotLabel || "source-write", [target]);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, request.content, "utf8");
    return { ok: true, snapshotId: snapshot.id, path: target, bytes: Buffer.byteLength(request.content) };
  }

  async runDevCommand(request: {
    scope: FileScope;
    command: string;
    args?: string[];
    confirm?: boolean;
    timeoutMs?: number;
  }): Promise<unknown> {
    if (!request.confirm) throw new ConfirmationRequiredError("dev command");
    const cwd = this.resolveScopeRoot(request.scope);
    const command = path.basename(request.command);
    const allowed = new Set(["npm", "node", "npx", "git", "sh", "bash", "python3"]);
    if (!allowed.has(command)) throw new StMcpError(`unsupported dev command: ${command}`);
    const result = await runCommand(command, request.args || [], cwd, request.timeoutMs);
    return {
      ok: true,
      cwd,
      command,
      args: request.args || [],
      stdout: result.stdout.slice(-12000),
      stderr: result.stderr.slice(-12000),
    };
  }

  async controlRuntime(action: RuntimeAction, confirm?: boolean): Promise<unknown> {
    if (action !== "status" && !confirm) throw new ConfirmationRequiredError(`runtime ${action}`);
    const command = this.config.runtimeCommands[action];
    if (!command) {
      return {
        ok: false,
        action,
        configured: false,
        message: `Set ST_MCP_RUNTIME_${action.toUpperCase()}_CMD to enable runtime ${action}.`,
        doctor: action === "status" ? await this.doctor() : undefined,
      };
    }

    const snapshot = action === "start" || action === "restart"
      ? await this.snapshots.create(`runtime-${action}`)
      : null;
    const result = await runShellCommand(command, this.config.projectRoot, 10 * 60 * 1000);
    return {
      ok: true,
      action,
      configured: true,
      snapshotId: snapshot?.id,
      stdout: result.stdout.slice(-12000),
      stderr: result.stderr.slice(-12000),
    };
  }

  async installRuntimeBridge(confirm?: boolean): Promise<unknown> {
    if (!confirm) throw new ConfirmationRequiredError("runtime bridge install");
    const snapshot = await this.snapshots.create("runtime-bridge-install");
    const pluginRoot = path.join(this.config.stRoot, "plugins", BRIDGE_ID);
    const extensionRoot = path.join(
      this.config.stRoot,
      "public",
      "scripts",
      "extensions",
      "third-party",
      BRIDGE_ID,
    );

    await fs.mkdir(pluginRoot, { recursive: true });
    await fs.mkdir(extensionRoot, { recursive: true });

    await fs.writeFile(path.join(pluginRoot, "package.json"), bridgeServerPluginPackage(), "utf8");
    await fs.writeFile(path.join(pluginRoot, "index.mjs"), bridgeServerPluginIndex(), "utf8");
    await fs.writeFile(path.join(pluginRoot, "README.md"), bridgeServerPluginReadme(), "utf8");

    await fs.writeFile(path.join(extensionRoot, "manifest.json"), bridgeExtensionManifest(), "utf8");
    await fs.writeFile(path.join(extensionRoot, "index.js"), bridgeExtensionIndex(), "utf8");
    await fs.writeFile(path.join(extensionRoot, "README.md"), bridgeExtensionReadme(), "utf8");

    return {
      ok: true,
      snapshotId: snapshot.id,
      pluginRoot,
      extensionRoot,
      routes: [
        `/api/plugins/${BRIDGE_ID}/health`,
        `/api/plugins/${BRIDGE_ID}/snapshot`,
        `/api/plugins/${BRIDGE_ID}/history`,
      ],
      restartRequired: true,
      browserReloadRequired: true,
      configReminder: "SillyTavern config.yaml must have enableServerPlugins: true before the server plugin can load.",
    };
  }

  async runtimeBridgeHealth(): Promise<unknown> {
    return this.http.get(`/api/plugins/${BRIDGE_ID}/health`);
  }

  async readRuntimeBridgeSnapshot(history = false): Promise<unknown> {
    return this.http.get(`/api/plugins/${BRIDGE_ID}/${history ? "history" : "snapshot"}`);
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
      configurationAvailable: false,
      settingsRoot: "extension_settings",
    };
  }

  async configureExtension(request: {
    name?: string;
    configKey?: string;
    enabled?: boolean;
    updates?: Record<string, unknown>;
    unset?: string[];
    allowCreate?: boolean;
    confirm?: boolean;
    snapshotLabel?: string;
  }): Promise<unknown> {
    if (!request.confirm) throw new ConfirmationRequiredError("extension configure");
    const updates = request.updates || {};
    const unset = request.unset || [];
    const hasSettingsPatch = Object.keys(updates).length > 0 || unset.length > 0;
    if (request.enabled === undefined && !hasSettingsPatch) {
      throw new StMcpError("extension configure must include enabled, updates, or unset");
    }

    const settings = await this.settings();
    const extensionSettings = ensureRecord(settings, "extension_settings");
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (request.enabled !== undefined) {
      if (!request.name) throw new StMcpError("extension name is required when changing enabled state");
      before.enabled = !asStringArray(extensionSettings.disabledExtensions).includes(request.name);
      const disabled = new Set(asStringArray(extensionSettings.disabledExtensions));
      if (request.enabled) disabled.delete(request.name);
      else disabled.add(request.name);
      extensionSettings.disabledExtensions = [...disabled].sort();
      after.enabled = request.enabled;
    }

    let configKey: string | null = request.configKey || null;
    if (hasSettingsPatch) {
      configKey ||= this.resolveExtensionConfigKey(extensionSettings, request.name, Boolean(request.allowCreate));
      if (!configKey) {
        throw new StMcpError("could not infer extension configKey; pass configKey or allowCreate: true with name");
      }
      if (!isRecord(extensionSettings[configKey])) {
        if (!request.allowCreate) throw new StMcpError(`extension config does not exist: ${configKey}`);
        extensionSettings[configKey] = {};
      }
      const configObject = extensionSettings[configKey] as Record<string, unknown>;
      before.configKey = configKey;
      before.settings = selectPaths(configObject, [...Object.keys(updates), ...unset]);
      for (const [dottedPath, value] of Object.entries(updates)) {
        setPath(configObject, dottedPath, value);
      }
      for (const dottedPath of unset) {
        deletePath(configObject, dottedPath);
      }
      after.configKey = configKey;
      after.settings = selectPaths(configObject, [...Object.keys(updates), ...unset]);
    }

    const snapshot = await this.snapshots.create(request.snapshotLabel || "extension-configure", [path.join(await this.resolveUserDataRoot(), "settings.json")]);
    await this.http.post("/api/settings/save", settings);
    return {
      ok: true,
      snapshotId: snapshot.id,
      name: request.name,
      configKey,
      before,
      after,
      reloadRequired: true,
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
    };
  }

  async configurePlugin(request: {
    enableServerPlugins?: boolean;
    enableServerPluginsAutoUpdate?: boolean;
    confirm?: boolean;
    snapshotLabel?: string;
  }): Promise<unknown> {
    const updates: Record<string, unknown> = {};
    if (request.enableServerPlugins !== undefined) updates.enableServerPlugins = request.enableServerPlugins;
    if (request.enableServerPluginsAutoUpdate !== undefined) {
      updates.enableServerPluginsAutoUpdate = request.enableServerPluginsAutoUpdate;
    }
    if (Object.keys(updates).length === 0) throw new StMcpError("plugin configure must include a server plugin setting");
    const result = await this.patchConfig({
      updates,
      confirm: request.confirm,
      snapshotLabel: request.snapshotLabel || "plugin-configure",
    });
    return {
      ok: true,
      patch: result,
      registry: await this.pluginRegistry(),
      restartRequired: true,
    };
  }

  async inspectPrompt(options: { includeRuntime?: boolean } = {}): Promise<unknown> {
    const includeRuntime = options.includeRuntime !== false;
    const index = await this.readCodebaseIndex().catch(() => ({}));
    const settings = await this.settings().catch(() => ({}));
    const runtime = includeRuntime
      ? await this.readRuntimeBridgeSnapshot(false).catch((error) => ({ unavailable: String(error) }))
      : undefined;
    const runtimeSnapshot = isRecord(runtime) && isRecord(runtime.snapshot) ? runtime.snapshot : null;
    return {
      schema: "st-prompt-inspect/v1",
      generatedAt: new Date().toISOString(),
      source: {
        index: "st://prompt-pipeline",
        runtimeBridge: includeRuntime ? "st.bridge.read" : null,
      },
      pipeline: getPath(index, "runtimeSurfaces.promptPipeline") ?? [],
      seams: promptSeamsFromIndex(index),
      liveSettings: {
        mainApi: getPath(settings, "main_api"),
        maxContext: getPath(settings, "max_context"),
        amountGen: getPath(settings, "amount_gen"),
        worldInfo: getPath(settings, "world_info_settings"),
        powerUserContext: getPath(settings, "power_user.context"),
        instruct: getPath(settings, "power_user.instruct"),
        systemPrompt: getPath(settings, "power_user.sysprompt"),
        persona: {
          description: getPath(settings, "power_user.persona_description"),
          position: getPath(settings, "power_user.persona_description_position"),
          depth: getPath(settings, "power_user.persona_description_depth"),
          role: getPath(settings, "power_user.persona_description_role"),
        },
        authorsNote: getPath(settings, "extension_settings.note"),
      },
      runtime: runtimeSnapshot ? {
        url: runtimeSnapshot.url,
        title: runtimeSnapshot.title,
        active: getPath(runtimeSnapshot, "state.active"),
        counts: getPath(runtimeSnapshot, "state.counts"),
        globals: getPath(runtimeSnapshot, "state.globals"),
        events: Array.isArray(runtimeSnapshot.events)
          ? runtimeSnapshot.events.map((event) => isRecord(event) ? event.name : null).filter(Boolean)
          : [],
      } : runtime,
      nextTools: [
        "st.prompt.set_injection",
        "st.chat.authors_note.set",
        "st.chat.script_inject.configure",
        "st.extension.configure",
        "st.bridge.read",
      ],
    };
  }

  async setPromptInjection(request: PromptInjectionRequest): Promise<unknown> {
    const updates: Record<string, unknown> = {};
    const target = request.target;
    const set = (dottedPath: string, value: unknown) => {
      updates[dottedPath] = value;
    };

    switch (target) {
      case "authors_note": {
        if (request.text !== undefined) set("extension_settings.note.default", request.text);
        if (request.enabled !== undefined) {
          set("extension_settings.note.defaultInterval", request.enabled ? request.interval ?? 1 : 0);
          if (!request.enabled && request.position === undefined) set("extension_settings.note.defaultPosition", extensionPromptTypes.none);
          if (request.enabled && request.position === undefined) set("extension_settings.note.defaultPosition", extensionPromptTypes.in_chat);
        }
        if (request.position !== undefined) {
          set("extension_settings.note.defaultPosition", normalizeExtensionPromptPosition(request.position));
        }
        if (request.depth !== undefined) set("extension_settings.note.defaultDepth", normalizeDepth(request.depth));
        if (request.role !== undefined) set("extension_settings.note.defaultRole", normalizeExtensionPromptRole(request.role));
        if (request.interval !== undefined) set("extension_settings.note.defaultInterval", normalizeNonNegativeInteger(request.interval, "interval"));
        if (request.scan !== undefined) set("extension_settings.note.allowWIScan", request.scan);
        applyRelativeUpdates(updates, "extension_settings.note", request.updates);
        break;
      }
      case "persona": {
        if (request.text !== undefined) set("power_user.persona_description", request.text);
        if (request.enabled !== undefined) {
          set(
            "power_user.persona_description_position",
            request.enabled ? personaDescriptionPositions.in_prompt : personaDescriptionPositions.none,
          );
        }
        if (request.position !== undefined) {
          set("power_user.persona_description_position", normalizePersonaPosition(request.position));
        }
        if (request.depth !== undefined) set("power_user.persona_description_depth", normalizeDepth(request.depth));
        if (request.role !== undefined) set("power_user.persona_description_role", normalizeExtensionPromptRole(request.role));
        applyRelativeUpdates(updates, "power_user", request.updates);
        break;
      }
      case "world_info": {
        if (request.depth !== undefined) set("world_info_settings.world_info_depth", normalizeDepth(request.depth));
        if (request.budget !== undefined) {
          set("world_info_settings.world_info_budget", normalizeNonNegativeInteger(request.budget, "budget"));
        }
        if (request.budgetCap !== undefined) {
          set("world_info_settings.world_info_budget_cap", normalizeNonNegativeInteger(request.budgetCap, "budgetCap"));
        }
        if (request.recursive !== undefined) set("world_info_settings.world_info_recursive", request.recursive);
        if (request.includeNames !== undefined) set("world_info_settings.world_info_include_names", request.includeNames);
        if (request.overflowAlert !== undefined) set("world_info_settings.world_info_overflow_alert", request.overflowAlert);
        if (request.caseSensitive !== undefined) set("world_info_settings.world_info_case_sensitive", request.caseSensitive);
        if (request.matchWholeWords !== undefined) {
          set("world_info_settings.world_info_match_whole_words", request.matchWholeWords);
        }
        if (request.characterStrategy !== undefined) {
          set(
            "world_info_settings.world_info_character_strategy",
            normalizeNonNegativeInteger(request.characterStrategy, "characterStrategy"),
          );
        }
        applyRelativeUpdates(updates, "world_info_settings", request.updates);
        break;
      }
      case "system_prompt": {
        if (request.enabled !== undefined) set("power_user.sysprompt.enabled", request.enabled);
        if (request.text !== undefined) set("power_user.sysprompt.content", request.text);
        if (request.name !== undefined) set("power_user.sysprompt.name", request.name);
        if (request.postHistory !== undefined) set("power_user.sysprompt.post_history", request.postHistory);
        applyRelativeUpdates(updates, "power_user.sysprompt", request.updates);
        break;
      }
      case "instruct": {
        if (request.enabled !== undefined) set("power_user.instruct.enabled", request.enabled);
        if (request.preset !== undefined) set("power_user.instruct.preset", request.preset);
        applyRelativeUpdates(updates, "power_user.instruct", request.updates);
        break;
      }
      case "context": {
        if (request.text !== undefined) set("power_user.context.story_string", request.text);
        if (request.enabled !== undefined && request.position === undefined) {
          set("power_user.context.story_string_position", request.enabled ? extensionPromptTypes.in_prompt : extensionPromptTypes.none);
        }
        if (request.position !== undefined) {
          set("power_user.context.story_string_position", normalizeExtensionPromptPosition(request.position));
        }
        if (request.depth !== undefined) set("power_user.context.story_string_depth", normalizeDepth(request.depth));
        if (request.role !== undefined) set("power_user.context.story_string_role", normalizeExtensionPromptRole(request.role));
        applyRelativeUpdates(updates, "power_user.context", request.updates);
        break;
      }
      default:
        throw new StMcpError(`unsupported prompt injection target: ${target satisfies never}`);
    }

    if (Object.keys(updates).length === 0) {
      throw new StMcpError("prompt injection change must include enabled, text, position, depth, role, budget, preset, or updates");
    }

    const patch = await this.patchSettings({
      updates,
      allowUnknown: true,
      confirm: request.confirm,
      snapshotLabel: request.snapshotLabel || `prompt-injection-${target}`,
    });
    return {
      ok: true,
      target,
      updates,
      patch,
      prompt: await this.inspectPrompt({ includeRuntime: false }),
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
      placements: regexPlacements,
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
      configurationAvailable: false,
    };
  }

  async configureRegex(request: RegexConfigureRequest): Promise<unknown> {
    if (!request.confirm) throw new ConfirmationRequiredError("regex configure");
    const action = request.action || "upsert";
    const name = request.name.trim();
    if (!name) throw new StMcpError("regex name is required");

    const settings = await this.settings();
    const extensionSettings = ensureRecord(settings, "extension_settings");
    const scripts = Array.isArray(extensionSettings.regex) ? [...extensionSettings.regex] : [];
    const existingIndex = scripts.findIndex((script) =>
      isRecord(script) && equalsCaseFold(script.scriptName, name)
    );
    const before = existingIndex >= 0 ? scripts[existingIndex] : null;

    if (action === "delete") {
      if (existingIndex < 0) throw new StMcpError(`regex script not found: ${name}`);
      scripts.splice(existingIndex, 1);
    } else if (action === "set_enabled") {
      if (existingIndex < 0) throw new StMcpError(`regex script not found: ${name}`);
      const script = { ...asRecord(scripts[existingIndex]) };
      script.disabled = request.enabled === undefined ? !Boolean(script.disabled) : !request.enabled;
      scripts[existingIndex] = script;
    } else if (action === "upsert") {
      const script = existingIndex >= 0 ? { ...asRecord(scripts[existingIndex]) } : {};
      script.id = typeof script.id === "string" ? script.id : randomUUID();
      script.scriptName = name;
      if (request.findRegex !== undefined) script.findRegex = request.findRegex;
      if (request.replaceString !== undefined) script.replaceString = request.replaceString;
      if (!script.findRegex) script.findRegex = "";
      if (!script.replaceString) script.replaceString = "";
      if (request.placements !== undefined) script.placement = request.placements.map(normalizeRegexPlacement);
      if (!Array.isArray(script.placement)) script.placement = [];
      if (request.trimStrings !== undefined) script.trimStrings = request.trimStrings;
      if (!Array.isArray(script.trimStrings)) script.trimStrings = [];
      if (request.substituteRegex !== undefined) script.substituteRegex = normalizeSubstituteRegex(request.substituteRegex);
      if (script.substituteRegex === undefined) script.substituteRegex = 0;
      if (request.enabled !== undefined) script.disabled = !request.enabled;
      else if (script.disabled === undefined) script.disabled = false;
      if (request.markdownOnly !== undefined) script.markdownOnly = request.markdownOnly;
      if (request.promptOnly !== undefined) script.promptOnly = request.promptOnly;
      if (request.runOnEdit !== undefined) script.runOnEdit = request.runOnEdit;
      if (request.minDepth !== undefined) script.minDepth = normalizeNullableDepth(request.minDepth, "minDepth");
      else if (script.minDepth === undefined) script.minDepth = null;
      if (request.maxDepth !== undefined) script.maxDepth = normalizeNullableDepth(request.maxDepth, "maxDepth");
      else if (script.maxDepth === undefined) script.maxDepth = null;
      if (existingIndex >= 0) scripts[existingIndex] = script;
      else scripts.push(script);
    } else {
      throw new StMcpError(`unsupported regex action: ${action}`);
    }

    extensionSettings.regex = scripts;
    const snapshot = await this.snapshots.create(request.snapshotLabel || `regex-${action}`, [path.join(await this.resolveUserDataRoot(), "settings.json")]);
    await this.http.post("/api/settings/save", settings);
    const afterIndex = scripts.findIndex((script) => isRecord(script) && equalsCaseFold(script.scriptName, name));
    return {
      ok: true,
      action,
      name,
      snapshotId: snapshot.id,
      before,
      after: afterIndex >= 0 ? scripts[afterIndex] : null,
      reloadRequired: true,
    };
  }

  async variablesRegistry(): Promise<unknown> {
    const settings: Record<string, unknown> = await this.settings().catch(() => ({}));
    const variables = getPath(settings, "extension_settings.variables.global");
    return {
      schema: "st-variables-registry/v1",
      scope: "global",
      settingsPath: "extension_settings.variables.global",
      variables: isRecord(variables) ? variables : {},
      writeTool: "st.variables.set",
    };
  }

  async setVariable(request: {
    name: string;
    value?: string;
    unset?: boolean;
    asJson?: boolean;
    confirm?: boolean;
    snapshotLabel?: string;
  }): Promise<unknown> {
    if (!request.confirm) throw new ConfirmationRequiredError("variables set");
    const name = request.name.trim();
    if (!name) throw new StMcpError("variable name is required");
    const value = request.unset ? undefined : request.asJson ? JSON.stringify(request.value === undefined ? null : JSON.parse(request.value)) : request.value ?? "";
    const result = await this.patchSettings({
      updates: request.unset ? undefined : { [`extension_settings.variables.global.${name}`]: value },
      unset: request.unset ? [`extension_settings.variables.global.${name}`] : undefined,
      allowUnknown: true,
      confirm: true,
      snapshotLabel: request.snapshotLabel || `variable-${request.unset ? "unset" : "set"}`,
    });
    return {
      ok: true,
      name,
      unset: Boolean(request.unset),
      patch: result,
      registry: await this.variablesRegistry(),
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
    };
  }

  async configureQuickReply(request: QuickReplyConfigureRequest): Promise<unknown> {
    if (!request.confirm) throw new ConfirmationRequiredError("quick reply configure");
    if (
      request.enabled === undefined &&
      request.activeSet === undefined &&
      request.setOptions === undefined &&
      request.reply === undefined &&
      request.deleteReplyLabel === undefined &&
      request.deleteSet !== true
    ) {
      throw new StMcpError("quick reply configure must include enabled, activeSet, setOptions, reply, deleteReplyLabel, or deleteSet");
    }

    const envelope = await this.settingsEnvelope();
    const settings = parseSettingsFromEnvelope(envelope);
    const extensionSettings = ensureRecord(settings, "extension_settings");
    const quickReplyV2 = normalizeQuickReplySettings(extensionSettings.quickReplyV2, extensionSettings.quickReply);
    const setName = (request.set || request.activeSet || "Default").trim();
    if (!setName) throw new StMcpError("quick reply set name is required");
    const presets = Array.isArray(envelope.quickReplyPresets) ? envelope.quickReplyPresets.filter(isRecord) : [];
    const existingSet = presets.find((preset) => String(preset.name) === setName);
    const beforeSet = existingSet ? structuredClone(existingSet) : null;
    const nextSet = existingSet ? structuredClone(existingSet) as Record<string, unknown> : defaultQuickReplySet(setName);
    let saveSet = !existingSet;
    let deleteSet = false;
    let saveSettings = false;

    if (request.enabled !== undefined) {
      quickReplyV2.isEnabled = request.enabled;
      saveSettings = true;
    }
    if (request.activeSet !== undefined) {
      const config = ensureRecord(quickReplyV2, "config");
      const setList = Array.isArray(config.setList) ? config.setList.filter(isRecord) : [];
      if (!setList.some((item) => String(item.set) === request.activeSet)) {
        setList.push({ set: request.activeSet, isVisible: true });
      }
      config.setList = setList;
      saveSettings = true;
    }
    if (request.setOptions) {
      for (const [key, value] of Object.entries(request.setOptions)) {
        if (!["disableSend", "placeBeforeInput", "injectInput", "color", "onlyBorderColor"].includes(key)) {
          throw new StMcpError(`unsupported quick reply set option: ${key}`);
        }
        nextSet[key] = value;
      }
      saveSet = true;
    }
    if (request.reply) {
      const qrList = Array.isArray(nextSet.qrList) ? nextSet.qrList.filter(isRecord) : [];
      const label = String(request.reply.label || "").trim();
      const index = qrList.findIndex((item) => equalsCaseFold(item.label, label));
      const reply = normalizeQuickReply(request.reply, nextSet, index >= 0 ? qrList[index] : undefined);
      if (index >= 0) qrList[index] = { ...qrList[index], ...reply };
      else qrList.push(reply);
      nextSet.qrList = qrList;
      nextSet.idIndex = Math.max(Number(nextSet.idIndex || 0), Number(reply.id || 0));
      saveSet = true;
    }
    if (request.deleteReplyLabel !== undefined) {
      const label = request.deleteReplyLabel.trim();
      const qrList = Array.isArray(nextSet.qrList) ? nextSet.qrList.filter(isRecord) : [];
      const filtered = qrList.filter((item) => !equalsCaseFold(item.label, label));
      if (filtered.length === qrList.length) throw new StMcpError(`quick reply not found: ${label}`);
      nextSet.qrList = filtered;
      saveSet = true;
    }
    if (request.deleteSet) {
      deleteSet = true;
      saveSet = false;
    }

    extensionSettings.quickReplyV2 = quickReplyV2;
    const snapshot = await this.snapshots.create(request.snapshotLabel || "quick-reply-configure", [path.join(await this.resolveUserDataRoot(), "settings.json"), path.join(await this.resolveUserDataRoot(), "QuickReplies", setName + ".json")]);
    if (saveSettings) await this.http.post("/api/settings/save", settings);
    if (deleteSet) await this.http.post("/api/quick-replies/delete", { name: setName });
    if (saveSet) await this.http.post("/api/quick-replies/save", nextSet);

    return {
      ok: true,
      snapshotId: snapshot.id,
      set: setName,
      settingsSaved: saveSettings,
      setSaved: saveSet,
      setDeleted: deleteSet,
      beforeSet,
      afterSet: deleteSet ? null : nextSet,
      reloadRequired: true,
    };
  }

  async getChatMetadata(locator: ChatLocator): Promise<unknown> {
    const { chat, metadata } = await this.readChatWithMetadata(locator);
    return {
      schema: "st-chat-metadata/v1",
      avatar: locator.avatar,
      fileName: normalizeChatFileName(locator.fileName),
      messageCount: Math.max(chat.length - 1, 0),
      metadata,
      semanticTools: [
        "st.chat.metadata.patch",
        "st.chat.authors_note.set",
        "st.chat.variables.set",
        "st.chat.script_inject.configure",
      ],
    };
  }

  async inspectChat(locator: ChatLocator): Promise<unknown> {
    const { chat, metadata } = await this.readChatWithMetadata(locator);
    return {
      schema: "st-chat/v1",
      avatar: locator.avatar,
      fileName: normalizeChatFileName(locator.fileName),
      header: chat[0],
      metadata,
      messageCount: Math.max(chat.length - 1, 0),
      messages: chat.slice(1).map((message, index) => ({
        index,
        ...message,
      })),
      writeTools: [
        "st.chat.message.append",
        "st.chat.message.edit",
        "st.chat.message.delete",
        "st.chat.worldbook.bind",
      ],
    };
  }

  async patchChatMetadata(request: ChatMetadataPatchRequest): Promise<unknown> {
    if (!request.confirm) throw new ConfirmationRequiredError("chat metadata patch");
    const updates = request.updates || {};
    const unset = request.unset || [];
    if (Object.keys(updates).length === 0 && unset.length === 0) {
      throw new StMcpError("chat metadata patch must include updates or unset paths");
    }

    const { chat, metadata } = await this.readChatWithMetadata(request);
    const changedPaths = [...Object.keys(updates), ...unset];
    const before = selectPaths(metadata, changedPaths);
    for (const [dottedPath, value] of Object.entries(updates)) setPath(metadata, dottedPath, value);
    for (const dottedPath of unset) deletePath(metadata, dottedPath);
    const snapshotId = await this.writeChatMetadata(request, chat, metadata, request.snapshotLabel || "chat-metadata-patch");

    return {
      ok: true,
      snapshotId,
      avatar: request.avatar,
      fileName: normalizeChatFileName(request.fileName),
      before,
      after: selectPaths(metadata, changedPaths),
      reloadRequired: true,
    };
  }

  async setChatAuthorsNote(request: ChatAuthorsNoteRequest): Promise<unknown> {
    const updates: Record<string, unknown> = {};
    if (request.text !== undefined) updates.note_prompt = request.text;
    if (request.enabled !== undefined) {
      updates.note_interval = request.enabled ? request.interval ?? 1 : 0;
      if (!request.enabled && request.position === undefined) updates.note_position = extensionPromptTypes.none;
      if (request.enabled && request.position === undefined) updates.note_position = extensionPromptTypes.in_chat;
    }
    if (request.position !== undefined) updates.note_position = normalizeExtensionPromptPosition(request.position);
    if (request.depth !== undefined) updates.note_depth = normalizeDepth(request.depth);
    if (request.role !== undefined) updates.note_role = normalizeExtensionPromptRole(request.role);
    if (request.interval !== undefined) updates.note_interval = normalizeNonNegativeInteger(request.interval, "interval");
    if (Object.keys(updates).length === 0) {
      throw new StMcpError("chat authors note change must include enabled, text, position, depth, role, or interval");
    }
    return this.patchChatMetadata({
      avatar: request.avatar,
      fileName: request.fileName,
      updates,
      confirm: request.confirm,
      snapshotLabel: request.snapshotLabel || "chat-authors-note",
      force: request.force,
    });
  }

  async setChatVariable(request: ChatLocator & {
    name: string;
    value?: string;
    unset?: boolean;
    asJson?: boolean;
    confirm?: boolean;
    snapshotLabel?: string;
    force?: boolean;
  }): Promise<unknown> {
    const name = request.name.trim();
    if (!name) throw new StMcpError("local variable name is required");
    const value = request.unset
      ? undefined
      : request.asJson
        ? JSON.stringify(request.value === undefined ? null : JSON.parse(request.value))
        : request.value ?? "";
    return this.patchChatMetadata({
      avatar: request.avatar,
      fileName: request.fileName,
      updates: request.unset ? undefined : { [`variables.${name}`]: value },
      unset: request.unset ? [`variables.${name}`] : undefined,
      confirm: request.confirm,
      snapshotLabel: request.snapshotLabel || `chat-variable-${request.unset ? "unset" : "set"}`,
      force: request.force,
    });
  }

  async configureChatScriptInject(request: ChatScriptInjectRequest): Promise<unknown> {
    const id = request.id.trim();
    if (!id) throw new StMcpError("script inject id is required");
    if (request.delete) {
      return this.patchChatMetadata({
        avatar: request.avatar,
        fileName: request.fileName,
        unset: [`script_injects.${id}`],
        confirm: request.confirm,
        snapshotLabel: request.snapshotLabel || "chat-script-inject-delete",
        force: request.force,
      });
    }

    if (request.value === undefined) throw new StMcpError("script inject value is required unless delete is true");
    const inject = {
      value: request.value,
      position: normalizeExtensionPromptPosition(request.position ?? "after"),
      depth: normalizeDepth(request.depth ?? 4),
      scan: Boolean(request.scan),
      role: normalizeExtensionPromptRole(request.role ?? "system"),
      filter: request.filter ?? null,
    };
    return this.patchChatMetadata({
      avatar: request.avatar,
      fileName: request.fileName,
      updates: { [`script_injects.${id}`]: inject },
      confirm: request.confirm,
      snapshotLabel: request.snapshotLabel || "chat-script-inject",
      force: request.force,
    });
  }

  async bindChatWorldbook(request: ChatWorldbookBindRequest): Promise<unknown> {
    const updates: Record<string, unknown> | undefined = request.unset ? undefined : { world_info: request.book };
    if (!request.unset) {
      const book = String(request.book || "").trim();
      if (!book) throw new StMcpError("worldbook name is required unless unset is true");
      await this.readWorldbook(book);
      updates!.world_info = book;
    }
    return this.patchChatMetadata({
      avatar: request.avatar,
      fileName: request.fileName,
      updates,
      unset: request.unset ? ["world_info"] : undefined,
      confirm: request.confirm,
      snapshotLabel: request.snapshotLabel || "chat-worldbook-bind",
      force: request.force,
    });
  }

  async appendChatMessage(request: ChatMessageChangeRequest): Promise<unknown> {
    if (!request.confirm) throw new ConfirmationRequiredError("chat message append");
    if (!request.message) throw new StMcpError("message object is required");
    const { chat } = await this.readChatWithMetadata(request);
    const beforeCount = Math.max(chat.length - 1, 0);
    const message = normalizeChatMessage(request.message);
    chat.push(message);
    const snapshotId = await this.writeChat(request, chat, request.snapshotLabel || "chat-message-append");
    return {
      ok: true,
      snapshotId,
      avatar: request.avatar,
      fileName: normalizeChatFileName(request.fileName),
      index: beforeCount,
      beforeCount,
      afterCount: beforeCount + 1,
      message,
      reloadRequired: true,
    };
  }

  async editChatMessage(request: ChatMessageChangeRequest): Promise<unknown> {
    if (!request.confirm) throw new ConfirmationRequiredError("chat message edit");
    if (request.index === undefined) throw new StMcpError("message index is required");
    if (!request.fields && !request.message) throw new StMcpError("message edit must include fields or message");
    const { chat } = await this.readChatWithMetadata(request);
    const actualIndex = normalizeChatMessageIndex(request.index, chat.length);
    const before = structuredClone(chat[actualIndex]);
    const next = request.message
      ? normalizeChatMessage(request.message, chat[actualIndex])
      : normalizeChatMessagePatch(chat[actualIndex], request.fields || {});
    chat[actualIndex] = next;
    const snapshotId = await this.writeChat(request, chat, request.snapshotLabel || "chat-message-edit");
    return {
      ok: true,
      snapshotId,
      avatar: request.avatar,
      fileName: normalizeChatFileName(request.fileName),
      index: request.index,
      before,
      after: next,
      reloadRequired: true,
    };
  }

  async deleteChatMessage(request: ChatMessageChangeRequest): Promise<unknown> {
    if (!request.confirm) throw new ConfirmationRequiredError("chat message delete");
    if (request.index === undefined) throw new StMcpError("message index is required");
    const { chat } = await this.readChatWithMetadata(request);
    const actualIndex = normalizeChatMessageIndex(request.index, chat.length);
    const [deleted] = chat.splice(actualIndex, 1);
    const snapshotId = await this.writeChat(request, chat, request.snapshotLabel || "chat-message-delete");
    return {
      ok: true,
      snapshotId,
      avatar: request.avatar,
      fileName: normalizeChatFileName(request.fileName),
      index: request.index,
      deleted,
      afterCount: Math.max(chat.length - 1, 0),
      reloadRequired: true,
    };
  }

  async inspectMvuChatState(locator: ChatLocator): Promise<unknown> {
    const { chat, metadata } = await this.readChatWithMetadata(locator);
    const messages = chat.slice(1).map((message, index) => {
      const variables = Array.isArray(message.variables) ? message.variables.filter(isRecord) : [];
      const latest = variables[0] || null;
      return {
        index,
        name: message.name,
        isUser: message.is_user,
        hasVariables: variables.length > 0,
        variableSnapshots: variables.length,
        initializedLorebooks: latest ? latest.initialized_lorebooks ?? null : null,
        statData: latest ? latest.stat_data ?? null : null,
      };
    });
    const latest = [...messages].reverse().find((message) => message.hasVariables) || null;
    return {
      schema: "st-mvu-chat-state/v1",
      avatar: locator.avatar,
      fileName: normalizeChatFileName(locator.fileName),
      storage: {
        chatFile: "user data chats/{avatar}/{fileName}.jsonl",
        statDataPath: "messages[index].variables[0].stat_data",
        initializedLorebooksPath: "messages[index].variables[0].initialized_lorebooks",
      },
      chatMetadata: {
        selectedWorldbook: metadata.world_info ?? null,
      },
      messageCount: Math.max(chat.length - 1, 0),
      latest,
      messages,
      writeTool: "st.mvu.chat_state.patch",
    };
  }

  async patchMvuChatState(request: MvuChatStatePatchRequest): Promise<unknown> {
    if (!request.confirm) throw new ConfirmationRequiredError("MVU chat state patch");
    const updates = request.updates || {};
    const unset = request.unset || [];
    if (Object.keys(updates).length === 0 && unset.length === 0) {
      throw new StMcpError("MVU chat state patch must include updates or unset paths");
    }
    const { chat } = await this.readChatWithMetadata(request);
    if (chat.length < 2) throw new StMcpError("chat has no messages to patch");
    const actualIndex = request.index === undefined
      ? chat.length - 1
      : normalizeChatMessageIndex(request.index, chat.length);
    const message = chat[actualIndex];
    const snapshots = Array.isArray(message.variables) ? message.variables.filter(isRecord) : [];
    const snapshot = snapshots[0] || {};
    const statData = ensureRecord(snapshot, "stat_data");
    const changedPaths = [...Object.keys(updates), ...unset];
    const before = selectPaths(statData, changedPaths);
    for (const [dottedPath, value] of Object.entries(updates)) setPath(statData, dottedPath, value);
    for (const dottedPath of unset) deletePath(statData, dottedPath);
    snapshots[0] = snapshot;
    message.variables = snapshots;
    const snapshotId = await this.writeChat(request, chat, request.snapshotLabel || "mvu-chat-state-patch");
    return {
      ok: true,
      snapshotId,
      avatar: request.avatar,
      fileName: normalizeChatFileName(request.fileName),
      index: actualIndex - 1,
      storagePath: "messages[index].variables[0].stat_data",
      before,
      after: selectPaths(statData, changedPaths),
      reloadRequired: true,
    };
  }

  async refreshCodebaseIndex(confirm?: boolean): Promise<unknown> {
    if (!confirm) throw new ConfirmationRequiredError("codebase index refresh");
    const scriptPath = path.join(this.config.mcpRoot, "scripts", "index-upstream-st.mjs");
    const docsPath = path.join(this.config.mcpRoot, "docs");
    const result = await runCommand("node", [scriptPath, this.config.stRoot, docsPath], this.config.mcpRoot);
    return {
      ok: true,
      stRoot: this.config.stRoot,
      docsPath,
      stdout: result.stdout.slice(-12000),
      stderr: result.stderr.slice(-12000),
      resources: ["st://index", "st://index/markdown"],
    };
  }

  async setExtensionEnabled(name: string, enabled: boolean, confirm: boolean): Promise<unknown> {
    if (!confirm) throw new ConfirmationRequiredError("extension enable/disable");
    const snapshot = await this.snapshots.create(`extension-${enabled ? "enable" : "disable"}`, [path.join(await this.resolveUserDataRoot(), "settings.json")]);
    const settings = await this.settings();
    const extensionSettings = ensureRecord(settings, "extension_settings");
    const disabled = new Set(asStringArray(extensionSettings.disabledExtensions));
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    extensionSettings.disabledExtensions = [...disabled].sort();
    await this.http.post("/api/settings/save", settings);
    return { ok: true, snapshotId: snapshot.id, name, enabled, reloadRequired: true };
  }

  async verify(targetUri = "st://status"): Promise<Record<string, unknown>> {
    const resource = await this.readResource(targetUri);
    return {
      ok: true,
      targetUri,
      checkedAt: new Date().toISOString(),
      kind: typeof resource,
      summary: summarize(resource),
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

  private async readChatWithMetadata(locator: ChatLocator): Promise<{ chat: Record<string, unknown>[]; metadata: Record<string, unknown> }> {
    const fileName = normalizeChatFileName(locator.fileName);
    const chat = await this.http.post("/api/chats/get", {
      avatar_url: locator.avatar,
      file_name: fileName,
    });
    if (!Array.isArray(chat)) throw new StMcpError("chat endpoint returned non-array response");
    const records = chat.filter(isRecord);
    if (records.length !== chat.length) throw new StMcpError("chat contains non-object records");
    if (records.length === 0) throw new StMcpError(`chat not found or empty: ${fileName}`);
    const header = records[0];
    if (!isRecord(header.chat_metadata)) header.chat_metadata = {};
    return { chat: records, metadata: header.chat_metadata as Record<string, unknown> };
  }

  private async writeChatMetadata(
    locator: ChatMetadataPatchRequest,
    chat: Record<string, unknown>[],
    metadata: Record<string, unknown>,
    snapshotLabel: string,
  ): Promise<string> {
    if (!isRecord(chat[0])) throw new StMcpError("chat header is missing");
    chat[0].chat_metadata = metadata;
    return this.writeChat(locator, chat, snapshotLabel);
  }

  private async writeChat(
    locator: ChatLocator & { force?: boolean },
    chat: Record<string, unknown>[],
    snapshotLabel: string,
  ): Promise<string> {
    const current = await this.readChatWithMetadata(locator);
    if (isRecord(current.metadata.nora_world) || isRecord(current.metadata.nora_session)
        || isRecord(asRecord(chat[0]?.chat_metadata).nora_world)) {
      throw new StMcpError("Nora-owned history must use nora.session.edit; raw ST writes and MVU file patches are not allowed.");
    }
    const snapshot = await this.snapshots.create(snapshotLabel, [path.join(await this.resolveUserDataRoot(), "chats", locator.avatar.replace(/\.png$/i, ""), normalizeChatFileName(locator.fileName) + ".jsonl")]);
    await this.http.post("/api/chats/save", {
      avatar_url: locator.avatar,
      file_name: normalizeChatFileName(locator.fileName),
      chat,
      force: Boolean(locator.force),
    });
    return snapshot.id;
  }

  private async patchCharacterField(avatar: string, field: string, value: unknown): Promise<void> {
    const card = await this.http.post("/api/characters/get", { avatar_url: avatar });
    if (!isRecord(card)) throw new StMcpError(`character not found: ${avatar}`);
    const data = isRecord(card.data) ? card.data : {};
    const name = typeof data.name === "string" ? data.name : typeof card.name === "string" ? card.name : "";
    if (!name) throw new StMcpError(`character has no native name: ${avatar}`);
    await this.http.post("/api/characters/edit-attribute", {
      ch_name: name,
      avatar_url: avatar,
      field,
      value,
    });
  }

  private supportsPatch(uri: string): boolean {
    const { segments } = parseStUri(uri);
    return (
      (segments[0] === "characters" && Boolean(segments[1]) && !segments[2]) ||
      (segments[0] === "worldbooks" && Boolean(segments[1]))
    );
  }

  private async listExtensions(): Promise<unknown> {
    const discovered = await this.http.get("/api/extensions/discover");
    const settings: Record<string, unknown> = await this.settings().catch(() => ({}));
    const extensionSettings = isRecord(settings.extension_settings) ? settings.extension_settings : {};
    const disabled = new Set(asStringArray(extensionSettings.disabledExtensions));
    if (!Array.isArray(discovered)) return discovered;
    return discovered.map((item) => isRecord(item) ? { ...item, enabled: !disabled.has(String(item.name || "")) } : item);
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

  private async resolveUserDataRoot(): Promise<string> {
    if (this.config.userDataRoot) {
      if (!await exists(this.config.userDataRoot)) throw new StMcpError("Configured user data directory does not exist; refusing fallback to another instance.");
      return this.config.userDataRoot;
    }
    const candidates = [
      this.config.userDataRoot,
      path.join(this.config.projectRoot, "local-state", "native", "default-user"),
      path.join(this.config.stRoot, "data", "default-user"),
      path.join(this.config.projectRoot, "data", "default-user"),
    ].filter((candidate): candidate is string => Boolean(candidate));
    for (const candidate of candidates) {
      if (await exists(candidate)) return candidate;
    }
    throw new StMcpError(`could not locate default-user data root; tried ${candidates.join(", ")}`);
  }

  private async readTextFile(filePath: string): Promise<{ path: string; text: string }> {
    return { path: filePath, text: await fs.readFile(filePath, "utf8") };
  }

  private async readJsonFile(filePath: string): Promise<unknown> {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  }

  private async readYamlFile(filePath: string): Promise<Record<string, unknown>> {
    const parsed = YAML.parse(await fs.readFile(filePath, "utf8"));
    if (!isRecord(parsed)) throw new StMcpError(`YAML file did not parse to an object: ${filePath}`);
    return parsed;
  }

  private async readCodebaseIndex(): Promise<Record<string, unknown>> {
    const index = await this.readJsonFile(path.join(this.config.mcpRoot, "docs", "upstream-st-index.json"));
    if (!isRecord(index)) throw new StMcpError("codebase index did not parse to an object");
    return index;
  }

  private async readIndexSection(section: string): Promise<unknown> {
    const index = await this.readCodebaseIndex();
    if (!hasPath(index, section)) throw new StMcpError(`index section not found: ${section}`);
    return getPath(index, section);
  }

  private configUsagesForPath(index: unknown, dottedPath: string): Array<Record<string, unknown>> {
    const usages = getPath(index, "configUsages");
    if (!Array.isArray(usages)) return [];
    return usages
      .filter((usage) => isRecord(usage) && typeof usage.key === "string")
      .filter((usage) => {
        const key = String(usage.key);
        return key === dottedPath || key.startsWith(`${dottedPath}.`) || dottedPath.startsWith(`${key}.`);
      }) as Array<Record<string, unknown>>;
  }

  private resolveExtensionConfigKey(extensionSettings: Record<string, unknown>, name?: string, allowCreate = false): string | null {
    if (!name) return null;
    const candidates = extensionConfigCandidates(name);
    const existing = candidates.find((candidate) => Object.prototype.hasOwnProperty.call(extensionSettings, candidate));
    if (existing) return existing;
    return allowCreate ? candidates[0] || null : null;
  }

  private async readBestEffortLog(): Promise<{ path: string; tail: string }> {
    const candidates = [
      path.join(this.config.projectRoot, "local-state", "native-runtime", "server.log"),
      path.join(this.config.projectRoot, "local-state", "native", "content.log"),
    ];
    for (const candidate of candidates) {
      if (!(await exists(candidate))) continue;
      const text = await fs.readFile(candidate, "utf8");
      return { path: candidate, tail: text.slice(-12000) };
    }
    throw new StMcpError("no known ST server log found");
  }

  private resolveScopeRoot(scope: FileScope): string {
    if (scope === "project-root") return this.config.projectRoot;
    if (scope === "st-root") return this.config.stRoot;
    if (scope === "st-mcp") return this.config.mcpRoot;
    throw new StMcpError(`unsupported scope: ${scope}`);
  }

  private resolveScopedPath(scope: FileScope, filePath: string): string {
    const root = this.resolveScopeRoot(scope);
    const target = path.resolve(root, filePath);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new StMcpError(`path escapes ${scope}: ${filePath}`);
    }
    return target;
  }
}

function parseStUri(uri: string): { segments: string[] } {
  const parsed = new URL(uri);
  if (parsed.protocol !== "st:") throw new StMcpError(`resource URI must use st:// protocol: ${uri}`);
  const segments = [parsed.hostname, ...parsed.pathname.split("/").filter(Boolean)];
  return { segments };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureRecord(target: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!isRecord(target[key])) target[key] = {};
  return target[key] as Record<string, unknown>;
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

function hasPath(target: unknown, dottedPath: string): boolean {
  const parts = splitPath(dottedPath);
  let cursor = target;
  for (const part of parts) {
    if (!isRecord(cursor) || !Object.prototype.hasOwnProperty.call(cursor, part)) return false;
    cursor = cursor[part];
  }
  return true;
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

function setPath(target: Record<string, unknown>, dottedPath: string, value: unknown): void {
  const parts = splitPath(dottedPath);
  let cursor: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    cursor = ensureRecord(cursor, part);
  }
  cursor[parts[parts.length - 1]] = value;
}

function deletePath(target: Record<string, unknown>, dottedPath: string): void {
  const parts = splitPath(dottedPath);
  let cursor: unknown = target;
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(cursor)) return;
    cursor = cursor[part];
  }
  if (isRecord(cursor)) delete cursor[parts[parts.length - 1]];
}

function selectPaths(target: unknown, dottedPaths: string[]): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const dottedPath of [...new Set(dottedPaths)]) {
    selected[dottedPath] = getPath(target, dottedPath);
  }
  return selected;
}

function normalizeDepth(value: number): number {
  return normalizeNonNegativeInteger(value, "depth");
}

function normalizeNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new StMcpError(`${label} must be a non-negative integer`);
  return value;
}

function normalizeExtensionPromptPosition(value: string | number): number {
  if (typeof value === "number") {
    if (Object.values(extensionPromptTypes).includes(value as never)) return value;
    throw new StMcpError(`unsupported extension prompt position: ${value}`);
  }
  const key = value.trim().toLowerCase().replace(/[-\s]/g, "_");
  if (Object.prototype.hasOwnProperty.call(extensionPromptTypes, key)) {
    return extensionPromptTypes[key as keyof typeof extensionPromptTypes];
  }
  throw new StMcpError(`unsupported extension prompt position: ${value}`);
}

function normalizePersonaPosition(value: string | number): number {
  if (typeof value === "number") {
    if (Object.values(personaDescriptionPositions).includes(value as never)) return value;
    throw new StMcpError(`unsupported persona position: ${value}`);
  }
  const key = value.trim().toLowerCase().replace(/[-\s]/g, "_");
  if (Object.prototype.hasOwnProperty.call(personaDescriptionPositions, key)) {
    return personaDescriptionPositions[key as keyof typeof personaDescriptionPositions];
  }
  throw new StMcpError(`unsupported persona position: ${value}`);
}

function normalizeExtensionPromptRole(value: string | number): number {
  if (typeof value === "number") {
    if (Object.values(extensionPromptRoles).includes(value as never)) return value;
    throw new StMcpError(`unsupported extension prompt role: ${value}`);
  }
  const key = value.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(extensionPromptRoles, key)) {
    return extensionPromptRoles[key as keyof typeof extensionPromptRoles];
  }
  throw new StMcpError(`unsupported extension prompt role: ${value}`);
}

function normalizeRegexPlacement(value: RegexPlacementName | number): number {
  if (typeof value === "number") {
    if (Object.values(regexPlacements).includes(value as never)) return value;
    throw new StMcpError(`unsupported regex placement: ${value}`);
  }
  const key = value.trim().toLowerCase().replace(/[-\s]/g, "_");
  if (Object.prototype.hasOwnProperty.call(regexPlacements, key)) {
    return regexPlacements[key as keyof typeof regexPlacements];
  }
  throw new StMcpError(`unsupported regex placement: ${value}`);
}

function normalizeSubstituteRegex(value: "none" | "raw" | "escaped" | number): number {
  if (typeof value === "number") {
    if ([0, 1, 2].includes(value)) return value;
    throw new StMcpError(`unsupported substituteRegex value: ${value}`);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "none") return 0;
  if (normalized === "raw") return 1;
  if (normalized === "escaped") return 2;
  throw new StMcpError(`unsupported substituteRegex value: ${value}`);
}

function normalizeNullableDepth(value: number | null, label: string): number | null {
  if (value === null) return null;
  return normalizeNonNegativeInteger(value, label);
}

function equalsCaseFold(left: unknown, right: unknown): boolean {
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, { sensitivity: "accent" }) === 0;
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

function defaultQuickReplySet(name: string): Record<string, unknown> {
  return {
    version: 2,
    name,
    disableSend: false,
    placeBeforeInput: false,
    injectInput: false,
    color: "rgba(0, 0, 0, 0)",
    onlyBorderColor: false,
    qrList: [],
    idIndex: 0,
  };
}

function normalizeQuickReply(
  reply: Record<string, unknown>,
  set: Record<string, unknown>,
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  const label = String(reply.label || "").trim();
  if (!label) throw new StMcpError("quick reply label is required");
  const qrList = Array.isArray(set.qrList) ? set.qrList.filter(isRecord) : [];
  const nextId = Math.max(0, Number(set.idIndex || 0), ...qrList.map((item) => Number(item.id || 0))) + 1;
  return {
    id: Number.isInteger(reply.id) ? Number(reply.id) : Number(existing.id || nextId),
    icon: typeof reply.icon === "string" ? reply.icon : existing.icon,
    showLabel: reply.showLabel === undefined ? Boolean(existing.showLabel) : Boolean(reply.showLabel),
    label,
    title: typeof reply.title === "string" ? reply.title : String(existing.title || ""),
    message: typeof reply.message === "string" ? reply.message : String(existing.message || ""),
    contextList: Array.isArray(reply.contextList) ? reply.contextList : Array.isArray(existing.contextList) ? existing.contextList : [],
    preventAutoExecute: reply.preventAutoExecute === undefined
      ? existing.preventAutoExecute === undefined ? true : Boolean(existing.preventAutoExecute)
      : Boolean(reply.preventAutoExecute),
    isHidden: reply.hidden === undefined && reply.isHidden === undefined
      ? Boolean(existing.isHidden)
      : Boolean(reply.hidden ?? reply.isHidden),
    executeOnStartup: reply.executeOnStartup === undefined ? Boolean(existing.executeOnStartup) : Boolean(reply.executeOnStartup),
    executeOnUser: reply.executeOnUser === undefined ? Boolean(existing.executeOnUser) : Boolean(reply.executeOnUser),
    executeOnAi: reply.executeOnAi === undefined ? Boolean(existing.executeOnAi) : Boolean(reply.executeOnAi),
    executeOnChatChange: reply.executeOnChatChange === undefined ? Boolean(existing.executeOnChatChange) : Boolean(reply.executeOnChatChange),
    executeOnGroupMemberDraft: reply.executeOnGroupMemberDraft === undefined
      ? Boolean(existing.executeOnGroupMemberDraft)
      : Boolean(reply.executeOnGroupMemberDraft),
    executeOnNewChat: reply.executeOnNewChat === undefined ? Boolean(existing.executeOnNewChat) : Boolean(reply.executeOnNewChat),
    executeBeforeGeneration: reply.executeBeforeGeneration === undefined
      ? Boolean(existing.executeBeforeGeneration)
      : Boolean(reply.executeBeforeGeneration),
    automationId: typeof reply.automationId === "string" ? reply.automationId : String(existing.automationId || ""),
  };
}

function applyRelativeUpdates(target: Record<string, unknown>, root: string, updates?: Record<string, unknown>): void {
  if (!updates) return;
  for (const [key, value] of Object.entries(updates)) {
    const cleanKey = key.trim();
    if (!cleanKey) throw new StMcpError("prompt injection update path cannot be empty");
    target[cleanKey.startsWith(`${root}.`) ? cleanKey : `${root}.${cleanKey}`] = value;
  }
}

function normalizeChatFileName(fileName: string): string {
  const clean = fileName.trim();
  if (!clean) throw new StMcpError("chat fileName is required");
  return clean.endsWith(".jsonl") ? clean.slice(0, -".jsonl".length) : clean;
}

function normalizeChatMessageIndex(index: number, chatLength: number): number {
  if (!Number.isInteger(index) || index < 0) throw new StMcpError("message index must be a non-negative integer");
  const actualIndex = index + 1;
  if (actualIndex <= 0 || actualIndex >= chatLength) throw new StMcpError(`message index out of range: ${index}`);
  return actualIndex;
}

function normalizeChatMessage(
  input: Record<string, unknown>,
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  const messageText = input.mes ?? input.message ?? existing.mes;
  if (typeof messageText !== "string") throw new StMcpError("chat message must include string mes or message");
  const isUser = input.is_user === undefined ? Boolean(existing.is_user) : Boolean(input.is_user);
  const isSystem = input.is_system === undefined ? Boolean(existing.is_system) : Boolean(input.is_system);
  const message: Record<string, unknown> = {
    ...existing,
    name: typeof input.name === "string"
      ? input.name
      : typeof existing.name === "string"
        ? existing.name
        : isUser ? "You" : "Assistant",
    is_user: isUser,
    is_system: isSystem,
    send_date: typeof input.send_date === "string"
      ? input.send_date
      : typeof existing.send_date === "string"
        ? existing.send_date
        : new Date().toISOString(),
    mes: messageText,
    extra: isRecord(input.extra)
      ? input.extra
      : isRecord(existing.extra)
        ? existing.extra
        : {},
  };

  for (const [key, value] of Object.entries(input)) {
    if (key === "message") continue;
    message[key] = value;
  }
  return message;
}

function normalizeChatMessagePatch(
  existing: Record<string, unknown>,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = new Set([
    "mes",
    "message",
    "name",
    "is_user",
    "is_system",
    "send_date",
    "extra",
    "swipes",
    "swipe_id",
    "gen_started",
    "gen_finished",
  ]);
  for (const field of Object.keys(fields)) {
    if (!allowed.has(field)) throw new StMcpError(`unsupported chat message field: ${field}`);
  }
  return normalizeChatMessage(fields, existing);
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

function normalizeCharacterField(field: string, value: unknown): unknown {
  if (field === "alternate_greetings") {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new StMcpError(`${field} must be an array of strings`);
    }
    return value;
  }
  if (typeof value !== "string") throw new StMcpError(`${field} must be a string`);
  return value;
}

function selectCharacterFields(card: unknown, fields: string[]): Record<string, unknown> {
  const record = asRecord(card);
  const data = asRecord(record.data);
  const selected: Record<string, unknown> = {};
  for (const field of fields) selected[field] = data[field] ?? record[field];
  return selected;
}

function worldbookEntryRecords(data: Record<string, unknown>): Array<[string, Record<string, unknown>]> {
  const entries = asRecord(data.entries);
  return Object.entries(entries)
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    .sort(([left], [right]) => Number(left) - Number(right));
}

function resolveWorldbookUid(
  entries: Record<string, unknown>,
  request: WorldbookEntryConfigureRequest,
  requireExisting: boolean,
): number | null {
  if (request.uid !== undefined) {
    if (!Number.isInteger(request.uid) || request.uid < 0) throw new StMcpError("worldbook uid must be a non-negative integer");
    if (requireExisting && !isRecord(entries[String(request.uid)])) throw new StMcpError(`worldbook entry not found: ${request.uid}`);
    return request.uid;
  }
  if (request.comment) {
    const found = Object.entries(entries).find(([, entry]) => isRecord(entry) && String(entry.comment || "") === request.comment);
    if (found) return Number(found[0]);
    if (requireExisting) throw new StMcpError(`worldbook entry not found by comment: ${request.comment}`);
  }
  return null;
}

function nextWorldbookUid(entries: Record<string, unknown>): number {
  const ids = Object.keys(entries).map(Number).filter(Number.isInteger);
  return ids.length ? Math.max(...ids) + 1 : 0;
}

function normalizeWorldbookEntry(input: Record<string, unknown>): Record<string, unknown> {
  const uid = Number(input.uid);
  if (!Number.isInteger(uid) || uid < 0) throw new StMcpError("worldbook entry uid must be a non-negative integer");
  const entry: Record<string, unknown> = {
    uid,
    key: normalizeStringArray(input.key ?? input.keys ?? []),
    keysecondary: normalizeStringArray(input.keysecondary ?? input.secondaryKeys ?? []),
    comment: typeof input.comment === "string" ? input.comment : "",
    content: typeof input.content === "string" ? input.content : "",
    constant: Boolean(input.constant),
    selective: input.selective === undefined ? true : Boolean(input.selective),
    order: normalizeIntegerWithDefault(input.order, 100, "order"),
    position: normalizeIntegerWithDefault(input.position, 0, "position"),
    disable: Boolean(input.disable),
    displayIndex: normalizeIntegerWithDefault(input.displayIndex, uid, "displayIndex"),
    addMemo: input.addMemo === undefined ? true : Boolean(input.addMemo),
    group: typeof input.group === "string" ? input.group : "",
    groupOverride: Boolean(input.groupOverride),
    groupWeight: normalizeIntegerWithDefault(input.groupWeight, 100, "groupWeight"),
    sticky: normalizeIntegerWithDefault(input.sticky, 0, "sticky"),
    cooldown: normalizeIntegerWithDefault(input.cooldown, 0, "cooldown"),
    delay: normalizeIntegerWithDefault(input.delay, 0, "delay"),
    probability: normalizeIntegerWithDefault(input.probability, 100, "probability"),
    depth: normalizeIntegerWithDefault(input.depth, 4, "depth"),
    useProbability: input.useProbability === undefined ? true : Boolean(input.useProbability),
    role: input.role ?? null,
    vectorized: Boolean(input.vectorized),
    excludeRecursion: Boolean(input.excludeRecursion),
    preventRecursion: Boolean(input.preventRecursion),
    delayUntilRecursion: Boolean(input.delayUntilRecursion),
    scanDepth: input.scanDepth ?? null,
    caseSensitive: input.caseSensitive ?? null,
    matchWholeWords: input.matchWholeWords ?? null,
    useGroupScoring: input.useGroupScoring ?? null,
    automationId: typeof input.automationId === "string" ? input.automationId : "",
  };
  for (const [key, value] of Object.entries(input)) {
    if (!(key in entry) && key !== "keys" && key !== "secondaryKeys") entry[key] = value;
  }
  return entry;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new StMcpError("worldbook entry keys must be arrays of strings");
  }
  return value;
}

function normalizeIntegerWithDefault(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue)) throw new StMcpError(`${label} must be an integer`);
  return numberValue;
}

function extensionConfigCandidates(name: string): string[] {
  const clean = name.trim();
  const last = clean.split("/").filter(Boolean).at(-1) || clean;
  const withoutPrefix = clean.replace(/^third-party\//, "");
  return [...new Set([withoutPrefix, last, clean].filter(Boolean))];
}

function promptSeamsFromIndex(index: unknown): Array<Record<string, unknown>> {
  const surfaces = getPath(index, "runtimeSurfaces.surfaces");
  if (!Array.isArray(surfaces)) return [];
  const interesting = new Set([
    "public/script.js",
    "public/scripts/openai.js",
    "public/scripts/world-info.js",
    "public/scripts/authors-note.js",
    "public/scripts/PromptManager.js",
    "public/scripts/events.js",
    "src/prompt-converters.js",
  ]);
  return surfaces
    .filter((surface) => isRecord(surface) && typeof surface.file === "string" && interesting.has(surface.file))
    .map((surface) => ({
      file: surface.file,
      seams: Array.isArray(surface.exportsOrSeams) ? surface.exportsOrSeams.slice(0, 40) : [],
      lineHints: Array.isArray(surface.lineHints) ? surface.lineHints : [],
    }));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function summarize(resource: unknown): unknown {
  if (Array.isArray(resource)) return { type: "array", length: resource.length };
  if (isRecord(resource)) return { type: "object", keys: Object.keys(resource).slice(0, 40) };
  return { type: typeof resource };
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function sanitizePluginId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function serverPluginTemplate(id: string, name: string, description: string): string {
  return `import express from 'express';

export const info = {
  id: ${JSON.stringify(id)},
  name: ${JSON.stringify(name)},
  description: ${JSON.stringify(description)}
};

export async function init(router) {
  router.use(express.json({ limit: '1mb' }));

  router.get('/health', (_request, response) => {
    response.json({ ok: true, plugin: info.id });
  });

  router.post('/echo', (request, response) => {
    response.json({ ok: true, body: request.body ?? null });
  });
}

export async function exit() {
  // Release timers, sockets, or file handles here when the ST server shuts down.
}
`;
}

async function runCommand(command: string, args: string[], cwd: string, timeoutMs = 5 * 60 * 1000): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(command, args, {
      cwd,
      timeout: Math.max(1000, timeoutMs),
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    if (isRecord(error)) {
      throw new StMcpError(`${command} ${args.join(" ")} failed: ${String(error.stderr || error.message || error)}`, { cause: error });
    }
    throw new StMcpError(`${command} ${args.join(" ")} failed: ${String(error)}`, { cause: error });
  }
}

async function runShellCommand(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("sh", ["-lc", command], {
      cwd,
      timeout: Math.max(1000, timeoutMs),
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    if (isRecord(error)) {
      throw new StMcpError(`runtime command failed: ${String(error.stderr || error.message || error)}`, { cause: error });
    }
    throw new StMcpError(`runtime command failed: ${String(error)}`, { cause: error });
  }
}
