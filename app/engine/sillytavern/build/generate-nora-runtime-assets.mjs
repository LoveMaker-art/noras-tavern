import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';

import { init, parse } from 'es-module-lexer';
import { minify } from 'terser';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDirectory = path.join(root, 'public');
const outputDirectory = path.join(publicDirectory, 'dist', 'nora');
const inlineModulesPath = path.join(outputDirectory, 'inline-modules.json');
const legacyBundlePath = path.join(outputDirectory, 'legacy.js');
const localOrigin = 'https://nora.local';
const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

const CORE_ENTRY_URLS = [
    '/script.js',
    '/lib/structured-clone/monkey-patch.js',
    '/lib/swiped-events.js',
    '/lib/eventemitter.js',
    '/scripts/extensions/regex/index.js',
];

// Webpack compiles this source entry because it contains bare package imports.
const CORE_LIBRARY_URL = '/lib-core.js';
const EXTERNAL_MODULE_URLS = new Set(['/lib.js', CORE_LIBRARY_URL]);

const LEGACY_SCRIPT_PATHS = [
    'lib/polyfill.js',
    'lib/jquery-3.5.1.min.js',
    'lib/jquery-ui.min.js',
    'lib/jquery.transit.min.js',
    'lib/jquery-cookie-1.4.1.min.js',
    'lib/jquery.ui.touch-punch.min.js',
    'lib/toastr.min.js',
    'lib/select2.min.js',
    'lib/select2-search-placeholder.js',
    'lib/pagination.js',
];

function resolveLocalModule(specifier, parentUrl) {
    if (!specifier || /^(?:[a-z]+:)?\/\//i.test(specifier) || specifier.startsWith('data:')) return null;
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;

    const resolved = new URL(specifier, new URL(parentUrl, localOrigin));
    if (resolved.origin !== localOrigin) return null;
    if (!['.js', '.mjs'].includes(path.posix.extname(resolved.pathname))) return null;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

function resolveModuleFile(moduleUrl, rootDirectory) {
    const parsedUrl = new URL(moduleUrl, localOrigin);
    const relativePath = decodeURIComponent(parsedUrl.pathname).replace(/^\/+/, '');
    const resolvedRoot = path.resolve(rootDirectory);
    const absolutePath = path.resolve(resolvedRoot, relativePath);
    if (!absolutePath.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error(`Module path escapes public directory: ${moduleUrl}`);
    }
    return absolutePath;
}

async function loadStaticModuleGraph(entryUrls, rootDirectory) {
    await init;
    const modules = new Map();

    async function visit(moduleUrl) {
        if (modules.has(moduleUrl) || EXTERNAL_MODULE_URLS.has(moduleUrl)) return;

        const source = await fs.readFile(resolveModuleFile(moduleUrl, rootDirectory), 'utf8');
        const [imports, exports] = parse(source);
        modules.set(moduleUrl, { source, imports, exports });

        for (const item of imports) {
            if (item.d !== -1) continue;
            const dependency = resolveLocalModule(item.n, moduleUrl);
            if (dependency) await visit(dependency);
        }
    }

    for (const entryUrl of entryUrls) await visit(entryUrl);
    return modules;
}

function toModuleSpecifier(moduleUrl) {
    return `nora-module/${moduleUrl.replace(/^\/+/, '')}`;
}

function toRuntimeDependency(moduleUrl) {
    return moduleUrl === '/lib.js' ? CORE_LIBRARY_URL : moduleUrl;
}

function rewriteLocalImports(moduleUrl, source, imports) {
    const edits = [];
    for (const item of imports) {
        const dependency = resolveLocalModule(item.n, moduleUrl);
        if (!dependency) continue;
        const runtimeDependency = toRuntimeDependency(dependency);
        edits.push({
            start: item.s,
            end: item.e,
            replacement: item.d === -1
                ? toModuleSpecifier(runtimeDependency)
                : JSON.stringify(toModuleSpecifier(runtimeDependency)),
        });
    }

    let rewritten = source;
    for (const edit of edits.sort((left, right) => right.start - left.start)) {
        rewritten = `${rewritten.slice(0, edit.start)}${edit.replacement}${rewritten.slice(edit.end)}`;
    }
    return rewritten;
}

async function minifyModule(moduleUrl, source) {
    const result = await minify(source, {
        module: true,
        compress: { passes: 2 },
        mangle: true,
        format: { comments: false },
    });
    if (typeof result.code !== 'string') {
        throw new Error(`Failed to minify runtime module: ${moduleUrl}`);
    }
    return `${result.code}\n//# sourceURL=nora-inline:${moduleUrl}\n`;
}

export async function collectStaticModuleGraph(entryUrls, rootDirectory = publicDirectory) {
    const entries = Array.isArray(entryUrls) ? entryUrls : [entryUrls];
    const modules = await loadStaticModuleGraph(entries, rootDirectory);
    return [...modules.keys()].map(value => value.replace(/^\/+/, '')).sort();
}

export async function buildInlineModuleManifest(entryUrls, rootDirectory = publicDirectory) {
    const entries = Array.isArray(entryUrls) ? entryUrls : [entryUrls];
    const modules = await loadStaticModuleGraph(entries, rootDirectory);
    const networkModules = new Set();
    for (const [moduleUrl, { imports }] of modules) {
        for (const item of imports) {
            const dependency = resolveLocalModule(item.n, moduleUrl);
            const runtimeDependency = dependency && toRuntimeDependency(dependency);
            if (runtimeDependency && !modules.has(runtimeDependency)) networkModules.add(runtimeDependency.replace(/^\/+/, ''));
        }
    }
    const sortedModules = [...modules.entries()].sort(([left], [right]) => left.localeCompare(right));
    const inlineModules = Object.fromEntries(await Promise.all(sortedModules
        .map(async ([moduleUrl, { source, imports }]) => {
            const rewritten = rewriteLocalImports(moduleUrl, source, imports);
            const compressed = await minifyModule(moduleUrl, rewritten);
            const dataUrl = `data:text/javascript;base64,${Buffer.from(compressed).toString('base64')}`;
            return [moduleUrl.replace(/^\/+/, ''), dataUrl];
        })));
    const aliases = Object.fromEntries(sortedModules.map(([moduleUrl, { exports }]) => {
        const specifier = toModuleSpecifier(moduleUrl);
        const defaultReExport = exports.some(item => item.n === 'default')
            ? `\nexport { default } from ${JSON.stringify(specifier)};`
            : '';
        const proxy = `export * from ${JSON.stringify(specifier)};${defaultReExport}\n`;
        return [
            moduleUrl.replace(/^\/+/, ''),
            `data:text/javascript;base64,${Buffer.from(proxy).toString('base64')}`,
        ];
    }));
    return {
        modules: inlineModules,
        aliases,
        network: [...networkModules].sort(),
    };
}

export async function buildLegacyBundle(rootDirectory = publicDirectory) {
    const sources = await Promise.all(LEGACY_SCRIPT_PATHS.map(async (relativePath) => {
        const source = await fs.readFile(path.join(rootDirectory, relativePath), 'utf8');
        return `/* ${relativePath} */\n${source.replace(/^\/\/# sourceMappingURL=.*$/gm, '')}`;
    }));
    return `${sources.join('\n;\n')}\n`;
}

export function attachCompiledModule(manifest, modulePath, assetPath) {
    const normalizedPath = String(modulePath || '').replace(/^\/+/, '');
    if (!normalizedPath) throw new TypeError('Compiled module path is required.');
    const normalizedAssetPath = String(assetPath || '').replace(/^\/+/, '');
    if (!normalizedAssetPath || normalizedAssetPath.includes('..')) throw new TypeError('Compiled module asset path is invalid.');
    manifest.compiled ??= {};
    manifest.compiled[normalizedPath] = normalizedAssetPath;
    manifest.network = (manifest.network || []).filter(value => value !== normalizedPath);
    return manifest;
}

export function attachLegacyAsset(manifest, assetPath) {
    const normalizedAssetPath = String(assetPath || '').replace(/^\/+/, '');
    if (!normalizedAssetPath || normalizedAssetPath.includes('..')) throw new TypeError('Legacy asset path is invalid.');
    manifest.legacy = normalizedAssetPath;
    return manifest;
}

export async function writePrecompressedAsset(filePath, content) {
    const source = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const [brotli, gzipped] = await Promise.all([
        compressBrotli(source, {
            params: {
                [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
            },
        }),
        compressGzip(source, { level: 9 }),
    ]);
    await Promise.all([
        fs.writeFile(filePath, source),
        fs.writeFile(`${filePath}.br`, brotli),
        fs.writeFile(`${filePath}.gz`, gzipped),
    ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [inlineManifest, legacyBundle] = await Promise.all([
        buildInlineModuleManifest(CORE_ENTRY_URLS),
        buildLegacyBundle(),
    ]);
    attachCompiledModule(inlineManifest, 'lib-core.js', 'dist/nora/lib-core.js');
    attachLegacyAsset(inlineManifest, 'dist/nora/legacy.js');
    await fs.mkdir(outputDirectory, { recursive: true });
    const bundleNames = ['entry.js', 'lib-core.js', 'lib.js'];
    const bundleEntries = await Promise.all(bundleNames.map(async (name) => {
        const filePath = path.join(outputDirectory, name);
        return [filePath, await fs.readFile(filePath)];
    }));
    await Promise.all([
        writePrecompressedAsset(inlineModulesPath, `${JSON.stringify(inlineManifest)}\n`),
        writePrecompressedAsset(legacyBundlePath, legacyBundle),
        ...bundleEntries.map(([filePath, content]) => writePrecompressedAsset(filePath, content)),
    ]);
    console.log(`nora-inline-modules=${Object.keys(inlineManifest.modules).length}`);
    console.log(`nora-network-modules=${inlineManifest.network.length}`);
    console.log(`nora-legacy-scripts=${LEGACY_SCRIPT_PATHS.length}`);
}
