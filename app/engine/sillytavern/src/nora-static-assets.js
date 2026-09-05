import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { renderLocaleBootstrap } from './nora-locale-bootstrap.js';

export const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const REVALIDATED_ASSET_CACHE_CONTROL = 'no-cache, must-revalidate';
export const NO_STORE_CACHE_CONTROL = 'no-store';
export const NORA_ASSET_SCHEMA_VERSION = 3;
export const NORA_ASSET_HASH_LENGTH = 32;
export const NORA_ASSET_NAMESPACE = Object.freeze({
    compatibility: 'compat-runtime',
    noraEntry: 'nora-entry',
    shell: 'nora-shell',
    stStatic: 'st-static',
    vendorCore: 'vendor-core',
    vendorLegacy: 'vendor-legacy',
});

const INDEX_ASSET_BASE_TOKEN = '{{NORA_ASSET_BASE}}';
const INDEX_ASSET_BASES_TOKEN = '{{NORA_ASSET_BASES}}';
const INDEX_SHELL_ASSET_BASE_TOKEN = '{{NORA_SHELL_ASSET_BASE}}';
const INDEX_EXTENSION_ASSET_BASE_TOKEN = '{{NORA_EXTENSION_ASSET_BASE}}';
const INDEX_EXTENSION_ASSET_RELEASES_TOKEN = '{{NORA_EXTENSION_ASSET_RELEASES}}';
const INDEX_EXTENSION_ASSET_GROUP_RELEASES_TOKEN = '{{NORA_EXTENSION_ASSET_GROUP_RELEASES}}';
const INDEX_VENDOR_ASSET_BASE_TOKEN = '{{NORA_VENDOR_ASSET_BASE}}';
const INDEX_LEGACY_ASSET_BASE_TOKEN = '{{NORA_LEGACY_ASSET_BASE}}';
const INDEX_ASSET_RELEASE_TOKEN = '{{NORA_ASSET_RELEASE}}';
const INDEX_INLINE_MANIFEST_URL_TOKEN = '{{NORA_INLINE_MANIFEST_URL}}';
const MANIFEST_FILE_NAME = '.nora-asset-manifest.json';
const HASH_PATTERN = /^[a-f0-9]{12,64}$/i;
const SAFE_SEGMENT_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * Restricts a content-addressed namespace to the files included in its hash.
 * @param {string[]} allowedPaths
 * @returns {import('express').RequestHandler}
 */
export function createAssetAllowlistMiddleware(allowedPaths) {
    const allowed = new Set(allowedPaths.map(value => `/${String(value || '').replace(/^\/+/, '')}`));
    return (request, response, next) => {
        if (allowed.has(request.path)) return next();
        return response.sendStatus(404);
    };
}

function isPathWithinRoot(rootPath, candidatePath) {
    return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${path.sep}`);
}

function normalizeRelativePath(value) {
    return value.split(path.sep).join('/');
}

function digestBytes(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function safeJson(value) {
    return JSON.stringify(value)
        .replaceAll('<', '\\u003c')
        .replaceAll('\u2028', '\\u2028')
        .replaceAll('\u2029', '\\u2029');
}

function collectRegularFiles(rootPath, target, relativeDirectory = '') {
    if (!fs.existsSync(rootPath)) return;
    const entries = fs.readdirSync(rootPath, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const relativePath = normalizeRelativePath(path.join(relativeDirectory, entry.name));
        const absolutePath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) {
            collectRegularFiles(absolutePath, target, relativePath);
        } else if (entry.isFile()) {
            target[relativePath] = absolutePath;
        }
    }
}

function canonicalFileMap(files) {
    const canonical = Object.create(null);
    for (const [relativePath, sourcePath] of Object.entries(files)) {
        if (/\.(?:br|gz)$/i.test(relativePath)) {
            const basePath = relativePath.replace(/\.(?:br|gz)$/i, '');
            if (Object.hasOwn(files, basePath)) continue;
        }
        canonical[relativePath] = sourcePath;
    }
    return canonical;
}

function compressedVariants(relativePath, sourcePath, allFiles, sourceBytes) {
    const variants = Object.create(null);
    for (const [encoding, suffix, decompress] of [
        ['br', '.br', zlib.brotliDecompressSync],
        ['gzip', '.gz', zlib.gunzipSync],
    ]) {
        const variantPath = allFiles[`${relativePath}${suffix}`] || `${sourcePath}${suffix}`;
        if (!fs.existsSync(variantPath)) continue;
        const compressed = fs.readFileSync(variantPath);
        let decompressed;
        try {
            decompressed = decompress(compressed);
        } catch (error) {
            throw new Error(`Invalid ${encoding} asset companion for ${relativePath}: ${error.message}`);
        }
        if (!decompressed.equals(sourceBytes)) {
            throw new Error(`Compressed asset companion does not match ${relativePath}: ${variantPath}`);
        }
        variants[encoding] = variantPath;
    }
    return variants;
}

function buildNamespace(name, files, length = NORA_ASSET_HASH_LENGTH) {
    if (!SAFE_SEGMENT_PATTERN.test(name)) throw new TypeError(`Invalid asset namespace: ${name}`);
    const canonical = canonicalFileMap(files);
    const records = Object.create(null);
    const hash = crypto.createHash('sha256');
    hash.update(`nora-assets/v${NORA_ASSET_SCHEMA_VERSION}\0${name}\0`);

    for (const relativePath of Object.keys(canonical).sort()) {
        const source = canonical[relativePath];
        const bytes = fs.readFileSync(source);
        const sha256 = digestBytes(bytes);
        records[relativePath] = Object.freeze({
            source,
            sha256,
            size: bytes.length,
            variants: Object.freeze(compressedVariants(relativePath, source, files, bytes)),
        });
        hash.update(`${relativePath}\0${sha256}\0`);
    }

    const fullDigest = hash.digest('hex');
    return Object.freeze({
        name,
        release: fullDigest.slice(0, length),
        fullDigest,
        files: Object.freeze(records),
    });
}

function extensionDirectoryNames(rootPath) {
    if (!fs.existsSync(rootPath)) return [];
    return fs.readdirSync(rootPath, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name);
}

function effectiveExtensionFiles(extensionName, userDirectory, globalDirectory) {
    const globalFiles = Object.create(null);
    const userFiles = Object.create(null);
    collectRegularFiles(path.join(globalDirectory, extensionName), globalFiles);
    collectRegularFiles(path.join(userDirectory, extensionName), userFiles);
    return Object.assign(Object.create(null), globalFiles, userFiles);
}

function buildExtensionNamespace(extensionName, files, length) {
    if (extensionName !== 'nora-mvu') return buildNamespace(extensionName, files, length);
    const runtimeFiles = Object.create(null);
    const vendorFiles = Object.create(null);
    for (const [relativePath, sourcePath] of Object.entries(files)) {
        if (
            relativePath === 'UPSTREAM.md'
            || relativePath === 'build-vendor.sh'
            || relativePath.startsWith('upstream/')
            || /(?:^|\/)[^/]*LICENSE(?:\.txt)?$/i.test(relativePath)
        ) {
            continue;
        }
        (relativePath.startsWith('vendor/') ? vendorFiles : runtimeFiles)[relativePath] = sourcePath;
    }
    const groups = Object.freeze({
        runtime: buildNamespace('nora-mvu-runtime', runtimeFiles, length),
        vendor: buildNamespace('nora-mvu-vendor', vendorFiles, length),
    });
    const hash = crypto.createHash('sha256');
    hash.update(`nora-assets/v${NORA_ASSET_SCHEMA_VERSION}\0extension\0${extensionName}\0`);
    for (const [name, group] of Object.entries(groups)) hash.update(`${name}\0${group.fullDigest}\0`);
    const fullDigest = hash.digest('hex');
    return Object.freeze({
        name: extensionName,
        release: groups.runtime.release,
        packageRelease: fullDigest.slice(0, length),
        fullDigest,
        files: Object.freeze(Object.assign(Object.create(null), groups.runtime.files, groups.vendor.files)),
        groups,
    });
}

export function extensionReleaseForPath(extension, relativePath) {
    if (!extension) return '';
    if (relativePath.startsWith('vendor/') && extension.groups?.vendor) return extension.groups.vendor.release;
    return extension.groups?.runtime?.release || extension.release;
}

/**
 * Builds one immutable browser namespace per effective third-party extension.
 * User files retain the existing per-file precedence over global files.
 * @param {object} options
 * @param {string} options.userDirectory
 * @param {string} options.globalDirectory
 * @param {number} [options.length]
 * @returns {{release: string, extensions: Record<string, ReturnType<typeof buildNamespace>>}}
 */
export function computeExtensionAssetManifest({ userDirectory, globalDirectory, length = NORA_ASSET_HASH_LENGTH }) {
    const extensionNames = [...new Set([
        ...extensionDirectoryNames(globalDirectory),
        ...extensionDirectoryNames(userDirectory),
    ])].sort();
    const extensions = Object.create(null);
    const aggregate = crypto.createHash('sha256');
    aggregate.update(`nora-assets/v${NORA_ASSET_SCHEMA_VERSION}\0extensions\0`);

    for (const extensionName of extensionNames) {
        if (!SAFE_SEGMENT_PATTERN.test(extensionName)) continue;
        const key = `third-party/${extensionName}`;
        const extension = buildExtensionNamespace(
            extensionName,
            effectiveExtensionFiles(extensionName, userDirectory, globalDirectory),
            length,
        );
        extensions[key] = extension;
        aggregate.update(`${key}\0${extension.fullDigest}\0`);
    }

    return Object.freeze({
        release: aggregate.digest('hex').slice(0, length),
        extensions: Object.freeze(extensions),
    });
}

function coreNamespaceFor(relativePath) {
    if (/^dist\/nora\/(?:entry|\d+)\.js(?:\.(?:br|gz))?$/i.test(relativePath)) {
        return NORA_ASSET_NAMESPACE.noraEntry;
    }
    if (/^dist\/nora\/inline-modules\.js(?:\.(?:br|gz))?$/i.test(relativePath)) {
        return NORA_ASSET_NAMESPACE.compatibility;
    }
    if (/^dist\/nora\/lib-core\.js(?:\..+)?$/i.test(relativePath)) {
        return NORA_ASSET_NAMESPACE.vendorCore;
    }
    if (/^dist\/nora\/legacy\.js(?:\..+)?$/i.test(relativePath)) {
        return NORA_ASSET_NAMESPACE.vendorLegacy;
    }
    if (
        relativePath === 'tavern-icon-dbf4ecbd54ec.png'
        || relativePath.startsWith('webfonts/')
        || ['css/nora-runtime-contract.css', 'css/fontawesome.min.css', 'css/solid.min.css', 'css/toastr.min.css'].includes(relativePath)
    ) {
        return NORA_ASSET_NAMESPACE.shell;
    }
    return NORA_ASSET_NAMESPACE.stStatic;
}

/**
 * Builds the browser-facing content manifest from final build outputs.
 * Source files, lockfiles and timestamps intentionally do not participate.
 * @param {object} options
 * @param {string} options.publicDirectory
 * @param {string} options.bundledLibPath
 * @param {string} options.userExtensionDirectory
 * @param {string} options.globalExtensionDirectory
 * @param {number} [options.length]
 */
export function computeBrowserAssetManifest({
    publicDirectory,
    bundledLibPath,
    userExtensionDirectory,
    globalExtensionDirectory,
    length = NORA_ASSET_HASH_LENGTH,
}) {
    const publicFiles = Object.create(null);
    collectRegularFiles(publicDirectory, publicFiles);
    const namespaceFiles = Object.fromEntries(Object.values(NORA_ASSET_NAMESPACE)
        .map(namespace => [namespace, Object.create(null)]));
    const excludedPaths = new Set(['index.html', 'actor.html', 'css/user.css']);

    for (const [relativePath, sourcePath] of Object.entries(publicFiles)) {
        if (excludedPaths.has(relativePath) || relativePath.startsWith('scripts/extensions/third-party/')) continue;
        namespaceFiles[coreNamespaceFor(relativePath)][relativePath] = sourcePath;
    }
    if (!fs.existsSync(bundledLibPath)) {
        throw new Error(`Bundled frontend library is missing: ${bundledLibPath}`);
    }
    namespaceFiles[NORA_ASSET_NAMESPACE.compatibility]['lib.js'] = bundledLibPath;

    const namespaces = Object.create(null);
    for (const namespace of Object.values(NORA_ASSET_NAMESPACE)) {
        namespaces[namespace] = buildNamespace(namespace, namespaceFiles[namespace], length);
    }
    const extensionManifest = computeExtensionAssetManifest({
        userDirectory: userExtensionDirectory,
        globalDirectory: globalExtensionDirectory,
        length,
    });
    const deploymentHash = crypto.createHash('sha256');
    deploymentHash.update(`nora-assets/v${NORA_ASSET_SCHEMA_VERSION}\0deployment\0`);
    for (const [name, namespace] of Object.entries(namespaces).sort(([left], [right]) => left.localeCompare(right))) {
        deploymentHash.update(`${name}\0${namespace.fullDigest}\0`);
    }
    for (const [name, extension] of Object.entries(extensionManifest.extensions).sort(([left], [right]) => left.localeCompare(right))) {
        deploymentHash.update(`${name}\0${extension.fullDigest}\0`);
    }
    const fullDigest = deploymentHash.digest('hex');

    return Object.freeze({
        schemaVersion: NORA_ASSET_SCHEMA_VERSION,
        release: fullDigest.slice(0, length),
        fullDigest,
        namespaces: Object.freeze(namespaces),
        extensionRelease: extensionManifest.release,
        extensions: extensionManifest.extensions,
    });
}

/**
 * Creates a deterministic release id from the files the browser can execute.
 * Kept for narrow callers and tests; browser startup uses computeBrowserAssetManifest.
 * @param {object} options
 * @param {{label: string, path: string}[]} options.roots
 * @param {{label: string, path: string}[]} [options.files]
 * @param {string[]} [options.excludedPaths]
 * @param {number} [options.length]
 * @returns {string}
 */
export function computeStaticAssetRelease({ roots, files = [], excludedPaths = [], length = NORA_ASSET_HASH_LENGTH }) {
    const collected = Object.create(null);
    const exclusions = excludedPaths.map(normalizeRelativePath);
    for (const root of [...roots].sort((left, right) => left.label.localeCompare(right.label))) {
        const rootFiles = Object.create(null);
        collectRegularFiles(root.path, rootFiles);
        for (const [relativePath, sourcePath] of Object.entries(rootFiles)) {
            const labeledPath = `${root.label}/${relativePath}`;
            if (exclusions.some(excluded => labeledPath === excluded || labeledPath.startsWith(`${excluded}/`))) continue;
            collected[labeledPath] = sourcePath;
        }
    }
    for (const file of files) {
        if (fs.existsSync(file.path)) collected[file.label] = file.path;
    }
    return buildNamespace('static', collected, length).release;
}

/**
 * Creates one shell identity from independently cacheable asset namespaces.
 * @param {string[]} releases
 * @param {number} [length]
 * @returns {string}
 */
export function computeCompositeAssetRelease(releases, length = NORA_ASSET_HASH_LENGTH) {
    const normalized = releases.map(value => String(value || '').trim());
    if (!normalized.length || normalized.some(value => !HASH_PATTERN.test(value))) {
        throw new TypeError('Composite asset releases must be hexadecimal content hashes.');
    }
    return crypto.createHash('sha256').update(normalized.join('\0')).digest('hex').slice(0, length);
}

function snapshotDescriptor(namespace) {
    return {
        schemaVersion: NORA_ASSET_SCHEMA_VERSION,
        name: namespace.name,
        release: namespace.release,
        fullDigest: namespace.fullDigest,
        files: Object.fromEntries(Object.entries(namespace.files).map(([relativePath, record]) => [relativePath, {
            sha256: record.sha256,
            size: record.size,
            encodings: Object.keys(record.variants),
        }])),
    };
}

function snapshotIsComplete(targetDirectory, namespace) {
    try {
        const descriptor = JSON.parse(fs.readFileSync(path.join(targetDirectory, MANIFEST_FILE_NAME), 'utf8'));
        if (descriptor.fullDigest !== namespace.fullDigest) return false;
        return Object.entries(namespace.files).every(([relativePath, record]) => {
            const targetPath = path.join(targetDirectory, relativePath);
            if (!fs.existsSync(targetPath) || digestBytes(fs.readFileSync(targetPath)) !== record.sha256) return false;
            return Object.keys(record.variants).every(encoding => {
                const suffix = encoding === 'br' ? '.br' : '.gz';
                return fs.existsSync(`${targetPath}${suffix}`);
            });
        });
    } catch {
        return false;
    }
}

function materializeNamespace(namespace, parentDirectory) {
    const targetDirectory = path.join(parentDirectory, namespace.release);
    if (snapshotIsComplete(targetDirectory, namespace)) {
        const now = new Date();
        fs.utimesSync(targetDirectory, now, now);
        return targetDirectory;
    }

    const stagingDirectory = `${targetDirectory}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
    fs.mkdirSync(stagingDirectory, { recursive: true });
    try {
        for (const [relativePath, record] of Object.entries(namespace.files)) {
            const destination = path.join(stagingDirectory, relativePath);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(record.source, destination);
            if (digestBytes(fs.readFileSync(destination)) !== record.sha256) {
                throw new Error(`Asset snapshot verification failed: ${relativePath}`);
            }
            for (const [encoding, variantSource] of Object.entries(record.variants)) {
                const suffix = encoding === 'br' ? '.br' : '.gz';
                fs.copyFileSync(variantSource, `${destination}${suffix}`);
            }
        }
        fs.writeFileSync(path.join(stagingDirectory, MANIFEST_FILE_NAME), JSON.stringify(snapshotDescriptor(namespace)));
        fs.rmSync(targetDirectory, { recursive: true, force: true });
        fs.renameSync(stagingDirectory, targetDirectory);
    } catch (error) {
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
        throw error;
    }
    return targetDirectory;
}

function pruneGenerations(parentDirectory, currentRelease, retain) {
    if (!fs.existsSync(parentDirectory)) return;
    const generations = fs.readdirSync(parentDirectory, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && HASH_PATTERN.test(entry.name))
        .map(entry => ({ name: entry.name, mtimeMs: fs.statSync(path.join(parentDirectory, entry.name)).mtimeMs }))
        .sort((left, right) => right.mtimeMs - left.mtimeMs);
    const keep = new Set([currentRelease]);
    for (const generation of generations) {
        if (keep.size >= retain) break;
        keep.add(generation.name);
    }
    for (const generation of generations) {
        if (!keep.has(generation.name)) {
            fs.rmSync(path.join(parentDirectory, generation.name), { recursive: true, force: true });
        }
    }
}

/**
 * Copies immutable bytes into retained content-addressed generations.
 * The current generation and its immediate predecessor are kept per namespace.
 * @param {object} options
 * @param {ReturnType<typeof computeBrowserAssetManifest>} options.manifest
 * @param {string} options.cacheDirectory
 * @param {number} [options.retain]
 */
export function materializeBrowserAssetManifest({ manifest, cacheDirectory, retain = 2 }) {
    if (!Number.isInteger(retain) || retain < 2) throw new TypeError('At least two asset generations must be retained.');
    const namespaceRoot = path.join(cacheDirectory, 'namespaces');
    const extensionRoot = path.join(cacheDirectory, 'extensions');
    fs.mkdirSync(namespaceRoot, { recursive: true });
    fs.mkdirSync(extensionRoot, { recursive: true });

    for (const namespace of Object.values(manifest.namespaces)) {
        const parent = path.join(namespaceRoot, namespace.name);
        materializeNamespace(namespace, parent);
        pruneGenerations(parent, namespace.release, retain);
    }
    for (const [key, extension] of Object.entries(manifest.extensions)) {
        const extensionName = key.slice('third-party/'.length);
        const groups = extension.groups || { package: extension };
        for (const [groupName, group] of Object.entries(groups)) {
            const parent = path.join(extensionRoot, extensionName, groupName);
            materializeNamespace(group, parent);
            pruneGenerations(parent, group.release, retain);
        }
    }
    return Object.freeze({ cacheDirectory, manifest });
}

function cachedAssetPath(rootDirectory, segments, release, relativePath) {
    if (!segments.length || segments.some(segment => !SAFE_SEGMENT_PATTERN.test(segment))) return '';
    if (!HASH_PATTERN.test(release) || !relativePath || relativePath.includes('\0')) return '';
    const generationRoot = path.resolve(rootDirectory, ...segments, release);
    const candidate = path.resolve(generationRoot, relativePath);
    if (!isPathWithinRoot(generationRoot, candidate) || path.basename(candidate) === MANIFEST_FILE_NAME) return '';
    return candidate;
}

function sendImmutableAsset(request, response, sourcePath) {
    if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
        return response.sendStatus(404);
    }
    const accepted = typeof request.acceptsEncodings === 'function'
        ? request.acceptsEncodings('br', 'gzip')
        : false;
    const suffix = accepted === 'br' ? '.br' : accepted === 'gzip' ? '.gz' : '';
    const selectedPath = suffix && fs.existsSync(`${sourcePath}${suffix}`) ? `${sourcePath}${suffix}` : sourcePath;
    if (selectedPath !== sourcePath) {
        response.setHeader('Content-Encoding', accepted);
        response.setHeader('Vary', 'Accept-Encoding');
    }
    response.type(path.extname(sourcePath));
    return response.sendFile(selectedPath, {
        etag: true,
        lastModified: true,
        headers: { 'Cache-Control': IMMUTABLE_ASSET_CACHE_CONTROL },
    });
}

/** @returns {import('express').RequestHandler} */
export function createVersionedAssetRouteHandler(cacheDirectory) {
    return (request, response) => {
        try {
            const namespace = decodeURIComponent(String(request.params.namespace || ''));
            const release = String(request.params.release || '');
            const relativePath = decodeURIComponent(String(request.params[0] || '')).replace(/^\/+/, '');
            const sourcePath = cachedAssetPath(path.join(cacheDirectory, 'namespaces'), [namespace], release, relativePath);
            return sendImmutableAsset(request, response, sourcePath);
        } catch {
            return response.sendStatus(404);
        }
    };
}

/** @returns {import('express').RequestHandler} */
export function createVersionedExtensionRouteHandler(cacheDirectory) {
    return (request, response) => {
        try {
            const extensionName = decodeURIComponent(String(request.params.extension || ''));
            const release = String(request.params.release || '');
            const relativePath = decodeURIComponent(String(request.params[0] || '')).replace(/^\/+/, '');
            const groupName = extensionName === 'nora-mvu' && relativePath.startsWith('vendor/') ? 'vendor' : extensionName === 'nora-mvu' ? 'runtime' : 'package';
            const sourcePath = cachedAssetPath(path.join(cacheDirectory, 'extensions'), [extensionName, groupName], release, relativePath);
            return sendImmutableAsset(request, response, sourcePath);
        } catch {
            return response.sendStatus(404);
        }
    };
}

/**
 * Serves build-time Brotli/Gzip companions for unversioned compatibility assets.
 * @param {string} rootDirectory
 * @returns {import('express').RequestHandler}
 */
export function createPrecompressedAssetMiddleware(rootDirectory) {
    const resolvedRoot = path.resolve(rootDirectory);
    return (request, response, next) => {
        if (!['GET', 'HEAD'].includes(request.method)) return next();
        let relativePath;
        try {
            relativePath = decodeURIComponent(request.path).replace(/^\/+/, '');
        } catch {
            return next();
        }
        const sourcePath = path.resolve(resolvedRoot, relativePath);
        if (!relativePath || !isPathWithinRoot(resolvedRoot, sourcePath) || !fs.existsSync(sourcePath)) return next();
        const encoding = request.acceptsEncodings('br', 'gzip');
        const suffix = encoding === 'br' ? '.br' : encoding === 'gzip' ? '.gz' : '';
        if (!suffix || !fs.existsSync(`${sourcePath}${suffix}`)) return next();
        response.type(path.extname(sourcePath));
        response.setHeader('Content-Encoding', encoding);
        response.setHeader('Cache-Control', IMMUTABLE_ASSET_CACHE_CONTROL);
        response.vary('Accept-Encoding');
        return response.sendFile(`${sourcePath}${suffix}`, { etag: true, lastModified: true });
    };
}

export function assetNamespaceBase(namespace) {
    if (!namespace || !SAFE_SEGMENT_PATTERN.test(namespace.name) || !HASH_PATTERN.test(namespace.release)) {
        throw new TypeError('Invalid content-addressed asset namespace.');
    }
    return `/asset-files/${encodeURIComponent(namespace.name)}/${namespace.release}`;
}

/**
 * Replaces the static asset tokens in the HTML shell.
 * @param {string} template
 * @param {ReturnType<typeof computeBrowserAssetManifest>} manifest
 * @returns {string}
 */
export function renderNoraIndex(template, manifest) {
    if (!manifest || manifest.schemaVersion !== NORA_ASSET_SCHEMA_VERSION || !HASH_PATTERN.test(manifest.release)) {
        throw new TypeError('A valid Nora browser asset manifest is required.');
    }
    const assetBases = Object.fromEntries(Object.entries(manifest.namespaces)
        .map(([name, namespace]) => [name, assetNamespaceBase(namespace)]));
    const extensionReleases = Object.fromEntries(Object.entries(manifest.extensions)
        .map(([name, extension]) => [name, extension.release]));
    const extensionGroupReleases = Object.fromEntries(Object.entries(manifest.extensions)
        .filter(([, extension]) => extension.groups)
        .map(([name, extension]) => [name, Object.fromEntries(Object.entries(extension.groups)
            .map(([groupName, group]) => [groupName, group.release]))]));
    const noraUiRelease = extensionReleases['third-party/nora-ui'];
    const extensionAssetBase = noraUiRelease ? `/extension-assets/${noraUiRelease}` : '';
    const compatibilityBase = assetBases[NORA_ASSET_NAMESPACE.compatibility];
    const vendorBase = assetBases[NORA_ASSET_NAMESPACE.vendorCore];
    const legacyBase = assetBases[NORA_ASSET_NAMESPACE.vendorLegacy];
    return template
        .replace('{{NORA_LOCALE_BOOTSTRAP}}', () => renderLocaleBootstrap(template))
        .replaceAll(INDEX_INLINE_MANIFEST_URL_TOKEN, `${compatibilityBase}/dist/nora/inline-modules.js`)
        .replaceAll(INDEX_ASSET_BASES_TOKEN, safeJson(assetBases))
        .replaceAll(INDEX_SHELL_ASSET_BASE_TOKEN, assetBases[NORA_ASSET_NAMESPACE.shell])
        .replaceAll(INDEX_EXTENSION_ASSET_BASE_TOKEN, extensionAssetBase)
        .replaceAll(INDEX_EXTENSION_ASSET_RELEASES_TOKEN, safeJson(extensionReleases))
        .replaceAll(INDEX_EXTENSION_ASSET_GROUP_RELEASES_TOKEN, safeJson(extensionGroupReleases))
        .replaceAll(INDEX_VENDOR_ASSET_BASE_TOKEN, vendorBase)
        .replaceAll(INDEX_LEGACY_ASSET_BASE_TOKEN, legacyBase)
        .replaceAll(INDEX_ASSET_BASE_TOKEN, compatibilityBase)
        .replaceAll(INDEX_ASSET_RELEASE_TOKEN, manifest.release);
}
