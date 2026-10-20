// Node integration cases select fault modes; these are not Playwright UI tests.
/* eslint playwright/no-conditional-in-test: off, playwright/expect-expect: off */
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
    pathToFileURL,
    fileURLToPath,
} from 'node:url';
import { createHash } from 'node:crypto';
test('World creation retries and UI/MCP deletion preserve isolated user data', async t => {
    const repo = fileURLToPath(new URL('../../../../', import.meta.url));
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-workflow-compiled-'));
    const require = createRequire(path.join(repo, 'app/engine/sillytavern/package.json'));
    const express = require('express'), multer = require('multer'), { load } = require('cheerio');
    const engine = 'app/engine/sillytavern/';
    const mod = p => import(pathToFileURL(path.join(repo, p)));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-suspects-runtime-'));
    const oldCwd = process.cwd(), nativeFetch = globalThis.fetch, NativeFormData = globalThis.FormData, oldDataRoot = globalThis.DATA_ROOT, oldConsoleError = console.error;
    process.chdir(path.join(repo, engine));
    globalThis.DATA_ROOT = root;
    const report = {
        schema: 1,
        source: 'working-tree',
        isolationRoot: root,
        method: 'actual UI controller -> production adapter/client -> loopback HTTP router -> World Core -> real codec and disk; actual MCP control plane and HTTP client',
        cases: [],
        faults: [],
        harnessErrors: [],
    };
    let server, characterModule, active;
    const sha = b => createHash('sha256').update(b).digest('hex');
    const errorsToString = e => ({
        name: e.name,
        message: e.message,
        code: e.code,
        status: e.status,
        stack: e.stack,
    });
    function memory() {
        const m = new Map();
        return {
            getItem: k => m.get(k) ?? null,
            setItem: (k, v) => m.set(k, v),
            removeItem: k => m.delete(k),
            entries: () => [...m.entries()],
        };
    }
    function operations() {
        const busy = new Set();
        return {
            isBusy: k => busy.has(k),
            async run(k, f) {
                assert.ok(!busy.has(k));
                busy.add(k);
                try {
                    return await f();
                } finally {
                    busy.delete(k);
                }
            },
        };
    }
    function domFixture() {
        let dom, modal, version = 0;
        const wrappers = new WeakMap(), messages = [], confirmations = [];
        const wrap = raw => {
            if (!raw)
                return null;
            if (wrappers.has(raw))
                return wrappers.get(raw);
            const node = {
                raw,
                handlers: {},
                dataset: Object.fromEntries(Object.entries(raw.attribs || {}).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [
                    k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()),
                    v,
                ])),
                disabled: raw.attribs?.disabled !== undefined,
                addEventListener(k, fn) {
                    this.handlers[k] = fn;
                },
                focus() {
                },
                querySelector(q) {
                    return select(q, this);
                },
                insertAdjacentHTML(_where, html) {
                    dom(raw).prepend(html);
                },
                get formData() {
                    return Object.fromEntries(dom(raw).find('[name]').toArray().map(e => [
                        dom(e).attr('name'),
                        dom(e).attr('value') || '',
                    ]));
                },
                async fire(k) {
                    if (this.disabled)
                        return;
                    return this.handlers[k]?.({
                        preventDefault() {
                        },
                        currentTarget: this,
                    });
                },
            };
            Object.defineProperty(node, 'value', {
                get: () => dom(raw).attr('value') || '',
                set: v => {
                    dom(raw).attr('value', v);
                },
            });
            wrappers.set(raw, node);
            return node;
        };
        const select = (q, parent = modal) => wrap(dom(parent.raw).find(q).get(0));
        return {
            select,
            selectAll: (q, parent = modal) => dom(parent.raw).find(q).toArray().map(wrap),
            open: (_title, html) => {
                version++;
                dom = load('<div id="modal">' + html + '</div>');
                modal = wrap(dom('#modal').get(0));
                return modal;
            },
            close() {
                version++;
            },
            toast: m => messages.push(m),
            messages,
            confirmations,
            get version() {
                return version;
            },
            html: () => dom?.html(),
        };
    }
    globalThis.FormData = class extends NativeFormData {
        constructor(form) {
            super();
            if (form?.formData)
                for (const [k, v] of Object.entries(form.formData))
                    this.append(k, v);
            else
                assert.equal(form, undefined);
        }
    };
    async function walk(dir) {
        const r = {};
        for (const d of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
            const p = path.join(dir, d.name);
            if (d.isDirectory())
                Object.assign(r, await walk(p));
            else if (d.isFile())
                r[p] = sha(await fs.readFile(p));
        }
        return r;
    }
    async function changed(before) {
        const dif = [];
        for (const [p, h] of Object.entries(before)) {
            let b;
            try {
                b = await fs.readFile(p);
            } catch {
                dif.push(path.relative(root, p));
                continue;
            }
            if (sha(b) !== h)
                dif.push(path.relative(root, p));
        }
        return dif;
    }
    async function record(name, fn) {
        await t.test(name, async () => {
            const value = await fn();
            report.cases.push({
                name,
                ...value,
            });
            assert.equal(value.violation, false, JSON.stringify(value));
        });
    }
    try {
        await fs.writeFile(path.join(root, 'ISOLATED_TEST_ONLY'), 'Nora controlled fault-injection and deletion audit');
        const config = path.join(root, 'config.yaml');
        await fs.writeFile(config, 'performance:\n  useDiskCache: false\n  memoryCacheCapacity: 10mb\nthumbnails:\n  enabled: false\n');
        const util = await mod(engine + 'src/util.js');
        util.setConfigFilePath(config);
        const { createNoraWorldsV2Router } = await mod(engine + 'src/endpoints/nora-worlds-v2.js');
        const { resolveNoraWorldCore, clearNoraWorldCoreCache } = await mod(engine + 'src/nora-world-core/runtime.js');
        const { createStCardCodec } = await mod(engine + 'src/nora-world-core/st-card-codec.js');
        const codec = createStCardCodec({ serverRoot: path.join(repo, engine) });
        const { createWorldCoreClient } = await mod(engine + 'public/scripts/nora-worlds/world-core-client.js');
        const { createWorldCoreRuntime } = await mod(engine + 'public/scripts/nora-worlds/world-core-runtime.js');
        const { createWorldCreationController } = await mod('app/native-extensions/nora-ui/world-creation-controller.js');
        const { createCharacterController } = await mod('app/native-extensions/nora-ui/character-controller.js');
        const { createStCardAdapter } = await mod(engine + 'public/scripts/nora-adapters/st-card-adapter.js');
        characterModule = await mod(engine + 'src/endpoints/characters.js');
        // Exercise the real MCP control plane and HTTP client without installing or
        // starting an agent. Compile only these sources into the disposable test root.
        const ts = require('typescript');
        const compiled = path.join(out, 'mcp');
        await fs.mkdir(compiled, { recursive: true });
        await fs.writeFile(path.join(compiled, 'package.json'), '{"type":"module"}');
        for (const name of [
            'nora-control-plane',
            'http',
            'errors',
        ]) {
            const src = await fs.readFile(path.join(repo, 'nora-mcp/src', name + '.ts'), 'utf8');
            const result = ts.transpileModule(src, {
                compilerOptions: {
                    module: ts.ModuleKind.ESNext,
                    target: ts.ScriptTarget.ES2022,
                },
            });
            await fs.writeFile(path.join(compiled, name + '.js'), result.outputText);
        }
        const { NoraControlPlane } = await import(pathToFileURL(path.join(compiled, 'nora-control-plane.js')));
        const { NoraHttpClient } = await import(pathToFileURL(path.join(compiled, 'http.js')));
        const app = express();
        app.use(express.json());
        app.get('/csrf-token', (_req, res) => res.json({ token: 'isolated-test-token' }));
        app.use((req, res, next) => {
            assert.ok(active?.dirs.root.startsWith(root + path.sep));
            req.user = {
                directories: active.dirs,
                profile: { handle: 'isolated-only' },
            };
            active.requests.push({
                path: req.path,
                method: req.method,
                body: req.body,
            });
            next();
        });
        app.use(multer({ dest: path.join(root, 'uploads') }).single('avatar'));
        app.use('/api/nora-worlds-v2', createNoraWorldsV2Router());
        app.use('/api/characters', characterModule.router);
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const base = `http://127.0.0.1:${ server.address().port }`;
        globalThis.fetch = (url, opts) => nativeFetch(new URL(url, base), opts);
        async function setup(name) {
            const dirs = { root: path.join(root, name) };
            for (const k of [
                'characters',
                'chats',
                'worlds',
                'userImages',
                'thumbnails',
                'thumbnailsAvatar',
                'thumbnailsBg',
                'thumbnailsPersona',
                'avatars',
                'backgrounds',
                'groups',
            ])
                dirs[k] = path.join(dirs.root, k);
            for (const d of Object.values(dirs))
                await fs.mkdir(d, { recursive: true });
            await fs.writeFile(path.join(dirs.root, 'settings.json'), JSON.stringify({
                isolationSentinel: 'keep',
                model: {
                    endpoint: 'https://model.invalid',
                    name: 'synthetic-model',
                    key: 'synthetic-test-value',
                },
            }));
            active = {
                dirs,
                requests: [],
            };
            const core = resolveNoraWorldCore(dirs);
            await core.saveLibraryProfile({
                kind: 'character',
                name: 'Retain character template',
                data: {
                    name: 'Existing character',
                    description: 'Keep this independent character',
                },
            });
            await core.saveLibraryProfile({
                kind: 'persona',
                name: 'Retain player template',
                data: {
                    name: 'Existing player',
                    description: 'Keep this independent player',
                },
            });
            return {
                dirs,
                core,
                requests: active.requests,
            };
        }
        async function waitWorlds(core, count) {
            for (let n = 0; n < 500; n++) {
                const worlds = await core.listWorlds();
                if (worlds.length >= count && worlds.every(w => w.lifecycle.status === 'READY'))
                    return worlds;
                await new Promise(r => setTimeout(r, 10));
            }
            throw new Error('Isolated server did not finish materialization');
        }
        async function protectedFiles(f) {
            return {
                ...await walk(f.dirs.characters),
                ...await walk(f.dirs.chats),
                ...await walk(f.dirs.worlds),
                ...await walk(f.dirs.groups),
                ...await walk(path.join(f.dirs.root, 'nora-world-core/worlds')),
                ...await walk(path.join(f.dirs.root, 'nora-world-core/library-profiles')),
                [path.join(f.dirs.root, 'settings.json')]: sha(await fs.readFile(path.join(f.dirs.root, 'settings.json'))),
            };
        }
        async function creation(mode, kind = 'blank') {
            const f = await setup('create-' + mode + '-' + kind), store = memory(), requests = [];
            let faults = 0, enabled = true;
            const client = createWorldCoreClient(() => ({ 'content-type': 'application/json' }), {
                pendingStore: store,
                pollIntervalMs: 1,
                fetchImpl: async (url, opts = {}) => {
                    const response = await globalThis.fetch(url, opts);
                    const submit = opts.method === 'POST' && /\/(worlds|imports|library-imports)$/.test(url);
                    requests.push({
                        method: opts.method || 'GET',
                        url,
                        key: typeof opts.body === 'string' ? JSON.parse(opts.body).idempotency_key : opts.body?.get?.('idempotency_key') || null,
                        status: response.status,
                    });
                    const failSubmit = submit && response.ok && enabled && (mode === 'first-response-lost' && faults === 0 || mode === 'all-responses-lost');
                    const failRead = enabled && mode === 'poll-response-lost' && url.includes('/operations/');
                    const failList = enabled && mode === 'list-response-lost' && url.endsWith('/worlds') && !opts.method;
                    if (failSubmit || failRead || failList) {
                        await response.text();
                        faults++;
                        throw new TypeError('Injected lost server response');
                    }
                    return response;
                },
            });
            const runtime = createWorldCoreRuntime({ read: () => ({ metadata: {} }) }, {
                client,
                refreshCharacters: async () => {
                    if (enabled && mode === 'character-refresh-failed')
                        throw new Error('Injected character refresh failure');
                },
            });
            const ui = domFixture(), openings = [];
            const ctl = createWorldCreationController({
                worldRuntime: runtime,
                operations: operations(),
                select: ui.select,
                openModal: ui.open,
                closeModal: ui.close,
                showToast: ui.toast,
                normalizeError: e => e.message,
                loadWorlds: () => runtime.refresh(),
                refresh() {
                },
                openWorldById: async id => {
                    openings.push(id);
                    return enabled && mode === 'opening-failed' ? false : true;
                },
            });
            let libraryCard;
            const bytes = Buffer.from(JSON.stringify({
                name: 'Isolated source',
                description: 'Source must remain',
                first_mes: 'Synthetic opening',
                character_book: { entries: [] },
            }));
            if (kind === 'library')
                libraryCard = await f.core.saveLibraryCard({
                    buffer: bytes,
                    format: 'json',
                });
            const action = async () => {
                if (kind === 'blank')
                    return ui.select('#nora-blank-world-form').fire('submit');
                if (kind === 'import')
                    return ctl.handleCharacterImport({
                        currentTarget: {
                            files: [new File([bytes], 'isolated.json', { type: 'application/json' })],
                            value: 'selected',
                        },
                    });
                return ctl.createFromLibrary({
                    avatar: libraryCard.avatar,
                    name: 'Isolated source',
                }, { disabled: false });
            };
            if (kind === 'blank') {
                ctl.openBlankWorldSheet();
                ui.select('[name="name"]').value = 'Synthetic same intent';
            }
            await action();
            const first = await waitWorlds(f.core, 1);
            const before = await protectedFiles(f), pendingBefore = client.pendingCreation();
            enabled = false;
            if (mode !== 'none' && mode !== 'first-response-lost')
                await action();
            const worlds = await f.core.listWorlds();
            const edits = await changed(before);
            assert.deepEqual(edits, [], 'Existing World/card/chat/settings changed while retrying');
            return {
                mode,
                kind,
                firstWorlds: first.length,
                finalWorlds: worlds.length,
                uniqueWorldIds: worlds.map(w => w.world_id),
                faults,
                pendingBefore: pendingBefore ? {
                    kind: pendingBefore.kind,
                    hasOperationId: !!pendingBefore.operationId,
                } : null,
                postKeys: requests.filter(r => r.method === 'POST').map(r => r.key),
                existingFilesChanged: edits,
                notices: ui.messages,
                openings: openings.length,
                violation: worlds.length !== 1,
            };
        }
        // Capture injected UI errors to local diagnostics, not as unexplained harness failures.
        const originalError = console.error;
        console.error = (...args) => {
            if (String(args[0]).startsWith('[Nora UI]')) {
                report.faults.push({
                    label: args[0],
                    message: args[1]?.message,
                });
            } else
                originalError(...args);
        };
        for (const [mode, kind] of [
            [
                'none',
                'blank',
            ],
            [
                'first-response-lost',
                'blank',
            ],
            [
                'all-responses-lost',
                'blank',
            ],
            [
                'all-responses-lost',
                'import',
            ],
            [
                'all-responses-lost',
                'library',
            ],
            [
                'poll-response-lost',
                'blank',
            ],
            [
                'list-response-lost',
                'blank',
            ],
            [
                'character-refresh-failed',
                'blank',
            ],
            [
                'character-refresh-failed',
                'import',
            ],
            [
                'opening-failed',
                'blank',
            ],
            [
                'opening-failed',
                'import',
            ],
            [
                'opening-failed',
                'library',
            ],
        ])
            await record('creation:' + mode + ':' + kind, () => creation(mode, kind));
        for (const failure of [
            'lost-response',
            'invalid-file',
        ])
            await record('creation:batch:' + failure, async () => {
                const f = await setup('batch-' + failure), store = memory();
                let inject = true;
                const seedClient = createWorldCoreClient(() => ({ 'content-type': 'application/json' }), {
                    pendingStore: memory(),
                    pollIntervalMs: 1,
                });
                await seedClient.createBlank({
                    name: 'Existing story must remain',
                    idempotencyKey: 'browser:existing-' + failure,
                });
                const protectedBefore = await protectedFiles(f);
                const client = createWorldCoreClient(() => ({ 'content-type': 'application/json' }), {
                    pendingStore: store,
                    pollIntervalMs: 1,
                    fetchImpl: async (url, opts = {}) => {
                        const response = await globalThis.fetch(url, opts);
                        if (inject && failure === 'lost-response' && opts.body?.get?.('avatar')?.name === 'second.json' && response.ok) {
                            await response.text();
                            throw new TypeError('Injected second file response loss');
                        }
                        return response;
                    },
                });
                const runtime = createWorldCoreRuntime({ read: () => ({ metadata: {} }) }, { client });
                const ui = domFixture(), openings = [], busy = operations();
                const ctl = createWorldCreationController({
                    worldRuntime: runtime,
                    operations: busy,
                    select: ui.select,
                    openModal: ui.open,
                    closeModal: ui.close,
                    showToast: ui.toast,
                    normalizeError: e => e.message,
                    loadWorlds: () => runtime.refresh(),
                    refresh() {
                    },
                    openWorldById: async id => {
                        openings.push(id);
                        return true;
                    },
                });
                const card = name => new File([JSON.stringify({
                    name,
                    first_mes: 'Keep the independent story',
                })], name.toLowerCase() + '.json');
                const first = card('First'), second = failure === 'invalid-file' ? new File(['not valid JSON'], 'second.json') : card('Second'), third = card('Third');
                const perform = files => ctl.handleCharacterImport({
                    currentTarget: {
                        files,
                        value: 'selected',
                    },
                });
                await perform([
                    first,
                    second,
                    third,
                ]);
                assert.equal((await f.core.listWorlds()).length, failure === 'lost-response' ? 3 : 2, 'Only the prefix and accepted file may exist');
                assert.equal(busy.isBusy('world'), false);
                inject = false;
                if (failure === 'lost-response') {
                    await perform([
                        first,
                        new File(['different contents'], 'second.json'),
                        third,
                    ]);
                    assert.equal((await f.core.listWorlds()).length, 3, 'Changed input cannot overwrite an unknown intent');
                }
                await perform([
                    first,
                    failure === 'invalid-file' ? card('Second') : second,
                    third,
                ]);
                const worlds = await f.core.listWorlds();
                assert.equal(worlds.length, 4, 'One original and exactly three imported Worlds');
                assert.equal(new Set(worlds.map(w => w.world_id)).size, 4);
                assert.equal(openings.length, 1);
                assert.equal(busy.isBusy('world'), false);
                assert.deepEqual(await changed(protectedBefore), []);
                await perform([first]);
                assert.equal((await f.core.listWorlds()).length, 5, 'Successful completion permits an intentional new import of the same card');
                return {
                    worldsAfterRecovery: 4,
                    worldsAfterIntentionalNewImport: 5,
                    existingFilesChanged: [],
                    violation: false,
                };
            });
        await record('creation:pending-intent-cannot-be-overwritten', async () => {
            const f = await setup('pending-key-guard'), store = memory();
            let lose = true;
            const client = createWorldCoreClient(() => ({ 'content-type': 'application/json' }), {
                pendingStore: store,
                pollIntervalMs: 1,
                fetchImpl: async (url, opts = {}) => {
                    const response = await globalThis.fetch(url, opts);
                    if (lose && opts.method === 'POST') {
                        await response.text();
                        throw new TypeError('Injected response loss');
                    }
                    return response;
                },
            });
            await assert.rejects(client.createBlank({
                name: 'Original',
                idempotencyKey: 'browser:original-intent',
            }), TypeError);
            await waitWorlds(f.core, 1);
            lose = false;
            await assert.rejects(client.createBlank({
                name: 'Different input',
                idempotencyKey: 'browser:other-intent',
            }), { code: 'NORA_WORLD_CREATE_PENDING' });
            assert.equal(client.pendingCreation().idempotencyKey, 'browser:original-intent');
            const result = await client.createBlank({
                name: 'Original',
                idempotencyKey: 'browser:original-intent',
            });
            assert.ok(result.world.world_id);
            assert.equal((await f.core.listWorlds()).length, 1);
            assert.equal(client.pendingCreation(), null);
            return {
                worlds: 1,
                violation: false,
            };
        });
        // Resume persisted pending from the normal refresh path, without form resubmit.
        await record('creation:page-reload-after-committed-list-failure', async () => {
            const f = await setup('reload-after-list-failure'), store = memory();
            let loseList = true;
            const fetchImpl = async (url, opts = {}) => {
                const response = await globalThis.fetch(url, opts);
                if (loseList && url.endsWith('/worlds') && !opts.method) {
                    await response.text();
                    throw new TypeError('Injected list response loss after commit');
                }
                return response;
            };
            const client = createWorldCoreClient(() => ({ 'content-type': 'application/json' }), { pendingStore: store, pollIntervalMs: 1, fetchImpl });
            const runtime = createWorldCoreRuntime({ read: () => ({ metadata: {} }) }, { client });
            await assert.rejects(runtime.createBlank({ name: 'Retain completed operation', idempotencyKey: 'browser:committed-list-failure' }), error => Boolean(error.createdWorldId));
            assert.ok(client.pendingCreation(), 'Reload must not lose a committed result before the list can display it');
            const before = await protectedFiles(f);
            const pageClient = createWorldCoreClient(() => ({ 'content-type': 'application/json' }), { pendingStore: store, pollIntervalMs: 1, fetchImpl });
            const page = createWorldCoreRuntime({ read: () => ({ metadata: {} }) }, { client: pageClient });
            await assert.rejects(page.refresh(), TypeError);
            assert.ok(pageClient.pendingCreation());
            loseList = false;
            await page.refresh();
            for (let n = 0; n < 100 && page.status().operation.status !== 'COMPLETED'; n++) await new Promise(resolve => setTimeout(resolve, 5));
            assert.equal(page.status().operation.status, 'COMPLETED');
            assert.equal(pageClient.pendingCreation(), null);
            assert.equal((await f.core.listWorlds()).length, 1);
            assert.deepEqual(await changed(before), []);
            return { worlds: 1, existingFilesChanged: [], violation: false };
        });
        await record('creation:page-reload-resumes-original', async () => {
            const f = await setup('creation-reload'), store = memory();
            let lose = true;
            const client = createWorldCoreClient(() => ({ 'content-type': 'application/json' }), {
                pendingStore: store,
                pollIntervalMs: 1,
                fetchImpl: async (url, opts = {}) => {
                    const response = await globalThis.fetch(url, opts);
                    if (lose && opts.method === 'POST') {
                        await response.text();
                        throw new TypeError('Injected response loss');
                    }
                    return response;
                },
            });
            await assert.rejects(client.createBlank({
                name: 'Reload intent',
                idempotencyKey: 'browser:reload-test',
            }), TypeError);
            await waitWorlds(f.core, 1);
            lose = false;
            const resumedClient = createWorldCoreClient(() => ({ 'content-type': 'application/json' }), {
                pendingStore: store,
                pollIntervalMs: 1,
            });
            const runtime = createWorldCoreRuntime({ read: () => ({ metadata: {} }) }, { client: resumedClient });
            await runtime.refresh();
            for (let n = 0; n < 100; n++) {
                if (runtime.status().operation.status === 'COMPLETED')
                    break;
                await new Promise(r => setTimeout(r, 5));
            }
            assert.equal(runtime.status().operation.status, 'COMPLETED');
            assert.equal(resumedClient.pendingCreation(), null);
            assert.equal((await f.core.listWorlds()).length, 1);
            return {
                worlds: 1,
                postRequests: f.requests.filter(x => x.method === 'POST').length,
                status: runtime.status().operation.status,
                violation: false,
            };
        });
        console.error = originalError;
        async function deletionSetup(name, {
            world = true,
        } = {}) {
            const f = await setup('delete-' + name);
            f.card = {
                name: 'Isolated library original',
                description: 'Original approved contents',
                first_mes: 'Synthetic opening',
                character_book: {
                    name: 'Isolation lore',
                    entries: [{
                        uid: 0,
                        comment: 'Keep',
                        content: 'Synthetic world lore',
                        keys: [],
                        enabled: true,
                        constant: true,
                        extensions: {},
                    }],
                },
            };
            f.original = await f.core.saveLibraryCard({
                buffer: Buffer.from(JSON.stringify(f.card)),
                format: 'json',
            });
            if (world) {
                const client = createWorldCoreClient(() => ({ 'content-type': 'application/json' }), {
                    pendingStore: memory(),
                    pollIntervalMs: 1,
                });
                const created = await client.createFromLibrary({
                    avatar: f.original.avatar,
                    idempotencyKey: 'browser:' + name,
                });
                f.world = created.world;
                const another = await client.createFromLibrary({
                    avatar: f.original.avatar,
                    idempotencyKey: 'browser:second:' + name,
                });
                f.otherWorld = another.world;
            }
            f.item = (await f.core.listLibraryCards()).items.find(x => x.avatar === f.original.avatar);
            assert.ok(f.item?.revision);
            f.mcp = new NoraControlPlane({
                stateRoot: path.join(root, 'mcp-state'),
                userDataRoot: f.dirs.root,
            }, new NoraHttpClient(base, 5000));
            return f;
        }
        async function uiFor(f, confirm) {
            const ui = domFixture(), state = { characters: [] }, worlds = await f.core.listWorlds();
            async function getCharacters() {
                state.characters = [];
                for (const filename of await fs.readdir(f.dirs.characters)) {
                    if (!filename.endsWith('.png'))
                        continue;
                    const { card } = await codec.decode({
                        buffer: await fs.readFile(path.join(f.dirs.characters, filename)),
                        format: 'png',
                    });
                    state.characters.push({
                        ...card,
                        ...card.data,
                        avatar: filename,
                        data: card.data,
                    });
                }
            }
            const adapter = createStCardAdapter(() => ({
                getRequestHeaders: () => ({ 'content-type': 'application/json' }),
                getCharacters,
            }));
            const dialogs = {
                get version() {
                    return ui.version;
                },
                open: ui.open,
                close: ui.close,
                toast: ui.toast,
                normalizeError: e => e.message,
                confirm: async options => {
                    ui.confirmations.push(options);
                    if (confirm)
                        await confirm();
                    return true;
                },
            };
            const ctl = createCharacterController({
                cards: adapter,
                listLibraryCards: () => f.core.listLibraryCards(),
                operations: operations(),
                dialogs,
                readState: () => state,
                settings: () => ({}),
                characterField: (c, k) => c.data?.[k] || c[k] || '',
                characterCapabilities: () => ({
                    regexScripts: [],
                    helperScripts: [],
                }),
                resolveCharacter: async i => state.characters[i],
                worldbookEntries: b => Array.isArray(b?.entries) ? b.entries : Object.values(b?.entries || {}),
                select: ui.select,
                selectAll: ui.selectAll,
                escapeHtml: s => String(s || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
                icons: new Proxy({}, { get: () => '' }),
                reloadWorlds: async () => {
                },
                refresh() {
                },
                isCharacterInWorld: c => worlds.some(w => w.runtime_card?.binding?.avatar === c.avatar),
                createWorldFromCard() {
                },
            });
            await ctl.openLibrary();
            return {
                ui,
                state,
                ctl,
                adapter,
                async remove(avatar = f.original.avatar) {
                    const ix = state.characters.findIndex(c => c.avatar === avatar);
                    assert.ok(ix >= 0);
                    ctl.openSheet(ix, true);
                    const button = ui.select('[data-library-delete]');
                    assert.ok(button);
                    if (!button.disabled)
                        await button.fire('click');
                    return {
                        disabled: button.disabled,
                        confirmation: ui.confirmations.at(-1),
                        notices: ui.messages,
                    };
                },
            };
        }
        async function exists(p) {
            return !!await fs.stat(p).catch(() => null);
        }
        async function invokeMcp(f, revision = f.item.revision) {
            try {
                return {
                    ok: true,
                    result: await f.mcp.manageLibraryCard({
                        action: 'delete',
                        avatar: f.original.avatar,
                        revision,
                    }),
                };
            } catch (e) {
                return {
                    ok: false,
                    error: errorsToString(e),
                };
            }
        }
        const { zipSync, strToU8 } = require('fflate');
        const baseCard = { name: 'Format acceptance', description: 'Synthetic card', first_mes: 'Synthetic opening' };
        const normalizedCard = await codec.decode({ format: 'json', buffer: Buffer.from(JSON.stringify(baseCard)) });
        const formats = {
            json: Buffer.from(JSON.stringify(baseCard)), png: normalizedCard.runtimeCardBuffer,
            yaml: Buffer.from('name: Format acceptance\ncontext: Synthetic card\ngreeting: Synthetic opening\n'),
            yml: Buffer.from('name: Format acceptance\ncontext: Synthetic card\ngreeting: Synthetic opening\n'),
            charx: Buffer.from(zipSync({ 'card.json': strToU8(JSON.stringify(normalizedCard.card)) })),
            byaf: Buffer.from(zipSync({
                'manifest.json': strToU8(JSON.stringify({ characters: ['characters/card.json'], scenarios: ['scenarios/start.json'] })),
                'characters/card.json': strToU8(JSON.stringify({ schemaVersion: 1, id: 'card', name: 'Format acceptance', persona: 'Synthetic card', images: [] })),
                'scenarios/start.json': strToU8(JSON.stringify({ firstMessages: [{ characterID: 'card', text: 'Synthetic opening' }], messages: [] })),
            })),
        };
        for (const [format, bytes] of Object.entries(formats)) for (const route of ['ui-library', 'local-world', 'mcp-library', 'mcp-world']) {
            await record(`format:${route}:${format}`, async () => {
                const f = await deletionSetup(`format-${route}-${format}`), before = await protectedFiles(f);
                const uploadRoot = path.join(f.dirs.root, 'uploads'); await fs.mkdir(uploadRoot);
                const filename = `acceptance.${format.toUpperCase()}`, filePath = path.join(uploadRoot, filename);
                await fs.writeFile(filePath, bytes);
                const client = createWorldCoreClient(() => ({ 'content-type': 'application/json' }), { pendingStore: memory(), pollIntervalMs: 1 });
                const mcp = new NoraControlPlane({ uploadRoot, userDataRoot: f.dirs.root, stateRoot: path.join(f.dirs.root, 'mcp-state') }, new NoraHttpClient(base, 5000));
                const file = new File([bytes], filename);
                if (route === 'ui-library') {
                    const view = await uiFor(f);
                    await view.ui.select('[data-library-import]').fire('click');
                    const form = view.ui.select('[data-card-import-form]');
                    form.elements = { file: { files: [file] } };
                    await form.fire('submit');
                    assert.ok(f.requests.some(request => request.path === '/api/nora-worlds-v2/library/cards/import' && request.method === 'POST'));
                    assert.equal(view.ui.messages.some(notice => notice.tone === 'error'), false);
                } else if (route === 'local-world') {
                    const runtime = createWorldCoreRuntime({ read: () => ({ metadata: {} }) }, { client });
                    const view = domFixture(), opened = [];
                    const ctl = createWorldCreationController({ worldRuntime: runtime, operations: operations(), select: view.select,
                        openModal: view.open, closeModal: view.close, showToast: view.toast, normalizeError: error => error.message,
                        loadWorlds: () => runtime.refresh(), refresh() {}, openWorldById: async id => { opened.push(id); return true; } });
                    await ctl.handleCharacterImport({ currentTarget: { files: [file], value: 'selected' } });
                    assert.equal(opened.length, 1);
                    await waitWorlds(f.core, 3);
                }
                else if (route === 'mcp-library') await mcp.importLibraryCard(filePath);
                else {
                    await mcp.importWorld({ filePath, idempotencyKey: `mcp:${format}` });
                    await waitWorlds(f.core, 3);
                }
                assert.deepEqual(await changed(before), [], 'Existing chat, cards, worlds and settings must remain byte-identical');
                assert.equal((await f.core.listWorlds()).length, route.endsWith('world') ? 3 : 2);
                return { format, route, protectedFiles: Object.keys(before).length, violation: false };
            });
        }
        for (const format of Object.keys(formats)) await record(`format:invalid-content:${format}`, async () => {
            const f = await deletionSetup(`invalid-format-${format}`), before = await protectedFiles(f);
            await assert.rejects((await uiFor(f)).adapter.importLibraryCard(new File(['not a card'], `bad.${format}`)));
            const client = createWorldCoreClient(() => ({ 'content-type': 'application/json' }), { pendingStore: memory(), pollIntervalMs: 1 });
            await assert.rejects(client.importCard(new File(['not a card'], `bad.${format}`), { idempotencyKey: `invalid:${format}` }));
            assert.deepEqual(await changed(before), []);
            assert.equal((await f.core.listWorlds()).filter(world => world.lifecycle.status === 'READY').length, 2);
            return { format, rejected: true, violation: false };
        });
        await record('format:entry-size-limits-and-empty-files', async () => {
            const f = await deletionSetup('size-limits'), before = await protectedFiles(f), adapter = (await uiFor(f)).adapter;
            const requests = f.requests.length;
            await assert.rejects(adapter.importLibraryCard({ name: 'oversize.json', size: 32 * 1024 * 1024 + 1 }), /32 MB/);
            await assert.rejects(adapter.importLibraryCard(new File([], 'empty.json')));
            const filePath = path.join(f.dirs.root, 'large.json');
            const handle = await fs.open(filePath, 'w');
            await handle.truncate(64 * 1024 * 1024 + 1); await handle.close();
            const mcp = new NoraControlPlane({ uploadRoot: f.dirs.root }, new NoraHttpClient(base, 5000));
            await assert.rejects(mcp.importLibraryCard(filePath), { code: 'NORA_IMPORT_FILE_INVALID' });
            await fs.truncate(filePath, 0);
            await assert.rejects(mcp.importWorld({ filePath, idempotencyKey: 'empty-card' }), { code: 'NORA_IMPORT_FILE_INVALID' });
            assert.equal(f.requests.length, requests, 'Entry rejection occurs before HTTP mutation');
            for (const [route, limit] of [['ui', 32], ['mcp', 64], ['local', 100]]) {
                const bytes = Buffer.alloc(limit * 1024 * 1024, 0x20);
                Buffer.from(JSON.stringify(baseCard)).copy(bytes);
                if (route === 'ui') await adapter.importLibraryCard(new File([bytes], 'limit.json'));
                else if (route === 'mcp') {
                    await fs.writeFile(filePath, bytes);
                    await mcp.importLibraryCard(filePath);
                } else {
                    const client = createWorldCoreClient(() => ({ 'content-type': 'application/json' }), { pendingStore: memory(), pollIntervalMs: 1 });
                    await client.importCard(new File([bytes], 'limit.json'), { idempotencyKey: 'local:size-limit' });
                    const { stageCardBuffer } = await mod(engine + 'src/nora-world-core/st-import-staging.js');
                    await assert.rejects(stageCardBuffer({ buffer: Buffer.alloc(100 * 1024 * 1024 + 1), originalName: 'too-large.json',
                        sourceType: 'character-card', idempotencyKey: 'local:too-large', stagingRoot: path.join(f.dirs.root, 'staging') }), { code: 'NORA_CARD_STAGING_INVALID' });
                }
            }
            assert.deepEqual(await changed(before), []);
            return { exactLimitsMiB: [32, 64, 100], oversizeRejected: true, emptyRejected: true, violation: false };
        });
        await record('format:WebP-is-not-a-full-card', async () => {
            const f = await deletionSetup('reject-webp'), before = await protectedFiles(f);
            await assert.rejects((await uiFor(f)).adapter.importLibraryCard(new File([formats.png], 'card.webp')));
            const filePath = path.join(f.dirs.root, 'card.webp'); await fs.writeFile(filePath, formats.png);
            const mcp = new NoraControlPlane({ uploadRoot: f.dirs.root }, new NoraHttpClient(base, 5000));
            await assert.rejects(mcp.importLibraryCard(filePath), { code: 'NORA_IMPORT_FILE_INVALID' });
            assert.deepEqual(await changed(before), []);
            return { rejected: true, violation: false };
        });
        for (const route of [
            'ui',
            'mcp',
        ]) {
            await record('delete:' + route + ':independent-original', async () => {
                const f = await deletionSetup(route + '-normal'), snap = await protectedFiles(f);
                delete snap[path.join(f.dirs.characters, f.original.avatar)];
                const outcome = route === 'ui' ? await (await uiFor(f)).remove() : await invokeMcp(f);
                assert.equal(await exists(path.join(f.dirs.characters, f.original.avatar)), false);
                const edits = await changed(snap);
                assert.deepEqual(edits, []);
                assert.equal((await f.core.getWorld(f.world.world_id)).lifecycle.status, 'READY');
                return {
                    originalDeleted: true,
                    worldAndChatChanges: edits,
                    archiveRetained: (await fs.readdir(path.join(f.dirs.root, 'nora-world-core/library-cards/sources'))).length > 0,
                    violation: false,
                    outcome,
                };
            });
            await record('delete:' + route + ':library-card-with-legacy-chat', async () => {
                const f = await deletionSetup(route + '-legacy-chat'), chat = path.join(f.dirs.chats, path.parse(f.original.avatar).name, 'legacy.jsonl');
                await fs.mkdir(path.dirname(chat), { recursive: true });
                await fs.writeFile(chat, 'Synthetic legacy chat: must not be silently lost');
                const worldBefore = await f.core.getWorld(f.world.world_id), runtime = path.join(f.dirs.characters, f.world.runtime_card.binding.avatar), runtimeHash = sha(await fs.readFile(runtime));
                const outcome = route === 'ui' ? await (await uiFor(f)).remove() : await invokeMcp(f);
                assert.equal(await exists(chat), true, 'Both entry points must retain existing chats');
                const originalRemains = await exists(path.join(f.dirs.characters, f.original.avatar)), chatRemains = await exists(chat);
                assert.deepEqual(await f.core.getWorld(f.world.world_id), worldBefore);
                assert.equal(sha(await fs.readFile(runtime)), runtimeHash);
                return {
                    originalRemains,
                    legacyChatRemains: chatRemains,
                    worldUnchanged: true,
                    violation: false,
                    scope: 'Both entry points retain referenced cards and their chats',
                    outcome,
                };
            });
            await record('delete:' + route + ':changed-after-inspection', async () => {
                const f = await deletionSetup(route + '-changed'), target = path.join(f.dirs.characters, f.original.avatar);
                const changedCard = {
                    ...f.card,
                    description: 'NEW contents saved after old inspection; NOT approved for deletion',
                };
                const changedBytes = (await codec.decode({
                    buffer: Buffer.from(JSON.stringify(changedCard)),
                    format: 'json',
                })).runtimeCardBuffer;
                const protectedBefore = await protectedFiles(f);
                delete protectedBefore[target];
                let outcome;
                if (route === 'ui') {
                    const ui = await uiFor(f, () => fs.writeFile(target, changedBytes));
                    outcome = await ui.remove();
                } else {
                    await fs.writeFile(target, changedBytes);
                    outcome = await invokeMcp(f);
                }
                const retained = await exists(target);
                assert.deepEqual(await changed(protectedBefore), []);
                if (retained)
                    assert.equal(sha(await fs.readFile(target)), sha(changedBytes));
                return {
                    changedContentsRetained: retained,
                    oldRevision: f.item.revision,
                    violation: !retained,
                    outcome,
                };
            });
            await record('delete:' + route + ':group-reference', async () => {
                const f = await deletionSetup(route + '-group'), group = path.join(f.dirs.groups, 'isolation-group.json');
                await fs.writeFile(group, JSON.stringify({
                    id: 'isolation-group',
                    name: 'Group must retain its member',
                    members: [f.original.avatar],
                }));
                const before = sha(await fs.readFile(group)), protectedBefore = await protectedFiles(f);
                delete protectedBefore[path.join(f.dirs.characters, f.original.avatar)];
                const outcome = route === 'ui' ? await (await uiFor(f)).remove() : await invokeMcp(f);
                assert.equal(sha(await fs.readFile(group)), before);
                const retained = await exists(path.join(f.dirs.characters, f.original.avatar));
                assert.deepEqual(await changed(protectedBefore), []);
                return {
                    referencedCardRetained: retained,
                    groupFileUnchanged: true,
                    violation: !retained,
                    outcome,
                };
            });
            for (const reference of [
                'settings',
                'unreadable-group',
            ])
                await record('delete:' + route + ':' + reference, async () => {
                    const f = await deletionSetup(route + '-' + reference);
                    if (reference === 'settings')
                        await fs.writeFile(path.join(f.dirs.root, 'settings.json'), JSON.stringify({
                            isolationSentinel: 'keep',
                            selected_character: f.original.avatar,
                        }));
                    else
                        await fs.writeFile(path.join(f.dirs.groups, 'broken.json'), 'Unreadable reference data must not mean no references');
                    const before = await protectedFiles(f);
                    const outcome = route === 'ui' ? await (await uiFor(f)).remove() : await invokeMcp(f);
                    assert.equal(await exists(path.join(f.dirs.characters, f.original.avatar)), true);
                    assert.deepEqual(await changed(before), []);
                    if (route === 'ui')
                        assert.ok(!outcome.notices.some(message => message === '角色卡已删除\u3002'));
                    return {
                        referencedCardRetained: true,
                        existingFilesChanged: [],
                        violation: false,
                    };
                });
            await record('delete:' + route + ':runtime-card-protected', async () => {
                const f = await deletionSetup(route + '-runtime'), target = f.world.runtime_card.binding.avatar, snap = await protectedFiles(f);
                let outcome;
                if (route === 'ui') {
                    const u = await uiFor(f);
                    const selection = await u.remove(target);
                    assert.equal(selection.disabled, true, 'World runtime delete button must be unavailable');
                    try {
                        await u.adapter.deleteCharacterCards({
                            avatars: [target],
                            revisions: { [target]: sha(await fs.readFile(path.join(f.dirs.characters, target))) },
                        });
                        outcome = { ok: true };
                    } catch (e) {
                        outcome = {
                            ok: false,
                            error: errorsToString(e),
                        };
                    }
                } else {
                    try {
                        await f.mcp.manageLibraryCard({
                            action: 'delete',
                            avatar: target,
                            revision: sha(await fs.readFile(path.join(f.dirs.characters, target))),
                        });
                        outcome = { ok: true };
                    } catch (e) {
                        outcome = {
                            ok: false,
                            error: errorsToString(e),
                        };
                    }
                }
                assert.equal(outcome.ok, false);
                assert.deepEqual(await changed(snap), []);
                return {
                    runtimeAndWorldAndChatRetained: true,
                    violation: false,
                    outcome,
                };
            });
        }
        clearNoraWorldCoreCache();
    } catch (error) {
        report.harnessErrors.push({
            name: 'setup-or-top-level',
            ...errorsToString(error),
        });
        console.error(error.stack);
    } finally {
        console.error = oldConsoleError;
        characterModule?.diskCache.dispose();
        if (server) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
        globalThis.fetch = nativeFetch;
        globalThis.FormData = NativeFormData;
        globalThis.DATA_ROOT = oldDataRoot;
        process.chdir(oldCwd);
        report.summary = {
            cases: report.cases.length,
            violations: report.cases.filter(x => x.violation).map(x => x.name),
            harnessErrors: report.harnessErrors.length,
        };
        t.diagnostic(JSON.stringify(report.summary));
        if (root.startsWith(path.join(os.tmpdir(), 'nora-suspects-runtime-')) && await fs.readFile(path.join(root, 'ISOLATED_TEST_ONLY'), 'utf8') === 'Nora controlled fault-injection and deletion audit')
            await fs.rm(root, {
                recursive: true,
                force: true,
            });
        await fs.rm(out, {
            recursive: true,
            force: true,
        });
        assert.deepEqual(report.harnessErrors, []);
        assert.deepEqual(report.summary.violations, []);
    }
});
