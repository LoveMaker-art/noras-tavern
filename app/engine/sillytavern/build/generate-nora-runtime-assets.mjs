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
const managedExtensionsDirectory = path.resolve(root, '../../native-extensions');
// Liveware only treats known static suffixes as CDN-cacheable. The payload is
// JSON data, but it deliberately uses a .js suffix so the content-addressed
// startup asset is cached instead of being rewritten to `no-store` in transit.
const inlineModulesPath = path.join(outputDirectory, 'inline-modules.js');
const legacyBundlePath = path.join(outputDirectory, 'legacy.js');
const moduleShimsPath = path.join(outputDirectory, 'module-shims.js');
const moduleShimsSourcePath = path.join(root, 'node_modules', 'es-module-shims', 'dist', 'es-module-shims.js');
const localOrigin = 'https://nora.local';
const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

export const CORE_ENTRY_URLS = [
    '/script.js',
    '/scripts/user.js',
    '/scripts/nora-compat/interaction-bridge.js',
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

function importSpecifier(item, source) {
    if (typeof item.n === 'string') return item.n;
    if (item.d < 0) return null;
    const raw = source.slice(item.s, item.e);
    if (!raw.startsWith('`') || !raw.endsWith('`') || raw.includes('${')) return null;
    return raw.slice(1, -1).replace(/\\([\\`$])/g, '$1');
}

export async function collectManagedExtensionCoreBridges(
    extensionsDirectory = managedExtensionsDirectory,
    coreDirectory = publicDirectory,
) {
    await init;
    const bridges = new Set();
    const extensionEntries = await fs.readdir(extensionsDirectory, { withFileTypes: true });

    for (const entry of extensionEntries) {
        if (!entry.isDirectory()) continue;
        const extensionDirectory = path.join(extensionsDirectory, entry.name);
        const manifestPath = path.join(extensionDirectory, 'manifest.json');
        let manifest;
        try {
            manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw error;
        }
        if (typeof manifest.js !== 'string' || !manifest.js.trim()) continue;

        const extensionRootUrl = `/scripts/extensions/third-party/${entry.name}/`;
        const resolvedExtensionDirectory = path.resolve(extensionDirectory);
        const visited = new Set();

        const visit = async (relativePath, virtualUrl) => {
            const normalizedRelativePath = decodeURIComponent(relativePath).replace(/^\/+/, '');
            const absolutePath = path.resolve(resolvedExtensionDirectory, normalizedRelativePath);
            if (!absolutePath.startsWith(`${resolvedExtensionDirectory}${path.sep}`)) {
                throw new Error(`Managed extension import escapes its source directory: ${entry.name}/${relativePath}`);
            }
            if (visited.has(absolutePath)) return;
            visited.add(absolutePath);

            const source = await fs.readFile(absolutePath, 'utf8');
            const [imports] = parse(source);
            for (const item of imports) {
                const dependency = resolveLocalModule(importSpecifier(item, source), virtualUrl);
                if (!dependency) continue;
                const dependencyUrl = new URL(dependency, localOrigin);
                if (dependencyUrl.pathname.startsWith(extensionRootUrl)) {
                    const extensionRelativePath = dependencyUrl.pathname.slice(extensionRootUrl.length);
                    await visit(extensionRelativePath, dependency);
                    continue;
                }
                try {
                    await fs.access(resolveModuleFile(dependency, coreDirectory));
                    bridges.add(dependency.replace(/^\/+/, ''));
                } catch (error) {
                    if (error?.code !== 'ENOENT') throw error;
                }
            }
        };

        const entryRelativePath = manifest.js.replace(/^\/+/, '');
        await visit(entryRelativePath, `${extensionRootUrl}${entryRelativePath}`);
    }

    return [...bridges].sort();
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
        const normalized = source
            .replace(/^\/\/# sourceMappingURL=.*$/gm, '')
            .replace(/[ \t]+$/gm, '')
            .trimEnd();
        return `/* ${relativePath} */\n${normalized}`;
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

export function attachExtensionCoreBridges(manifest, modulePaths) {
    const bridges = [...new Set((modulePaths || []).map(value => String(value || '').replace(/^\/+/, '')).filter(Boolean))].sort();
    manifest.extensionCoreBridges = bridges;
    manifest.network ??= [];
    for (const modulePath of bridges) {
        if (manifest.modules?.[modulePath] || manifest.compiled?.[modulePath] || manifest.network.includes(modulePath)) continue;
        manifest.network.push(modulePath);
    }
    manifest.network.sort();
    return manifest;
}

export function attachLegacyAsset(manifest, assetPath) {
    const normalizedAssetPath = String(assetPath || '').replace(/^\/+/, '');
    if (!normalizedAssetPath || normalizedAssetPath.includes('..')) throw new TypeError('Legacy asset path is invalid.');
    manifest.legacy = normalizedAssetPath;
    return manifest;
}

export async function buildRuntimeManifest(
    entryUrls = CORE_ENTRY_URLS,
    rootDirectory = publicDirectory,
    extensionsDirectory = managedExtensionsDirectory,
) {
    const [manifest, extensionCoreBridges] = await Promise.all([
        buildInlineModuleManifest(entryUrls, rootDirectory),
        collectManagedExtensionCoreBridges(extensionsDirectory, rootDirectory),
    ]);
    attachCompiledModule(manifest, 'lib-core.js', 'dist/nora/lib-core.js');
    attachExtensionCoreBridges(manifest, extensionCoreBridges);
    attachLegacyAsset(manifest, 'dist/nora/legacy.js');
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
    const [inlineManifest, legacyBundle, moduleShims] = await Promise.all([
        buildRuntimeManifest(),
        buildLegacyBundle(),
        fs.readFile(moduleShimsSourcePath),
    ]);
    await fs.mkdir(outputDirectory, { recursive: true });
    const bundleNames = ['entry.js', 'lib-core.js'];
    const bundleEntries = await Promise.all(bundleNames.map(async (name) => {
        const filePath = path.join(outputDirectory, name);
        return [filePath, await fs.readFile(filePath)];
    }));
    await Promise.all([
        writePrecompressedAsset(inlineModulesPath, `${JSON.stringify(inlineManifest)}\n`),
        writePrecompressedAsset(legacyBundlePath, legacyBundle),
        writePrecompressedAsset(moduleShimsPath, moduleShims),
        ...bundleEntries.map(([filePath, content]) => writePrecompressedAsset(filePath, content)),
    ]);
    console.log(`nora-inline-modules=${Object.keys(inlineManifest.modules).length}`);
    console.log(`nora-network-modules=${inlineManifest.network.length}`);
    console.log(`nora-legacy-scripts=${LEGACY_SCRIPT_PATHS.length}`);
}
