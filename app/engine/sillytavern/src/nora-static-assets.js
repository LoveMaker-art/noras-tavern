import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { renderLocaleBootstrap } from './nora-locale-bootstrap.js';

export const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const REVALIDATED_ASSET_CACHE_CONTROL = 'no-cache, must-revalidate';
export const NO_STORE_CACHE_CONTROL = 'no-store';

const INDEX_ASSET_BASE_TOKEN = '{{NORA_ASSET_BASE}}';
const INDEX_EXTENSION_ASSET_BASE_TOKEN = '{{NORA_EXTENSION_ASSET_BASE}}';
const INDEX_ASSET_RELEASE_TOKEN = '{{NORA_ASSET_RELEASE}}';
const INDEX_INLINE_MANIFEST_URL_TOKEN = '{{NORA_INLINE_MANIFEST_URL}}';

function isPathWithinRoot(rootPath, candidatePath) {
    return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${path.sep}`);
}

function normalizeRelativePath(value) {
    return value.split(path.sep).join('/');
}

function appendDirectory(hash, rootPath, label, excludedPaths) {
    if (!fs.existsSync(rootPath)) return;
    const exclusionList = [...excludedPaths];

    const visit = (directory, relativeDirectory = '') => {
        const entries = fs.readdirSync(directory, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));

        for (const entry of entries) {
            const relativePath = normalizeRelativePath(path.join(relativeDirectory, entry.name));
            const labeledPath = `${label}/${relativePath}`;
            if (exclusionList.some(excludedPath => labeledPath === excludedPath || labeledPath.startsWith(`${excludedPath}/`))) continue;

            const absolutePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                visit(absolutePath, relativePath);
                continue;
            }
            if (!entry.isFile()) continue;

            hash.update(`${label}/${relativePath}\0`);
            hash.update(fs.readFileSync(absolutePath));
            hash.update('\0');
        }
    };

    visit(rootPath);
}

/**
 * Creates a deterministic release id from the files the browser can execute.
 * Timestamps are intentionally ignored so identical releases share a cache key.
 * @param {object} options
 * @param {{label: string, path: string}[]} options.roots
 * @param {{label: string, path: string}[]} [options.files]
 * @param {string[]} [options.excludedPaths]
 * @param {number} [options.length]
 * @returns {string}
 */
export function computeStaticAssetRelease({ roots, files = [], excludedPaths = [], length = 16 }) {
    const hash = crypto.createHash('sha256');
    const exclusions = new Set(excludedPaths.map(normalizeRelativePath));
    const sortedRoots = [...roots].sort((left, right) => left.label.localeCompare(right.label));

    for (const root of sortedRoots) {
        appendDirectory(hash, root.path, root.label, exclusions);
    }

    for (const file of [...files].sort((left, right) => left.label.localeCompare(right.label))) {
        if (!fs.existsSync(file.path)) continue;
        hash.update(`${file.label}\0`);
        hash.update(fs.readFileSync(file.path));
        hash.update('\0');
    }

    return hash.digest('hex').slice(0, length);
}

/**
 * Creates one shell identity from independently cacheable asset namespaces.
 * @param {string[]} releases
 * @param {number} [length]
 * @returns {string}
 */
export function computeCompositeAssetRelease(releases, length = 16) {
    const normalized = releases.map(value => String(value || '').trim());
    if (!normalized.length || normalized.some(value => !/^[a-f0-9]{12,64}$/i.test(value))) {
        throw new TypeError('Composite asset releases must be hexadecimal content hashes.');
    }
    return crypto.createHash('sha256').update(normalized.join('\0')).digest('hex').slice(0, length);
}

/**
 * Serves build-time Brotli/Gzip companions for immutable assets.
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
        if (!relativePath || relativePath.includes('\0')) return next();

        const sourcePath = path.resolve(resolvedRoot, relativePath);
        if (!isPathWithinRoot(resolvedRoot, sourcePath) || !fs.existsSync(sourcePath)) return next();

        const encoding = request.acceptsEncodings('br', 'gzip');
        const suffix = encoding === 'br' ? '.br' : encoding === 'gzip' ? '.gz' : '';
        if (!suffix) return next();

        const compressedPath = `${sourcePath}${suffix}`;
        if (!fs.existsSync(compressedPath)) return next();

        response.type(path.extname(sourcePath));
        response.setHeader('Content-Encoding', encoding);
        response.setHeader('Cache-Control', IMMUTABLE_ASSET_CACHE_CONTROL);
        response.vary('Accept-Encoding');
        return response.sendFile(compressedPath, {
            etag: true,
            lastModified: true,
        });
    };
}

/**
 * Replaces the static asset tokens in the HTML shell.
 * @param {string} template
 * @param {string} release Shell release used by the bootstrap consistency guard.
 * @param {string} [coreRelease] Core browser asset release.
 * @param {string} [extensionRelease] Third-party extension asset release.
 * @returns {string}
 */
export function renderNoraIndex(template, release, coreRelease = release, extensionRelease = release) {
    if (![release, coreRelease, extensionRelease].every(value => /^[a-f0-9]{12,64}$/i.test(value))) {
        throw new TypeError('Static asset release must be a hexadecimal content hash.');
    }

    const assetBase = `/assets/${coreRelease}`;
    const extensionAssetBase = `/extension-assets/${extensionRelease}`;
    return template
        .replace('{{NORA_LOCALE_BOOTSTRAP}}', () => renderLocaleBootstrap(template))
        .replaceAll(INDEX_INLINE_MANIFEST_URL_TOKEN, `${assetBase}/dist/nora/inline-modules.js`)
        .replaceAll(INDEX_EXTENSION_ASSET_BASE_TOKEN, extensionAssetBase)
        .replaceAll(INDEX_ASSET_BASE_TOKEN, assetBase)
        .replaceAll(INDEX_ASSET_RELEASE_TOKEN, release);
}
