// Offline Python production -> native World conversion. Called only on a copied state.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { pythonLoreEntry } from './python-lore.mjs';
import { collectPythonAssets } from './python-assets.mjs';
import { ImportPlan, DeferredData, parseData, object as record, validId as pythonId } from './python-import-plan.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const iso = value => {
    if (!Number.isFinite(value) || value < 0 || value > 8.64e12) throw new DeferredData('Invalid Python timestamp');
    return new Date(value * 1000).toISOString();
};
async function files(directory) {
    try { return (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function regular(file) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected regular migration source file');
    return fs.readFile(file);
}
// Adapt only the documented validation failures of domain APIs. Unexpected
// TypeErrors, dependency errors and disk failures must never become warnings.
function domainData(operation) {
    try { return operation(); }
    catch (error) {
        if (['NORA_WORLD_INVALID', 'NORA_WORLD_THEME_INVALID'].includes(error.code)
            || (error instanceof TypeError && error.message === 'Invalid World story context or entity reference.')
            || /^Invalid story ledger schema or entity reference\.$|^Story ledger (exceeds its memory budget|contains no memory|lost too much established memory)\.$/.test(error.message)) {
            throw new DeferredData('Unsupported legacy content: ' + error.message);
        }
        throw error;
    }
}
// Python json.dumps(..., ensure_ascii=False) used by original story_ledger.py.
function pythonJson(value) {
    if (Array.isArray(value)) return '[' + value.map(pythonJson).join(', ') + ']';
    return JSON.stringify(value);
}

export async function convertPythonState(state, app, { hermesModel = null, legacyModel = null, legacyApp = null, legacyWeb = 'frontend' } = {}) {
    const engine = path.join(app, 'engine/sillytavern');
    const module = relative => import(pathToFileURL(path.join(engine, relative)));
    const { validateWorldManifest } = await module('src/nora-world-core/domain.js');
    const { normalizeStoryContext, storyCharacterView, storyEntityBindings } = await module('public/scripts/nora-worlds/story-context.js');
    const { documentFileName } = await module('src/nora-world-core/atomic-json.js');
    const { convertEmbeddedBook } = await module('src/nora-world-core/st-backend-materializer.js');
    const { createStCardCodec } = await module('src/nora-world-core/st-card-codec.js');
    const { normalizeLedger } = await module('src/nora-story-ledger/schema.js');
    const { coveredMessageCount, prefixText } = await module('public/scripts/nora-story-ledger/history.js');
    const { ledgerStatePath } = await module('src/nora-story-ledger/state-file.js');
    const { normalizeWorldTheme } = await module('public/scripts/nora-worlds/world-theme.js');
    const source = (await files(state)).some(entry => entry.name === 'python-source') ? path.join(state, 'python-source') : state;
    const imports = new ImportPlan();
    const cards = await imports.namespace(source, 'cards');
    const books = await imports.namespace(source, 'worldbooks');
    const productions = await imports.namespace(source, 'productions');
    if (!(await files(source)).some(entry => entry.name === 'productions')) throw new Error('Python productions directory is required; Node migration is not supported');
    let sourceModels = null;
    await imports.record('models', null, 'model_configs.json', async () => {
        let bytes;
        try { bytes = await regular(path.join(state, 'model_configs.json')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        imports.remember('model_configs.json', bytes);
        const value = parseData(bytes);
        if (!record(value) || !Array.isArray(value.configs)) throw new DeferredData('Invalid Python model configuration');
        sourceModels = value;
    });
    const worldAssets = new Map();
    const assetFailures = new Map();
    for (const [id, production] of productions) {
        try {
            const assets = await collectPythonAssets(state, new Map([[id, production]]), legacyApp, legacyWeb);
            worldAssets.set(id, assets);
        } catch (error) {
            if (!(error instanceof DeferredData)) throw error;
            assetFailures.set(id, error);
        }
    }
    const root = path.join(state, 'native/default-user');
    const plan = imports.outputs;
    const put = (name, value) => imports.put(name, value);
    if ((await files(path.join(root, 'nora-world-core/worlds'))).length || (await files(path.join(root, 'nora-worlds'))).length) {
        throw new Error('Mixed Node and Python Worlds require explicit conflict resolution');
    }
    for (const assets of worldAssets.values()) for (const [name, bytes] of assets.entries) {
        if (!plan.has('python-source-assets/' + name)) put('python-source-assets/' + name, bytes);
    }
    const profileArchive = [];
    for (const file of ['story_profile.json', 'profile_eras.json', 'profile_events.jsonl']) {
        let bytes;
        try { bytes = await regular(path.join(state, file)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const valid = await imports.record('profile', null, file, () => {
            if (file === 'story_profile.json') {
                const profile = parseData(bytes);
                if (!record(profile) || profile.schema_version !== 1 || !['preferences', 'recent_timeline', 'shared_story_memory'].every(key => Array.isArray(profile[key]))) throw new DeferredData('Unsupported Story Profile schema');
            } else if (file.endsWith('.jsonl')) {
                if (!bytes.toString('utf8').split('\n').filter(line => line.trim()).every(line => record(parseData(line)))) throw new DeferredData('Invalid Profile events');
            } else if (!Array.isArray(parseData(bytes))) throw new DeferredData('Invalid Profile eras');
        });
        if (!valid) profileArchive.push({ file, bytes });
    }
    const report = { schema: 'python-to-node-migration/v1', pythonMigration: true, modelsCalled: 0,
        cards: 0, worldbooks: 0, worlds: [], warnings: [], deferred: imports.deferred, archived: imports.archived, users: [],
        profile: !profileArchive.some(item => item.file === 'story_profile.json') && (await files(state)).some(item => item.name === 'story_profile.json') ? { schema: 1, preserved: true } : null };
    const codec = createStCardCodec({ serverRoot: engine });
    const avatarFor = id => `python-card-${hash(id).slice(0, 24)}.png`;
    const baseCard = data => ({ spec: 'chara_card_v2', spec_version: '2.0', data: {
        name: '', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', creator_notes: '',
        system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {}, ...data,
    } });
    const encode = async card => {
        try { return (await codec.decode({ format: 'json', buffer: Buffer.from(JSON.stringify(card)) })).runtimeCardBuffer; }
        catch (error) {
            if (error.code === 'NORA_CARD_INVALID') throw new DeferredData('Invalid legacy card fields');
            throw error;
        }
    };
    for (const [id, card] of cards) {
        const imported = await imports.record('card', id, 'cards/' + id + '.json', async () => {
            if (!record(card.profile) || !record(card.profile.identity)) throw new DeferredData('Python card has no canonical profile: ' + id);
            const view = domainData(() => storyCharacterView({ ...card, persistent_status: {} }));
            const converted = baseCard({ ...card, ...view.data, name: card.profile.identity.name || card.name,
                first_mes: card.entry?.first_message ?? card.first_mes ?? '',
                scenario: card.entry?.initial_scenario ?? card.scenario ?? '',
                mes_example: card.entry?.example_dialogue ?? card.mes_example ?? '',
                system_prompt: card.performance?.system_prompt ?? card.system_prompt ?? '',
                post_history_instructions: card.performance?.post_history_instructions ?? card.post_history_instructions ?? '',
                extensions: { ...card.extensions, nora_python_source: { id, source_unknown: card.source_unknown || {} } } });
            if (!['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes',
                'system_prompt', 'post_history_instructions', 'creator', 'character_version'].every(key => typeof converted.data[key] === 'string')
                || !['alternate_greetings', 'tags'].every(key => Array.isArray(converted.data[key]) && converted.data[key].every(value => typeof value === 'string'))) {
                throw new DeferredData('Invalid legacy card text or list fields');
            }
            if (converted.data.character_book && !record(converted.data.character_book)) throw new DeferredData('Invalid embedded character book');
            if (converted.data.character_book) converted.data.character_book.extensions ||= {};
            put('native/default-user/characters/' + avatarFor(id), await encode(converted));
        });
        if (imported) report.cards++;
        else cards.delete(id);
    }
    const bookNames = new Map();
    for (const [id, book] of books) {
        const imported = await imports.record('worldbook', id, 'worldbooks/' + id + '.json', () => {
            const data = book.data || book;
            if (!Array.isArray(data.entries)) throw new DeferredData('Invalid Python Worldbook: ' + id);
            const name = 'python-book-' + hash(id).slice(0, 24);
            const ids = new Set();
            const normalized = data.entries.map((entry, index) => {
                if (!record(entry)) throw new DeferredData('Invalid Python worldbook entry');
                const id = entry.id ?? entry.uid ?? index;
                if ((!Number.isInteger(id) && !pythonId(id)) || ids.has(String(id))) throw new DeferredData('Duplicate or unsafe Python worldbook entry: ' + name);
                ids.add(String(id));
                return { ...pythonLoreEntry(entry, data), id };
            });
            const converted = convertEmbeddedBook({ ...data, entries: normalized });
            converted.originalData = clone(data);
            put(`native/default-user/worlds/${name}.json`, converted);
            bookNames.set(id, name);
        });
        if (imported) report.worldbooks++;
    }
    const charLore = [];
    for (const [id, production] of productions) {
        await imports.record('world', id, 'productions/' + id + '.json', async () => {
            if (assetFailures.has(id)) throw assetFailures.get(id);
            const assets = worldAssets.get(id);
            if (!Array.isArray(production.story) || !['active', 'archived', undefined].includes(production.status)) throw new DeferredData('Unsupported Python production: ' + id);
            const cast = production.runtime_cast;
            if (cast && (!record(cast) || cast.schema_version !== 3)) throw new DeferredData('Unsupported Python runtime_cast schema: ' + id);
            for (const key of ['cards', 'card_ids', 'worldbook_ids']) {
                if (production[key] !== undefined && !Array.isArray(production[key])) throw new DeferredData('Invalid Python production field: ' + key);
            }
            const originals = cast?.characters || production.cards || (production.card_ids || [production.card_id]).filter(Boolean).map(key => {
                if (!cards.has(key)) throw new DeferredData('Missing or deferred source card: ' + id);
                return cards.get(key);
            });
            if (!Array.isArray(originals) || !originals.every(record)) throw new DeferredData('Invalid Python runtime characters');
            const characters = originals.map(character => ({ ...clone(character), persistent_status: character.persistent_status || {},
                source_avatar: cards.has(character.source_card_id || character.id) ? avatarFor(character.source_card_id || character.id) : '' }));
            const playerProfile = clone(cast?.user_profile || production.persona?.profile || {
                identity: { name: production.persona?.name || '', description: production.persona?.description || '' },
            });
            const context = domainData(() => normalizeStoryContext({ schema_version: 1, characters,
                relationships: cast?.relationships || [], player: { profile: playerProfile, persistent_status: cast?.user_status || production.persona?.persistent_status || {} },
                author_note: production.author_note || '', language: production.response_language || 'zh',
                source_revision: cast?.revision || 0, applied_turn: cast?.applied_turn || 0 }));
            const persona = { name: playerProfile.identity?.name || production.persona?.name || '',
                description: playerProfile.identity?.description || production.persona?.description || '' };
            const avatar = `python-world-${hash(id).slice(0, 24)}.png`;
            const sessionId = 'session:python-' + hash(id).slice(0, 24);
            const chatId = 'python-story';
            const createdAt = iso(production.created_at);
            const name = production.name || 'World';
            put('native/default-user/characters/' + avatar, await encode(baseCard({ name,
                extensions: { nora_internal: { kind: 'blank-world-runtime' } } })));
            const knowledge = (production.worldbook_ids || []).map(bookId => {
                if (!bookNames.has(bookId)) throw new DeferredData('Missing or deferred Python worldbook: ' + id);
                const sourceBook = books.get(bookId);
                if (sourceBook.owner_production_id && sourceBook.owner_production_id !== id) throw new DeferredData('Python worldbook is owned by another production: ' + bookId);
                return { resource_id: 'resource:python-book-' + hash(bookId).slice(0, 24), source_key: bookId,
                    engine: 'sillytavern', binding: { name: bookNames.get(bookId) }, ownership: sourceBook.owner_production_id === id ? 'owned' : 'shared' };
            });
            if (new Set(production.worldbook_ids || []).size !== (production.worldbook_ids || []).length) throw new DeferredData('Duplicate Python worldbook attachment');
            const seenMessages = new Set();
            const messages = production.story.map(message => {
                if (!record(message) || !pythonId(message.id) || seenMessages.has(message.id) || !['user', 'char'].includes(message.role) || typeof message.text !== 'string') throw new DeferredData('Invalid Python message: ' + id);
                seenMessages.add(message.id);
                const swipes = message.alts || [message.text];
                const selected = message.active_alt ?? 0;
                if (!Array.isArray(swipes) || !swipes.every(item => typeof item === 'string') || !Number.isInteger(selected)
                    || selected < 0 || selected >= swipes.length || swipes[selected] !== message.text) throw new DeferredData('Python message alternative mismatch: ' + id);
                const sent = iso(message.ts);
                return { name: message.role === 'user' ? persona.name || 'User' : name, is_user: message.role === 'user', is_system: false,
                    mes: message.text, send_date: sent, swipe_id: selected, swipes, swipe_info: swipes.map(() => ({ send_date: sent, extra: {} })),
                    extra: { python_message_id: message.id, ...(message.segments ? { python_segments: clone(message.segments) } : {}) } };
            });
            const metadata = { nora_world: { id, version: 2, name, persona }, nora_session: { id: sessionId, version: 1 },
                ...(knowledge[0] ? { world_info: knowledge[0].binding.name } : {}) };
            const header = { user_name: persona.name, character_name: name, create_date: createdAt, chat_metadata: metadata };
            put(`native/default-user/chats/${avatar.slice(0, -4)}/${chatId}.jsonl`, Buffer.from([header, ...messages].map(item => JSON.stringify(item)).join('\n') + '\n'));
            let ui;
            if (production.ui) {
                ui = clone(production.ui);
                for (const [key, url] of Object.entries(ui.assets || {})) {
                    if (key === 'cover') { report.warnings.push({ world: id, code: 'COVER_NOT_DISPLAYED' }); delete ui.assets[key]; continue; }
                    const bytes = assets.get(url);
                    if (bytes) {
                        const output = 'python-' + hash(bytes) + path.extname(url.split(/[?#]/, 1)[0]).toLowerCase();
                        if (!plan.has('native/default-user/backgrounds/' + output)) put('native/default-user/backgrounds/' + output, bytes);
                        ui.assets[key] = '/backgrounds/' + output;
                    } else if (typeof url !== 'string' || !url.startsWith('https://')) throw new DeferredData('Python background requires its original source asset: ' + id);
                }
                ui = domainData(() => normalizeWorldTheme(ui));
            }
            const manifest = domainData(() => validateWorldManifest({ schema_version: 2, world_id: id, revision: 0, name, persona, story_context: context,
                ...(ui ? { ui } : {}), lifecycle: { status: 'READY', error: null },
                source: { type: 'python-production', sha256: hash(JSON.stringify(production)), original_name: id, format: 'python-json' },
                runtime_card: { resource_id: 'resource:python-' + hash(id).slice(0, 24), engine: 'sillytavern', binding: { avatar }, ownership: 'owned' },
                sessions: { default_session_id: sessionId, items: [{ session_id: sessionId, engine: 'sillytavern', binding: { avatar, chat_id: chatId }, opening_state: messages.length ? 'message' : 'empty' }] },
                knowledge, capabilities: { declared: [], items: {}, status: 'READY' }, created_at: createdAt,
                updated_at: iso(production.story.reduce((latest, message) => Math.max(latest, message.ts), production.created_at)) }));
            put('native/default-user/nora-world-core/worlds/' + documentFileName(id), manifest);
            const old = production.story_state;
            let ledgerStatus = 'none';
            if (old && ['timeline', 'facts', 'open_threads', 'objects', 'secrets', 'style_notes'].some(key => old[key]?.length)) {
                const ledgerImported = await imports.record('ledger', id, 'productions/' + id + '.json', () => {
                    const turns = old.turns;
                    const count = coveredMessageCount(messages, turns);
                    const legacySignature = hash(pythonJson(production.story.slice(0, count).map(message => [message.id, message.role, message.text || ''])));
                    const valid = !old.stale && Number.isInteger(turns) && turns > 0 && turns % 15 === 0
                        && turns < messages.filter(message => message.is_user).length
                        && (!old.covered_signature || old.covered_signature === legacySignature);
                    if (valid) {
                        const fields = ['timeline', 'facts', 'open_threads', 'objects', 'secrets', 'scene', 'style_notes'];
                        const rawLedger = Object.fromEntries(fields.map(key => [key, old[key]]));
                        // Validate, but do not replace the old values with normalization's truncation.
                        domainData(() => normalizeLedger(rawLedger, {}, Object.keys(storyEntityBindings(context, persona.name))));
                        const imported = { id: 'python-ledger-' + hash(id).slice(0, 24), coveredTurns: turns, messageCount: count,
                            signature: hash(prefixText(messages, count)), ledger: rawLedger, createdAt: (old.updated_at || production.created_at) * 1000,
                            source: 'python-validated' };
                        put(path.relative(state, ledgerStatePath(root, { worldId: id, sessionId })), {
                            version: 1, enabled: true, active: null, pending: imported, imported, lastError: null,
                        });
                        ledgerStatus = 'pending-first-node-dispatch';
                    } else {
                        report.warnings.push({ world: id, code: 'STALE_LEDGER_RAW_HISTORY_RETAINED' });
                        ledgerStatus = 'stale-not-activated';
                    }
                });
                if (!ledgerImported) ledgerStatus = 'deferred-raw-history-retained';
            }
            if (knowledge.length > 1) charLore.push({ name: avatar.slice(0, -4), extraBooks: knowledge.slice(1).map(book => book.binding.name) });
            report.worlds.push({ id, sessionId, messages: messages.length, turns: messages.filter(message => message.is_user).length,
                characters: characters.map(character => character.id), ledger: ledgerStatus });
        });
    }
    const modelConfigs = sourceModels || { configs: [], active: 'builtin' };
    const selectedLegacy = String(modelConfigs.active || 'builtin');
    if (selectedLegacy.startsWith('clawling:') && !legacyModel) imports.deferred.push({ kind: 'model-selection', file: 'model_configs.json', code: 'PENDING_CONVERSION', reason: 'Selected Python built-in provider configuration is missing' });
    const configs = [...modelConfigs.configs];
    const legacyId = 'python-builtin-' + hash(selectedLegacy).slice(0, 16);
    const isLegacySelected = selectedLegacy === 'builtin' || selectedLegacy.startsWith('clawling:');
    const explicitLegacy = selectedLegacy.startsWith('clawling:') && legacyModel;
    const legacyName = explicitLegacy ? selectedLegacy.slice(9) : '';
    const sameAsHermes = explicitLegacy && hermesModel
        && String(legacyModel.base_url).trim().replace(/\/+$/, '') === String(hermesModel.base_url).trim().replace(/\/+$/, '')
        && legacyModel.api_key === hermesModel.api_key && legacyName === hermesModel.model;
    // Generic "builtin" follows the target Hermes model. Preserve a distinct
    // explicitly selected old provider, but do not copy an identical default.
    if (explicitLegacy && !sameAsHermes) configs.push({ id: legacyId, name: legacyModel.provider,
        base: legacyModel.base_url, key: legacyModel.api_key,
        model: legacyName });
    const selected = explicitLegacy && !sameAsHermes ? legacyId : selectedLegacy;
    const profiles = [], secrets = [];
    for (const config of configs) {
        await imports.record('model', pythonId(config?.id) ? config.id : null, 'model_configs.json', () => {
            if (!record(config) || !pythonId(config.id) || profiles.some(profile => profile.id === config.id)
                || !['base', 'key', 'model', 'name'].every(key => typeof config[key] === 'string' && config[key])) throw new DeferredData('Invalid custom model configuration');
            if (!URL.canParse(config.base)) throw new DeferredData('Invalid model endpoint');
            const url = new URL(config.base);
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new DeferredData('Invalid model endpoint');
            const secretId = crypto.randomUUID();
            profiles.push({ id: config.id, name: config.name, model: config.model, base: config.base,
                context: 200000, tokens: 10000, secretId });
            secrets.push({ id: secretId, value: config.key, label: config.name, active: config.id === selected });
        });
    }
    if (!isLegacySelected && !profiles.some(profile => profile.id === selected)) imports.deferred.push({ kind: 'model-selection', file: 'model_configs.json', code: 'PENDING_CONVERSION', reason: 'Selected Python custom model is missing; use the target Hermes default or configure a model' });
    const nora = { schema: 2, modelProfiles: profiles, activeModel: profiles.some(profile => profile.id === selected) ? selected : '' };
    let active = profiles.find(profile => profile.id === nora.activeModel);
    if (hermesModel) {
        const secretId = crypto.randomUUID();
        const builtin = { provider: hermesModel.provider, model: hermesModel.model, base: hermesModel.base_url,
            context: hermesModel.context, tokens: hermesModel.max_tokens, secretId };
        nora.hermesModel = builtin;
        secrets.push({ id: secretId, value: hermesModel.api_key, label: 'Hermes default model', active: !active });
        if (!active) active = builtin;
    }
    if (!active) report.warnings.push({ code: 'MODEL_CONFIGURATION_REQUIRED' });
    const settings = { main_api: 'openai', extension_settings: { nora_ui: nora },
        world_info_settings: { world_info: { charLore }, world_info_recursive: true, world_info_max_recursion_steps: 2 },
        oai_settings: active ? { chat_completion_source: 'custom', custom_url: active.base, custom_model: active.model,
            openai_max_context: active.context, openai_max_tokens: active.tokens, max_context_unlocked: true, stream_openai: true } : {} };
    put('native/default-user/settings.json', settings);
    put('native/default-user/secrets.json', { api_key_custom: secrets });
    report.status = report.deferred.length ? 'partial' : 'complete';
    report.archive = 'python-source';
    for (const item of [...report.deferred, ...report.archived]) {
        item.archiveFile = /^(cards|worldbooks|productions)\//.test(item.file)
            ? 'python-source/' + item.file
            : item.kind === 'profile' ? 'python-source-profile/' + item.file : item.file;
    }
    report.users.push({ user: 'default-user', before: 0, after: report.worlds.length, active: report.worlds.map(world => world.id) });
    for (const { file, bytes } of profileArchive) put('python-source-profile/' + file, bytes);
    // No active output is written until compatible records and every destination pass preflight.
    for (const name of plan.keys()) {
        try { await fs.lstat(path.join(state, name)); throw new Error('Migration destination already exists: ' + name); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const [name, bytes] of plan) {
        const file = path.join(state, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    }
    // Only the prepared copy is altered. Byte-identical archives now exist.
    for (const { file } of profileArchive) await fs.unlink(path.join(state, file));
    // Archive original data namespaces INSIDE the prepared copy, not old executable code.
    // Subsequent normal Node upgrades must not mistake these audited originals for unmigrated live records.
    if (source === state) {
        await fs.mkdir(path.join(state, 'python-source'));
        for (const name of ['cards', 'worldbooks', 'productions']) {
            try { await fs.rename(path.join(state, name), path.join(state, 'python-source', name)); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }
    return report;
}
