import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { NoraWorldCoreError } from './errors.js';
import { stableStringify } from './domain.js';
import { writeJsonAtomic } from './atomic-json.js';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = message => { throw new NoraWorldCoreError('NORA_WORLD_INVALID', message); };

function convertBook(input, convert) {
    const entries = Array.isArray(input.entries) ? input.entries : Object.values(input.entries);
    const ids = new Set();
    for (const [index, entry] of entries.entries()) {
        if (!entry || typeof entry !== 'object' || typeof entry.content !== 'string') invalid('Invalid Worldbook entry.');
        const id = String(entry.id ?? index);
        if (ids.has(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) invalid('Worldbook entry IDs must be unique.');
        ids.add(id);
    }
    return convert({ ...input, entries });
}

async function readFile(root, name) {
    if (typeof name !== 'string' || !name || /[/\\]/.test(name) || name.includes('\0') || path.basename(name) !== name || name === '.' || name === '..') invalid('Invalid library filename.');
    const file = path.join(root, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) invalid('Unsafe or oversized library file.');
    return fs.readFile(file);
}

export function createWorldbookLibrary({ roots, cardCodec, convertEmbeddedBook }) {
    async function read(source) {
        if (!source || !['book', 'card'].includes(source.kind) || typeof source.name !== 'string' || !source.name) invalid('Invalid library source.');
        source = { kind: source.kind, name: source.name };
        let book;
        let name;
        let sourceName;
        if (source?.kind === 'book') {
            book = JSON.parse((await readFile(roots.worlds, `${source.name}.json`)).toString());
            name = book.name || book.originalData?.name || source.name;
        } else if (source?.kind === 'card') {
            const { card } = await cardCodec.decode({ buffer: await readFile(roots.characters, source.name), format: 'png' });
            const data = card.data || card;
            sourceName = data.name;
            const embedded = data.character_book;
            if (!embedded?.entries) invalid('This card has no embedded Worldbook.');
            book = convertBook(embedded, convertEmbeddedBook);
            name = embedded.name || data.name;
        } else invalid('Invalid library source.');
        if (!book || typeof book.entries !== 'object' || !book.entries || Array.isArray(book.entries)
            || Object.values(book.entries).some(entry => !entry || typeof entry !== 'object' || typeof entry.content !== 'string')) invalid('Invalid Worldbook entries.');
        return { source, source_name: sourceName || name, source_key: `library:${digest(source)}`, name, book, revision: digest(book), count: Object.keys(book.entries).length };
    }

    async function list(worlds) {
        const owned = new Set(worlds.flatMap(world => world.knowledge.filter(item => item.ownership === 'owned').map(item => item.binding.name)));
        const runtimeCards = new Set(worlds.map(world => world.runtime_card?.binding?.avatar));
        const items = [];
        const warnings = [];
        const add = async source => {
            try {
                const item = await read(source);
                if (item.book.extensions?.nora_resource?.world_id) return;
                items.push({ source, source_name: item.source_name, source_key: item.source_key, name: item.name, revision: item.revision, count: item.count });
            } catch (error) { warnings.push({ source, message: error.message }); }
        };
        for (const filename of await fs.readdir(roots.worlds)) {
            if (filename.endsWith('.json') && !owned.has(filename.slice(0, -5))) await add({ kind: 'book', name: filename.slice(0, -5) });
        }
        for (const filename of await fs.readdir(roots.characters)) {
            if (!filename.endsWith('.png') || runtimeCards.has(filename) || filename.startsWith('Nora_Blank_World--')) continue;
            try {
                const { card } = await cardCodec.decode({ buffer: await readFile(roots.characters, filename), format: 'png' });
                if ((card.data || card).character_book?.entries) await add({ kind: 'card', name: filename });
            } catch (error) { warnings.push({ source: { kind: 'card', name: filename }, message: error.message }); }
        }
        return { items, warnings };
    }

    async function prepare(world, input) {
        const item = await read(input.source);
        if (input.source_revision !== item.revision) throw new NoraWorldCoreError('NORA_WORLD_REVISION_CONFLICT', 'Library Worldbook changed; reopen its preview.');
        const sourceKey = `library:${digest(item.source)}`;
        const existing = world.knowledge.find(resource => resource.source_key === sourceKey
            || (item.source.kind === 'book' && resource.binding.name === item.source.name));
        if (existing) return { resource: existing, reused: true, abort: async () => {} };
        const name = `nora-library-${crypto.randomUUID()}`;
        const target = path.join(roots.worlds, `${name}.json`);
        const book = structuredClone(item.book);
        book.extensions = { ...book.extensions, nora_resource: { schema: 1, kind: 'library-copy', world_id: world.world_id, source: item.source } };
        await fs.writeFile(target, JSON.stringify(book, null, 4), { flag: 'wx', mode: 0o600 });
        return { resource: { resource_id: `resource:${crypto.randomUUID()}`, source_key: sourceKey, engine: 'sillytavern',
            ownership: 'owned', binding: { name, display_name: item.name } }, book, reused: false, abort: () => fs.unlink(target) };
    }
    async function save(name, input) {
        if (typeof name !== 'string' || !name.trim() || name.length > 200) invalid('Invalid Worldbook name.');
        if (!input || typeof input !== 'object' || !input.entries || typeof input.entries !== 'object') invalid('Invalid Worldbook JSON.');
        if (Buffer.byteLength(JSON.stringify(input)) > 32 * 1024 * 1024) invalid('Worldbook exceeds 32 MB.');
        const book = Array.isArray(input.entries) ? convertBook(input, convertEmbeddedBook) : structuredClone(input);
        if (Object.values(book.entries).some(entry => !entry || typeof entry.content !== 'string')) invalid('Invalid Worldbook entries.');
        if (Object.keys(book.entries).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) invalid('Invalid Worldbook entry ID.');
        book.name = name.trim();
        if (book.extensions) delete book.extensions.nora_resource;
        for (const file of await fs.readdir(roots.worlds)) {
            if (!file.endsWith('.json')) continue;
            let stored;
            try { stored = await read({ kind: 'book', name: file.slice(0, -5) }); }
            catch { continue; }
            if (stored.book.extensions?.nora_resource?.world_id || stored.name !== book.name) continue;
            if (stableStringify(stored.book) !== stableStringify(book)) invalid('库中已有同名世界书，请更换名称后另存；不会覆盖原世界书。');
            return { source: stored.source, name: stored.name, reused: true };
        }
        const filename = `library-${crypto.randomUUID()}`;
        await writeJsonAtomic(path.join(roots.worlds, `${filename}.json`), book);
        return { source: { kind: 'book', name: filename }, name: book.name };
    }
    return { list, read, prepare, save };
}
