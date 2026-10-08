import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { NoraMcpConfig } from "./config.js";
import { NoraConfirmationRequiredError, NoraMcpError, NoraRequestError } from "./errors.js";
import { NoraHttpClient } from "./http.js";

type JsonRecord = Record<string, unknown>;

export class NoraControlPlane {
  constructor(
    private readonly config: NoraMcpConfig,
    private readonly http: NoraHttpClient,
  ) {}

  async status(stDoctor?: () => Promise<unknown>): Promise<JsonRecord> {
    const checks: JsonRecord = {
      baseUrl: this.config.baseUrl,
      mcpRoot: this.config.mcpRoot,
      projectRoot: this.config.projectRoot,
      stRoot: this.config.stRoot,
      stateRoot: this.config.stateRoot,
      nativeDataRoot: this.config.nativeDataRoot,
      userDataRoot: this.config.userDataRoot,
      configPath: this.config.configPath,
    };

    checks.projectRootExists = await exists(this.config.projectRoot);
    checks.stRootExists = await exists(this.config.stRoot);
    checks.userDataRootExists = await exists(this.config.userDataRoot);
    checks.configExists = await exists(this.config.configPath);

    try {
      checks.csrf = Boolean(await this.http.csrf());
    } catch (error) {
      checks.csrf = false;
      checks.csrfError = String(error);
    }

    try {
      checks.bootstrapEndpoint = isRecord(await this.http.get("/api/nora-boot/bootstrap"));
    } catch (error) {
      checks.bootstrapEndpoint = false;
      checks.bootstrapError = String(error);
    }

    try {
      const instance = asRecord(await this.http.get("/api/nora-worlds-v2/status"));
      checks.worldsEndpoint = instance.enabled === true && instance.schema === 2;
      checks.instanceMatches = typeof instance.userDataRoot === "string"
        && await fs.realpath(instance.userDataRoot) === await fs.realpath(this.config.userDataRoot);
    } catch (error) {
      checks.worldsEndpoint = false;
      checks.worldsError = String(error);
    }

    try {
      checks.mvuModelEndpoint = isRecord(await this.http.post("/api/nora-mvu-model/config", {}));
    } catch (error) {
      checks.mvuModelEndpoint = false;
      checks.mvuModelError = String(error);
    }

    if (stDoctor) {
      try {
        checks.stCore = await stDoctor();
      } catch (error) {
        checks.stCore = { ok: false, error: String(error) };
      }
    }

    checks.ok = Boolean(
      checks.projectRootExists
      && checks.stRootExists
      && checks.userDataRootExists
      && checks.configExists
      && checks.csrf
      && checks.bootstrapEndpoint
      && checks.worldsEndpoint
      && checks.instanceMatches
      && checks.mvuModelEndpoint
      && (!stDoctor || asRecord(checks.stCore).ok),
    );
    return checks;
  }

  async controlMap(): Promise<JsonRecord> {
    return {
      schema: "nora-control-map/v2",
      purpose: "One MCP interface for Nora Tavern product controls and embedded SillyTavern core controls.",
      noraTools: {
        prefix: "nora.*",
        owns: [
          "Nora World identity and lifecycle",
          "Nora import operations and retry state",
          "Nora world open plans and activation snapshots",
          "Read capability state through world snapshots; no fabricated frontend acknowledgments",
          "Nora Story Profile card/checkpoint/learning surface",
          "Nora independent MVU model configuration",
          "Managed chat backups through the shared backup and ledger runtime",
          "Nora boot/bootstrap state",
        ],
      },
      stTools: {
        prefix: "st.*",
        owns: [
          "SillyTavern characters",
          "SillyTavern worldbooks",
          "Character chat inventories (session content is read through Nora)",
          "SillyTavern regex, MVU settings, Quick Reply, extension and plugin inventories",
          "Read-only compatibility inspection; product writes use Nora tools",
        ],
      },
      excluded: [
        "Role-card creation; use a card creation skill/protocol.",
        "Arbitrary shell layout/HTML/JS changes; World backgrounds/fonts/colors use theme controls.",
      ],
    };
  }

  async configLocations(): Promise<JsonRecord> {
    return {
      schema: "nora-config-locations/v1",
      roots: {
        projectRoot: this.config.projectRoot,
        stRoot: this.config.stRoot,
        stateRoot: this.config.stateRoot,
        nativeDataRoot: this.config.nativeDataRoot,
        userDataRoot: this.config.userDataRoot,
        configPath: this.config.configPath,
        uploadRoot: this.config.uploadRoot,
        exportRoot: path.join(this.config.stateRoot, "exports"),
      },
      noraDomains: [
        {
          domain: "chat_backups",
          location: "/api/backups/chat",
          storage: "Verified JSONL snapshots and ownership metadata; not installation rollback packages",
          readTools: ["nora.backup.list", "nora.backup.read", "nora.backup.restore_preview"],
          writeTools: ["nora.backup.download", "nora.backup.protect", "nora.backup.delete", "nora.backup.restore"],
          requiresLivePage: false,
        },
        {
          domain: "presets",
          storage: "Native chat-completion templates; independent World Core preset snapshots",
          readTools: ["nora.control.catalog", "nora.control.clients", "nora.control.read", "nora.control.operation"],
          writeTools: ["nora.control.execute", "nora.preset.import", "nora.preset.edit_file"],
          actions: ["preset.list", "preset.inspect", "preset.read-chunk", "preset.create", "preset.edit", "preset.delete", "preset.apply", "preset.save-as"],
          requiresLivePage: true,
          fileImport: { tool: "nora.preset.import", requiresLivePage: false, maxBytes: 10 * 1024 * 1024, directory: this.config.uploadRoot },
        },
        {
          domain: "library",
          storage: "World Core library-profiles; native worlds for worldbooks",
          location: path.join(this.config.userDataRoot, "nora-world-core", "library-profiles"),
          readTools: ["nora.library.list", "nora.library.read"], writeTools: ["nora.library.save", "nora.library.delete", "nora.library.import_card", "nora.library.manage_card", "nora.export"],
        },
        {
          domain: "world_core",
          storage: "default-user/nora-world-core",
          location: path.join(this.config.userDataRoot, "nora-world-core"),
          readTools: ["nora.world.list", "nora.world.inspect", "nora.world.open_plan", "nora.world.snapshot"],
          writeTools: ["nora.world.create", "nora.world.import", "nora.world.import_library", "nora.world.restart", "nora.world.repair", "nora.world.delete"],
        },
        {
          domain: "story_ledger",
          storage: "default-user/nora-story-ledger",
          location: path.join(this.config.userDataRoot, "nora-story-ledger"),
          readTools: ["nora.ledger.status", "nora.session.read"],
          writeTools: ["nora.ledger.configure", "nora.ledger.compress", "nora.ledger.reset", "nora.session.edit"],
        },
        {
          domain: "story_profile",
          storage: "Story Profile runtime state plus default-user chats/characters",
          location: path.resolve(this.config.stRoot, "..", "..", "story_profile_runtime"),
          readTools: ["nora.story.card", "nora.story.checkpoint.status"],
          writeTools: ["nora.story.checkpoint", "nora.story.learn", "nora.story.refresh"],
        },
        {
          domain: "mvu_model",
          storage: "default-user model config and secrets",
          location: this.config.userDataRoot,
          readTools: ["nora.mvu_model.get", "nora.mvu.diagnostics"],
          writeTools: ["nora.mvu_model.configure"],
        },
        {
          domain: "boot",
          storage: "runtime bootstrap payload",
          location: "/api/nora-boot/bootstrap",
          readTools: ["nora.status"],
          writeTools: [],
        },
      ],
      stDomains: [
        "Use the configured stRoot and userDataRoot; st.* exposes read-only inventories only.",
      ],
    };
  }

  async readResource(uri: string): Promise<unknown> {
    const segments = parseNoraUri(uri);
    if (uri === "nora://status") return this.status();
    if (uri === "nora://control-map") return this.controlMap();
    if (uri === "nora://config-locations") return this.configLocations();
    if (uri === "nora://bootstrap") return this.bootstrap();
    if (uri === "nora://worlds") return this.listWorlds();
    if (segments[0] === "worlds" && segments[1] && !segments[2]) return this.inspectWorld(decodeURIComponent(segments[1]));
    if (segments[0] === "worlds" && segments[1] && segments[2] === "snapshot") return this.worldSnapshot(decodeURIComponent(segments[1]));
    if (segments[0] === "operations" && segments[1]) return this.getOperation(decodeURIComponent(segments[1]));
    if (uri === "nora://story-profile/card") return this.storyCard();
    if (uri === "nora://mvu-model/config") return this.mvuModelConfig();
    if (uri === "nora://local-index") return this.localIndex();
    throw new NoraMcpError(`unsupported Nora resource URI: ${uri}`);
  }

  async bootstrap(): Promise<unknown> {
    return this.http.get("/api/nora-boot/bootstrap");
  }

  async localIndex(): Promise<JsonRecord> {
    const worldCoreRoot = path.join(this.config.userDataRoot, "nora-world-core");
    return {
      schema: "nora-local-index/v1",
      roots: { userDataRoot: this.config.userDataRoot, worldCoreRoot },
      counts: {
        characters: await countFiles(path.join(this.config.userDataRoot, "characters"), [".png", ".webp", ".json"]),
        chats: await countFiles(path.join(this.config.userDataRoot, "chats"), [".jsonl"]),
        stWorldbooks: await countFiles(path.join(this.config.userDataRoot, "worlds"), [".json"]),
        noraWorlds: await countFiles(path.join(worldCoreRoot, "worlds"), [".json"]),
        noraOperations: await countFiles(path.join(worldCoreRoot, "operations"), [".json"]),
        noraMutations: await countFiles(path.join(worldCoreRoot, "mutations"), [".json"]),
        extensions: await countDirectories(path.join(this.config.userDataRoot, "extensions")),
      },
      files: {
        worlds: await listFileNames(path.join(worldCoreRoot, "worlds"), 50),
        operations: await listFileNames(path.join(worldCoreRoot, "operations"), 50),
        mutations: await listFileNames(path.join(worldCoreRoot, "mutations"), 50),
      },
    };
  }

  async listWorlds(): Promise<unknown> {
    return this.http.get("/api/nora-worlds-v2/worlds");
  }

  async inspectWorld(worldId: string): Promise<JsonRecord> {
    const worlds = asRecord(await this.listWorlds());
    const list = Array.isArray(worlds.worlds) ? worlds.worlds : [];
    const world = list.find((item) => isRecord(item) && item.world_id === worldId) ?? null;
    if (!world) throw new NoraRequestError("World was not found.", "NORA_WORLD_NOT_FOUND", 404);
    return {
      worldId,
      world,
      openPlan: await this.worldOpenPlan(worldId).catch((error) => ({ error: String(error) })),
    };
  }

  async worldOpenPlan(worldId: string): Promise<unknown> {
    return this.http.get(`/api/nora-worlds-v2/worlds/${encodeURIComponent(worldId)}/open-plan`);
  }

  async worldSnapshot(worldId: string): Promise<unknown> {
    return this.http.get(`/api/nora-worlds-v2/worlds/${encodeURIComponent(worldId)}/snapshot`);
  }

  async repairWorld(worldId: string, idempotencyKey: string, confirm?: boolean): Promise<unknown> {
    if (!confirm) throw new NoraConfirmationRequiredError("Nora world repair");
    return this.worldMutation("POST", `/api/nora-worlds-v2/worlds/${encodeURIComponent(worldId)}/repair`, {}, idempotencyKey);
  }

  async previewWorldDeletion(worldId: string): Promise<unknown> {
    return this.http.get(`/api/nora-worlds-v2/worlds/${encodeURIComponent(worldId)}/delete-preview`);
  }

  async deleteWorld(worldId: string, idempotencyKey: string, confirm?: boolean, expectedPlan?: string): Promise<unknown> {
    if (!confirm) throw new NoraConfirmationRequiredError("Nora world delete");
    return this.worldMutation("DELETE", `/api/nora-worlds-v2/worlds/${encodeURIComponent(worldId)}`, { expected_plan: expectedPlan }, idempotencyKey);
  }

  async getOperation(operationId: string): Promise<unknown> {
    return this.http.get(`/api/nora-worlds-v2/operations/${encodeURIComponent(operationId)}`);
  }

  async retryOperation(operationId: string, confirm?: boolean): Promise<unknown> {
    if (!confirm) throw new NoraConfirmationRequiredError("Nora operation retry");
    try { return await this.http.post(`/api/nora-worlds-v2/operations/${encodeURIComponent(operationId)}/retry`, {}); }
    catch (error) {
      if (error instanceof NoraRequestError) throw new NoraRequestError(error.message, error.code, error.status, error.outcome,
        { ...error.details, operationId, nextTool: "nora.operation.get" });
      throw error;
    }
  }

  async beginCapabilityAttempt(worldId: string, capability: string, confirm?: boolean): Promise<unknown> {
    if (!confirm) throw new NoraConfirmationRequiredError("Nora capability attempt begin");
    return this.http.post(
      `/api/nora-worlds-v2/worlds/${encodeURIComponent(worldId)}/capabilities/${encodeURIComponent(capability)}/attempts`,
      {},
    );
  }

  async settleCapabilityAttempt(request: {
    worldId: string;
    capability: string;
    attemptId: string;
    status: "READY" | "DEGRADED";
    evidence?: JsonRecord;
    error?: { code: string; message: string; retryable?: boolean };
    confirm?: boolean;
  }): Promise<unknown> {
    if (!request.confirm) throw new NoraConfirmationRequiredError("Nora capability attempt settle");
    return this.http.put(
      `/api/nora-worlds-v2/worlds/${encodeURIComponent(request.worldId)}/capabilities/${encodeURIComponent(request.capability)}/attempts/${encodeURIComponent(request.attemptId)}`,
      { status: request.status, evidence: request.evidence, error: request.error },
    );
  }

  async storyCard(): Promise<unknown> {
    return this.http.get("/api/nora-story-profile/card");
  }

  async storyCheckpointStatus(worldId: string): Promise<unknown> {
    return this.http.get(`/api/nora-story-profile/checkpoint/${encodeURIComponent(worldId)}`);
  }

  async storyCheckpoint(worldId: string, confirm?: boolean): Promise<unknown> {
    if (!confirm) throw new NoraConfirmationRequiredError("Nora story checkpoint");
    return this.http.post("/api/nora-story-profile/checkpoint", { world_id: worldId });
  }

  async storyReflectPreview(worldId: string): Promise<unknown> {
    return this.http.post("/api/nora-story-profile/reflect-preview", { world_id: worldId }, { timeoutMs: this.config.modelTimeoutMs });
  }

  async storyLearn(payload: JsonRecord, confirm?: boolean): Promise<unknown> {
    if (!confirm) throw new NoraConfirmationRequiredError("Nora story learn");
    return this.http.post("/api/nora-story-profile/learn", payload, { timeoutMs: this.config.modelTimeoutMs });
  }

  async storyRefresh(confirm?: boolean): Promise<unknown> {
    if (!confirm) throw new NoraConfirmationRequiredError("Nora story refresh");
    return this.http.post("/api/nora-story-profile/refresh", {}, { timeoutMs: this.config.modelTimeoutMs });
  }

  async mvuModelConfig(): Promise<unknown> {
    return this.http.post("/api/nora-mvu-model/config", {});
  }

  async mvuDiagnostics(limit = 20): Promise<unknown> {
    const count = Math.max(1, Math.min(100, Math.floor(limit)));
    const result = await this.http.get(`/api/nora-mvu-diagnostics/recent?limit=${count}`) as { events?: JsonRecord[] };
    // Error prose can contain model output. Expose only bounded diagnostic metadata.
    const events = (result.events || []).map(event => ({
      receivedAt: event.receivedAt, code: event.code, stage: event.stage,
      identity: event.identity, chatId: event.chatId, kind: event.kind,
      commandCount: event.commandCount, acceptedCount: event.acceptedCount,
      persisted: event.persisted, attempt: event.attempt, durationMs: event.durationMs,
      validationErrorCount: Array.isArray(event.validationErrors) ? event.validationErrors.length : 0,
    }));
    return { events, rawTextOmitted: true, retention: "Existing per-user rotating diagnostics; absence does not prove success." };
  }

  async configureMvuModel(request: { baseUrl?: string; model?: string; apiKey?: string; context?: number; maxTokens?: number; confirm?: boolean }): Promise<unknown> {
    if (!request.confirm) throw new NoraConfirmationRequiredError("Nora MVU model configure");
    return this.http.post("/api/nora-mvu-model/configure", {
      base_url: request.baseUrl,
      model: request.model,
      api_key: request.apiKey,
      context: request.context,
      max_tokens: request.maxTokens,
    });
  }

  async createWorld(request: { name: string; personaName?: string; personaDescription?: string; idempotencyKey: string }): Promise<unknown> {
    return this.worldMutation("POST", "/api/nora-worlds-v2/worlds", {
      name: request.name, persona_name: request.personaName, persona_description: request.personaDescription,
    }, request.idempotencyKey);
  }

  async importLibrary(avatar: string, idempotencyKey: string): Promise<unknown> {
    return this.worldMutation("POST", "/api/nora-worlds-v2/library-imports", { avatar }, idempotencyKey);
  }

  async libraryList(kind: "card" | "character" | "persona" | "worldbook"): Promise<unknown> {
    if (kind === "card") return this.http.get("/api/nora-worlds-v2/library/cards");
    return this.http.get(kind === "worldbook" ? "/api/nora-worlds-v2/library/worldbooks" : `/api/nora-worlds-v2/library/profiles?kind=${kind}`);
  }

  async libraryRead(request: { id?: string; source?: { kind: "book" | "card"; name: string } }): Promise<unknown> {
    return request.source
      ? this.http.post("/api/nora-worlds-v2/library/worldbooks/read", { source: request.source })
      : this.http.post("/api/nora-worlds-v2/library/profiles/read", { id: request.id });
  }

  async libraryDelete(request: { id?: string; source?: { kind: "book"; name: string }; revision: string; confirm: boolean }): Promise<unknown> {
    if (!request.confirm) throw new NoraConfirmationRequiredError("Library deletion");
    if (Boolean(request.id) === Boolean(request.source)) throw new NoraRequestError("Provide exactly one profile id or independent book source.", "NORA_LIBRARY_TARGET_INVALID");
    return request.source
      ? this.http.post("/api/nora-worlds-v2/library/worldbooks/delete", { source: request.source, revision: request.revision })
      : this.http.post("/api/nora-worlds-v2/library/profiles/delete", { id: request.id, revision: request.revision });
  }

  async restartWorld(request: { worldId: string; name: string; expectedRevision: number; idempotencyKey: string }): Promise<unknown> {
    return this.worldMutation("POST", `/api/nora-worlds-v2/worlds/${encodeURIComponent(request.worldId)}/restarts`, {
      name: request.name, expected_revision: request.expectedRevision,
    }, request.idempotencyKey);
  }

  async librarySave(request: { kind: "character" | "persona" | "worldbook"; name: string; data: Record<string, unknown> }): Promise<unknown> {
    return request.kind === "worldbook"
      ? this.http.post("/api/nora-worlds-v2/library/worldbooks/import", { name: request.name, book: request.data })
      : this.http.post("/api/nora-worlds-v2/library/profiles/save", request);
  }

  async importBackground(filePath: string): Promise<unknown> {
    const [root, file] = await Promise.all([fs.realpath(this.config.uploadRoot), fs.realpath(filePath)]);
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new NoraRequestError("Background must be inside the configured upload directory.", "NORA_IMPORT_PATH_DENIED");
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 12 * 1024 * 1024) throw new NoraRequestError("Background must be a regular image at most 12 MiB.", "NORA_IMPORT_FILE_INVALID");
    const body = new FormData();
    body.set("avatar", new Blob([new Uint8Array(await fs.readFile(file))]), path.basename(file));
    return this.http.post("/api/nora-worlds-v2/backgrounds/import", body);
  }

  async importPreset(request: { filePath: string; name: string }): Promise<unknown> {
    return this.http.post("/api/presets/nora-import", { name: request.name, json: await this.readPresetFile(request.filePath) });
  }

  async editPresetFile(request: { filePath: string; name: string; expectedRevision: string }): Promise<unknown> {
    const edits = JSON.parse(await this.readPresetFile(request.filePath));
    const result = await this.http.post("/api/presets/nora-save", { mode: "edit", name: request.name, expectedRevision: request.expectedRevision, edits }) as JsonRecord;
    return { name: result.name, revision: result.revision, saved: result.saved, runtimeApplied: false, reloadRequired: true, worldUnchanged: true };
  }

  async manageLibraryCard(request: { action: "delete" | "deduplicate"; avatar: string; revision: string }): Promise<unknown> {
    return this.http.post("/api/nora-worlds-v2/library/cards/manage", request);
  }

  async exportFile(request: { kind: "card" | "preset" | "worldbook" | "profile"; target: string; format: "json" | "png" }): Promise<unknown> {
    let bytes: Buffer;
    if (request.kind === "card") {
      bytes = await this.http.download("/api/characters/export", { avatar_url: request.target, format: request.format });
    } else {
      if (request.format !== "json") throw new NoraRequestError("This resource exports as JSON.", "NORA_EXPORT_FORMAT_INVALID");
      let value: unknown;
      if (request.kind === "preset") value = (await this.http.post("/api/presets/nora-read", { name: request.target }) as JsonRecord).storedPreset;
      else if (request.kind === "worldbook") value = (await this.libraryRead({ source: { kind: "book", name: request.target } }) as JsonRecord).book;
      else value = await this.libraryRead({ id: request.target });
      if (!value) throw new NoraRequestError("Resource was not found.", "NORA_EXPORT_MISSING");
      bytes = Buffer.from(JSON.stringify(value, null, 2));
    }
    return this.saveExport(bytes, request.kind, request.format);
  }

  private async saveExport(bytes: Buffer, kind: string, format: string, maxBytes = 64 * 1024 * 1024): Promise<JsonRecord> {
    if (!bytes.length || bytes.length > maxBytes) throw new NoraRequestError("Invalid export size.", "NORA_EXPORT_TOO_LARGE");
    const state = await fs.realpath(this.config.stateRoot);
    const directory = path.join(state, "exports");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(directory)).isSymbolicLink() || await fs.realpath(directory) !== directory) throw new NoraRequestError("Unsafe export directory.", "NORA_EXPORT_PATH_DENIED");
    const output = path.join(directory, `${kind}-${randomUUID()}.${format}`);
    await fs.writeFile(output, bytes, { flag: "wx", mode: 0o600 });
    return { path: output, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), format, sourceUnchanged: true };
  }

  async listBackups(request: { worldId?: string; sessionId?: string; offset: number; limit: number; includeLegacy?: boolean }): Promise<JsonRecord> {
    if (request.sessionId && !request.worldId) throw new NoraRequestError("Session filtering requires a World.", "NORA_BACKUP_INVALID_SCOPE");
    const data = asRecord(await this.http.post("/api/backups/chat/managed"));
    if (!Array.isArray(data.snapshots)) throw new NoraRequestError("Invalid backup inventory.", "NORA_INVALID_RESPONSE");
    const snapshots = data.snapshots.filter(isRecord).filter(item => (!request.worldId || item.worldId === request.worldId)
      && (!request.sessionId || item.sessionId === request.sessionId));
    const fields = ["id", "worldId", "sessionId", "sha256", "bytes", "createdAt", "protected", "mvuState", "messageCount", "preview"];
    const result: JsonRecord = { snapshots: snapshots.slice(request.offset, request.offset + request.limit)
      .map(item => Object.fromEntries(fields.filter(key => key in item).map(key => [key, item[key]]))),
      totalMatched: snapshots.length, offset: request.offset, limit: request.limit, hasMore: request.offset + request.limit < snapshots.length,
      totalBytes: data.totalBytes, policy: data.policy, status: data.status, overBudget: data.overBudget,
      capacity: isRecord(data.capacity) ? Object.fromEntries(["protectedCount", "protectedBytes", "protectedCountExceeded", "protectedLimitReached"]
        .filter(key => key in (data.capacity as JsonRecord)).map(key => [key, (data.capacity as JsonRecord)[key]])) : null,
      warnings: Array.isArray(data.warnings) ? data.warnings.slice(0, 100) : [], legacyFiles: data.legacyFiles };
    if (request.includeLegacy) {
      const legacy = asRecord(await this.http.post("/api/backups/chat/inventory"));
      if (!Array.isArray(legacy.backups)) throw new NoraRequestError("Invalid legacy inventory.", "NORA_INVALID_RESPONSE");
      const managedNames = new Set(data.snapshots.filter(isRecord).map(item => `chat_nora1_${item.id}.jsonl`));
      const files = legacy.backups.filter(isRecord).filter(item => typeof item.name === "string" && !managedNames.has(item.name));
      result.legacy = { previewOnly: true, complete: legacy.complete,
        totalObserved: files.length, truncated: files.length > 50,
        files: files.slice(0, 50).map(item => ({ name: item.name, bytes: item.bytes, modifiedAt: item.modifiedAt, owner: item.owner })) };
    }
    return result;
  }

  readBackup(request: { id: string; sha256: string; offset: number; limit: number }): Promise<unknown> {
    return this.http.post("/api/backups/chat/read", request);
  }

  async downloadBackup(request: { id: string; sha256: string }): Promise<JsonRecord> {
    const bytes = await this.http.download("/api/backups/chat/snapshot", request, "chat-backup");
    if (createHash("sha256").update(bytes).digest("hex") !== request.sha256) throw new NoraRequestError("Downloaded backup changed.", "NORA_BACKUP_CHANGED");
    return { ...await this.saveExport(bytes, "chat-backup", "jsonl", 256 * 1024 * 1024), id: request.id };
  }

  protectBackup(request: { id: string; sha256: string; protected: boolean }): Promise<unknown> {
    return this.http.post("/api/backups/chat/protect", request);
  }

  deleteBackup(request: { id: string; sha256: string }): Promise<unknown> {
    return this.http.post("/api/backups/chat/remove", request);
  }

  previewBackupRestore(request: { id: string; worldId: string; sessionId: string }): Promise<unknown> {
    return this.http.post("/api/backups/chat/restore-preview", request);
  }

  async restoreBackup(request: { id: string; worldId: string; sessionId: string; sha256: string; expectedRevision: string }): Promise<JsonRecord> {
    let result: JsonRecord;
    try { result = asRecord(await this.http.post("/api/backups/chat/restore", request)); }
    catch (error) {
      if (error instanceof NoraRequestError && error.outcome === "unknown") throw new NoraRequestError(error.message, error.code, error.status, error.outcome,
        { ...error.details, nextTool: "nora.backup.restore", retryWithSameProof: request });
      throw error;
    }
    if (!["restored", "already-restored"].includes(String(result.status)) || result.worldId !== request.worldId || result.sessionId !== request.sessionId) {
      throw new NoraRequestError("Restore result is unconfirmed; keep the same proof when verifying.", "NORA_BACKUP_RESTORE_UNCONFIRMED", null, "unknown",
        { nextTool: "nora.backup.restore", retryWithSameProof: request });
    }
    return { ...result, frontendApplied: false, reloadRequired: true, modelCalled: false };
  }

  private async readPresetFile(filePath: string): Promise<string> {
    const maxBytes = 10 * 1024 * 1024;
    const [root, file] = await Promise.all([fs.realpath(this.config.uploadRoot), fs.realpath(filePath)]);
    const relative = path.relative(root, file);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new NoraRequestError("Preset must be inside the configured upload directory.", "NORA_IMPORT_PATH_DENIED");
    }
    if (path.extname(file).toLowerCase() !== ".json") throw new NoraRequestError("Preset must be a JSON file.", "NORA_IMPORT_FILE_INVALID");
    const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let json: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new NoraRequestError("Preset must be a regular file.", "NORA_IMPORT_FILE_INVALID");
      if (stat.size > maxBytes) throw new NoraRequestError("Preset exceeds 10 MB.", "NORA_PRESET_TOO_LARGE");
      const buffer = Buffer.alloc(maxBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > maxBytes) throw new NoraRequestError("Preset exceeds 10 MB.", "NORA_PRESET_TOO_LARGE");
      try { json = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)); JSON.parse(json); }
      catch { throw new NoraRequestError("Preset must contain valid UTF-8 JSON.", "NORA_PRESET_INVALID"); }
    } finally { await handle.close(); }
    return json;
  }

  private async cardUpload(filePath: string): Promise<FormData> {
    const [root, file] = await Promise.all([fs.realpath(this.config.uploadRoot), fs.realpath(filePath)]);
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new NoraRequestError("Card must be inside the configured upload directory.", "NORA_IMPORT_PATH_DENIED");
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024 || ![".png", ".webp", ".json", ".charx"].includes(path.extname(file).toLowerCase())) throw new NoraRequestError("Unsupported card file or file exceeds 64 MiB.", "NORA_IMPORT_FILE_INVALID");
    const bytes = await fs.readFile(file);
    const body = new FormData();
    body.set("avatar", new Blob([new Uint8Array(bytes)]), path.basename(file));
    return body;
  }

  async importLibraryCard(filePath: string): Promise<unknown> {
    return this.http.post("/api/nora-worlds-v2/library/cards/import", await this.cardUpload(filePath));
  }

  async importWorld(request: { filePath: string; name?: string; personaName?: string; personaDescription?: string; idempotencyKey: string }): Promise<unknown> {
    const body = await this.cardUpload(request.filePath);
    if (request.name) body.set("name", request.name);
    if (request.personaName) body.set("persona_name", request.personaName);
    if (request.personaDescription) body.set("persona_description", request.personaDescription);
    return this.worldMutation("POST", "/api/nora-worlds-v2/imports", body, request.idempotencyKey);
  }

  private async worldMutation(method: "POST" | "DELETE", route: string, input: JsonRecord | FormData, key: string): Promise<unknown> {
    if (typeof key !== "string" || !key.trim() || key !== key.trim()) throw new NoraRequestError("Provide one stable idempotencyKey and reuse it after disconnects.", "NORA_IDEMPOTENCY_REQUIRED");
    const operationId = `operation:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
    const body = input instanceof FormData ? input : { ...input, idempotency_key: key };
    if (body instanceof FormData) body.set("idempotency_key", key);
    try { return await (method === "DELETE" ? this.http.delete(route, body) : this.http.post(route, body)); }
    catch (error) {
      if (error instanceof NoraRequestError) throw new NoraRequestError(error.message, error.code, error.status, error.outcome,
        { ...error.details, operationId, idempotencyKey: key, nextTool: "nora.operation.get" });
      throw error;
    }
  }

  ledgerInspect(request: { worldId: string; sessionId: string; offset?: number; limit?: number }): Promise<unknown> {
    return this.http.post("/api/nora-story-ledger/inspect", request);
  }
  controlCatalog(): Promise<unknown> { return this.http.get("/api/nora-controls/catalog"); }
  controlClients(): Promise<unknown> { return this.http.get("/api/nora-controls/clients"); }
  controlOperation(id: string): Promise<unknown> { return this.http.get(`/api/nora-controls/operations/${encodeURIComponent(id)}`); }
  async controlRequest(request: JsonRecord, readOnly: boolean): Promise<unknown> {
    const id = "control:" + createHash("sha256").update(JSON.stringify(request.idempotencyKey)).digest("hex").slice(0, 32);
    try { return await this.http.post(`/api/nora-controls/${readOnly ? "read" : "execute"}`, request); }
    catch (error) {
      if (error instanceof NoraRequestError) throw new NoraRequestError(error.message, error.code, error.status, error.outcome,
        { ...error.details, operationId: id, nextTool: "nora.control.operation" });
      throw error;
    }
  }
  ledgerConfigure(request: { worldId: string; sessionId: string; enabled?: boolean; expectedRevision?: number; contextLimitOverride?: number | null; outputTokenLimit?: number; timeoutSeconds?: number }): Promise<unknown> {
    return this.http.post("/api/nora-story-ledger/configure", request);
  }
  ledgerCompress(request: { worldId: string; sessionId: string }): Promise<unknown> {
    return this.http.post("/api/nora-story-ledger/compress", request);
  }
  ledgerReset(request: { worldId: string; sessionId: string; confirm: true; expectedRevision: number; expectedSignature: string }): Promise<unknown> {
    return this.http.post("/api/nora-story-ledger/reset", request);
  }
  async editSession(request: { worldId: string; sessionId: string; messageId: number; text: string; expectedSignature: string }): Promise<unknown> {
    const result = asRecord(await this.http.post("/api/nora-story-ledger/edit", request));
    // Do not return a second full chat history to the caller; reread a bounded window.
    return { saved: true, followingMessagesRemoved: true, frontendApplied: false, ledger: result.ledger,
      nextTool: "nora.session.read" };
  }
}

function parseNoraUri(uri: string): string[] {
  if (!uri.startsWith("nora://")) throw new NoraMcpError(`unsupported Nora URI scheme: ${uri}`);
  return uri.slice("nora://".length).split("/").filter(Boolean);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function countFiles(root: string, extensions: string[]): Promise<number> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) count += await countFiles(fullPath, extensions);
      if (entry.isFile() && extensions.includes(path.extname(entry.name))) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

async function countDirectories(root: string): Promise<number> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}

async function listFileNames(root: string, limit: number): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort().slice(0, limit);
  } catch {
    return [];
  }
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
