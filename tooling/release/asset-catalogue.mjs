#!/usr/bin/env node
// GitHub reads belong here, before sealing. Expansion itself is a pure validator;
// locally supplied JSON establishes consistency, never remote authenticity.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fileDigest } from './system-release.mjs';

export const REPOSITORY = 'LoveMaker-art/noras-tavern';
const INDEX = 'release-assets.json';
const INDEX_LIMIT = 64 * 1024;
const MANIFEST_LIMIT = 8 * 1024 * 1024;
const MAX_ASSET = 2 * 1024 ** 3;
const CURRENT = /^(?:release-assets\.json|release-manifest\.json|(?:LAUNCHER-)?SHA256SUMS|bootstrap-manifest\.json|first-install-manifest\.json|tavern-updater-bootstrap\.py|nora-tavern-first-install-bootstrap\.py|install-(?:nora-tavern\.(?:sh|ps1)|tavern-updater\.sh)|nora-(?:system|launcher)-.*\.json|Nora-Tavern-Launcher-.*)$/;
const CURRENT_SUFFIX = /-(?:release-manifest.*\.json|SHA256SUMS|first-install-manifest\.json|nora-tavern-first-install-bootstrap\.py|tavern-updater-bootstrap\.py)$/;
const safeName = name => {
    assert.match(name || '', /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Unsafe baseline asset name');
    return name;
};
function version(value) {
    assert.match(value || '', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Use a canonical stable version');
    const parts = value.split('.').map(Number);
    assert.ok(parts.every(Number.isSafeInteger), 'Version exceeds safe integer range');
    return parts;
}
function stableTag(tag) { assert.ok(typeof tag === 'string' && tag.startsWith('v')); return version(tag.slice(1)); }
function compare(a, b) {
    const left = version(a), right = version(b), index = left.findIndex((value, i) => value !== right[i]);
    return index < 0 ? 0 : Math.sign(left[index] - right[index]);
}
const url = (repository, tag, name) => `https://github.com/${repository}/releases/download/${tag}/${name}`;
function rawRelease(release, repository, tag) {
    stableTag(tag);
    assert.equal(release?.tag_name, tag, 'Baseline release differs from requested stable tag');
    assert.equal(release.draft, false, 'Baseline is not a formal release');
    assert.equal(release.prerelease, false, 'Baseline is not stable');
    assert.ok(Array.isArray(release.assets), 'Missing baseline assets');
    assert.equal(release.assetIndexText, undefined, 'Use raw release metadata, never pre-expanded input');
    const names = new Set();
    for (const asset of release.assets) {
        safeName(asset?.name);
        const key = asset.name.toLowerCase();
        assert.ok(!names.has(key), 'Duplicate baseline asset name'); names.add(key);
        assert.equal(asset.asset_release_tag, undefined, 'Raw release must not contain synthetic references');
        assert.equal(asset.state, 'uploaded', `Incomplete baseline asset: ${asset.name}`);
        assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= MAX_ASSET, 'Invalid baseline asset size');
        assert.match(asset.digest || '', /^sha256:[a-f0-9]{64}$/, `Missing full GitHub asset digest: ${asset.name}`);
        assert.equal(asset.browser_download_url, url(repository, tag, asset.name), 'Baseline asset URL is outside its canonical release');
    }
    return release;
}
function indexFrom(release, indexText, repository, tag, commit) {
    const descriptor = release.assets.find(asset => asset.name === INDEX);
    if (!descriptor) { assert.equal(indexText, null, 'Index text lacks a current-tag descriptor'); return null; }
    assert.ok(typeof indexText === 'string' && Buffer.byteLength(indexText) <= INDEX_LIMIT, 'Asset index exceeds 64 KiB');
    assert.equal(Buffer.byteLength(indexText), descriptor.size, 'Asset index size mismatch');
    // Hash the retained raw text, not a JSON reserialization.
    const index = JSON.parse(indexText);
    assert.equal(index?.schema, 'nora-release-assets/1');
    assert.deepEqual(Object.keys(index).sort(), ['assets', 'commit', 'minimumLauncherVersion', 'repository', 'schema', 'tag']);
    assert.equal(index.repository, repository, 'Asset index belongs to another repository');
    assert.equal(index.tag, tag, 'Asset index belongs to another release');
    assert.equal(index.commit, commit, 'Asset index commit differs from the remote tag');
    assert.ok(compare(index.minimumLauncherVersion, '2.1.1') > 0, 'Shared assets require a launcher newer than 2.1.1');
    assert.ok(Array.isArray(index.assets) && index.assets.length <= 256, 'Invalid asset reference list');
    const names = new Set(release.assets.map(asset => asset.name.toLowerCase()));
    for (const reference of index.assets) {
        assert.ok(reference && typeof reference === 'object' && !Array.isArray(reference));
        assert.deepEqual(Object.keys(reference).sort(), ['asset_release_tag', 'name', 'sha256', 'size']);
        safeName(reference.name); stableTag(reference.asset_release_tag);
        assert.ok(compare(reference.asset_release_tag.slice(1), tag.slice(1)) < 0, 'Asset origin must be an older stable tag');
        assert.ok(!CURRENT.test(reference.name) && !CURRENT_SUFFIX.test(reference.name), 'Release controls and launcher delivery must belong to the current tag');
        const key = reference.name.toLowerCase(); assert.ok(!names.has(key), 'Referenced asset conflicts with an existing name'); names.add(key);
        assert.ok(Number.isSafeInteger(reference.size) && reference.size > 0 && reference.size <= MAX_ASSET, 'Invalid referenced asset size');
        assert.match(reference.sha256 || '', /^[a-f0-9]{64}$/, 'Missing full referenced asset digest');
    }
    return index;
}

/** Strict local expansion. origins are raw same-repository release metadata;
 * manifestTexts retain each physical source manifest's raw hashed bytes, and
 * originCommits are independently resolved Git tag commits, not target_commitish.
 * Call readAssetCatalogue for GitHub authenticity; this function performs no I/O. */
export function expandAssetCatalogue({ repository = REPOSITORY, tag, commit, release, indexText = null, origins = {}, originCommits = {}, manifestTexts = {} }) {
    assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    assert.match(commit || '', /^[a-f0-9]{40}$/, 'Missing baseline tag commit');
    rawRelease(release, repository, tag);
    if (indexText !== null) {
        const descriptor = release.assets.find(asset => asset.name === INDEX);
        assert.ok(descriptor, 'Index text lacks a current-tag descriptor');
        assert.equal(hashText(indexText), descriptor.digest.slice(7), 'Asset index checksum mismatch');
    }
    const index = indexFrom(release, indexText, repository, tag, commit);
    const commits = { [tag]: commit }, referenced = [], sources = { [tag]: release };
    for (const reference of index?.assets || []) {
        const origin = reference.asset_release_tag;
        const source = rawRelease(origins[origin], repository, origin);
        assert.match(originCommits[origin] || '', /^[a-f0-9]{40}$/, 'Missing original asset tag commit');
        commits[origin] = originCommits[origin];
        sources[origin] = source;
        const asset = source.assets.find(item => item.name === reference.name);
        assert.ok(asset, 'Referenced origin does not physically own its asset');
        assert.equal(asset.size, reference.size, 'Referenced origin size differs');
        assert.equal(asset.digest, `sha256:${reference.sha256}`, 'Referenced origin digest differs');
        referenced.push({ ...asset, asset_release_tag: origin });
    }
    const sourceManifests = {};
    for (const [sourceTag, source] of Object.entries(sources)) {
        const descriptor = source.assets.find(asset => asset.name === 'release-manifest.json');
        const text = manifestTexts[sourceTag];
        assert.ok(descriptor && typeof text === 'string' && Buffer.byteLength(text) <= MANIFEST_LIMIT, 'Baseline source manifest proof is required and bounded');
        assert.equal(Buffer.byteLength(text), descriptor.size, 'Baseline source manifest size mismatch');
        assert.equal(hashText(text), descriptor.digest.slice(7), 'Baseline source manifest checksum mismatch');
        const identity = JSON.parse(text);
        assert.equal(identity.schema, 'tavern-release/v2', 'Missing baseline source identity');
        assertBaselineCatalogue({ commit: commits[sourceTag], release: { tag_name: sourceTag,
            ...(sourceTag === tag && index ? { assetIndexText: indexText } : {}) } }, identity);
        sourceManifests[sourceTag] = { commit: identity.commit, version: identity.versions.tavern, size: descriptor.size, sha256: descriptor.digest.slice(7) };
    }
    return { schema: 'nora-reuse-baseline/1', repository, commit, originCommits: commits, sourceManifests,
        release: { ...release, ...(index ? { assetIndexText: indexText } : {}), assets: [...release.assets, ...referenced] } };
}

const hashText = text => createHash('sha256').update(text).digest('hex');
const executeGh = (args, { timeout = 120000 } = {}) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    timeout, killSignal: 'SIGKILL' });
function resolveTag(repository, tag, execute) {
    stableTag(tag);
    const api = resource => JSON.parse(execute(['api', `repos/${repository}/${resource}`], { timeout: 120000 }));
    const ref = api(`git/ref/tags/${tag}`);
    assert.equal(ref.ref, `refs/tags/${tag}`, 'Tag API returned another ref');
    let object = ref.object;
    for (let depth = 0; depth < 8; depth++) {
        assert.match(object?.sha || '', /^[a-f0-9]{40}$/, 'Invalid remote tag object');
        if (object.type === 'commit') return object.sha;
        assert.equal(object.type, 'tag', 'Tag does not resolve to a commit');
        const annotated = api(`git/tags/${object.sha}`);
        assert.equal(annotated.sha, object.sha, 'Annotated tag API returned another object');
        object = annotated.object;
    }
    throw new Error('Remote tag annotation chain exceeds limit');
}
function verifyDownloaded(file, asset, expected) {
    assert.ok(fs.lstatSync(file).isFile(), 'Downloaded asset must be a regular file');
    assert.equal(fs.statSync(file).size, asset.size, 'Downloaded baseline asset size mismatch');
    const sha256 = fileDigest(file);
    assert.equal(sha256, asset.digest.slice(7), 'Downloaded baseline asset checksum mismatch');
    if (expected) {
        assert.ok(Number.isSafeInteger(expected.size) && expected.size > 0, 'Missing descriptor size');
        assert.match(expected.sha256 || '', /^[a-f0-9]{64}$/, 'Missing descriptor checksum');
        assert.equal(asset.size, expected.size, 'Catalogue and descriptor size differ');
        assert.equal(sha256, expected.sha256, 'Catalogue and descriptor checksum differ');
    }
}
/** Read-only GitHub proof, including each original physical asset owner. */
export function readAssetCatalogue({ repository = REPOSITORY, tag, execute = executeGh } = {}) {
    assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/); stableTag(tag);
    const read = source => rawRelease(JSON.parse(execute(['api', `repos/${repository}/releases/tags/${source}`], { timeout: 120000 })), repository, source);
    const release = read(tag), commit = resolveTag(repository, tag, execute);
    const descriptor = release.assets.find(asset => asset.name === INDEX);
    let indexText = null, index;
    const origins = {}, originCommits = {}, manifestTexts = {};
    if (descriptor) {
        assert.ok(descriptor.size <= INDEX_LIMIT, 'Asset index exceeds 64 KiB');
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-asset-index-'));
        try {
            execute(['release', 'download', tag, '--repo', repository, '--pattern', INDEX, '--dir', directory], { timeout: 120000 });
            const file = path.join(directory, INDEX); verifyDownloaded(file, descriptor);
            indexText = fs.readFileSync(file, 'utf8');
            index = indexFrom(release, indexText, repository, tag, commit);
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
        for (const origin of new Set(index.assets.map(asset => asset.asset_release_tag))) {
            origins[origin] = read(origin); originCommits[origin] = resolveTag(repository, origin, execute);
        }
    }
    for (const [sourceTag, source] of Object.entries({ [tag]: release, ...origins })) {
        const asset = source.assets.find(item => item.name === 'release-manifest.json');
        assert.ok(asset && asset.size <= MANIFEST_LIMIT, 'Baseline source manifest proof is required and bounded');
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-baseline-manifest-'));
        try {
            execute(['release', 'download', sourceTag, '--repo', repository, '--pattern', asset.name, '--dir', directory], { timeout: 120000 });
            const file = path.join(directory, asset.name); verifyDownloaded(file, asset);
            manifestTexts[sourceTag] = fs.readFileSync(file, 'utf8');
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
    return expandAssetCatalogue({ repository, tag, commit, release, indexText, origins, originCommits, manifestTexts });
}

/** A target release descriptor must remain tied to the target tag even when its
 * byte-identical environments come from older releases. */
export function assertBaselineCatalogue(catalogue, identity, minimum) {
    assert.equal(identity.commit, catalogue.commit, 'Baseline descriptor commit differs from the remote tag');
    assert.equal(identity.versions?.tavern ?? identity.version, catalogue.release.tag_name.slice(1), 'Baseline descriptor version differs from the remote tag');
    assert.equal(identity.candidate, false, 'Baseline descriptor must be stable');
    if (identity.schema === 'tavern-release/v2') assert.equal(identity.dirty, false, 'Baseline source must be clean');
    if (identity.schema === 'nora-system/v1') assert.equal(identity.channel, 'stable');
    if (catalogue.release.assetIndexText !== undefined) {
        const index = JSON.parse(catalogue.release.assetIndexText);
        assert.ok(compare(minimum ?? identity.minimumLauncherVersion ?? identity.bootstrap?.minimumLauncherVersion, index.minimumLauncherVersion) >= 0,
            'Baseline descriptor under-declares the shared asset protocol minimum');
    }
}

/** Download canonical physical origin, then verify full bytes against both API
 * catalogue and optional logical system/runtime descriptor. No links/overwrite. */
export function downloadCatalogueAsset(catalogue, name, directory, { execute = executeGh, targetName = name, expected } = {}) {
    safeName(name); safeName(targetName);
    assert.equal(catalogue.schema, 'nora-reuse-baseline/1');
    const asset = catalogue.release.assets.find(item => item.name === name);
    assert.ok(asset, `Missing baseline asset: ${name}`);
    const origin = asset.asset_release_tag || catalogue.release.tag_name;
    stableTag(origin);
    assert.equal(asset.browser_download_url, url(catalogue.repository, origin, name), 'Untrusted asset download URL');
    assert.match(asset.digest || '', /^sha256:[a-f0-9]{64}$/);
    if (asset.asset_release_tag) assert.ok(compare(origin.slice(1), catalogue.release.tag_name.slice(1)) < 0);
    assert.ok(fs.lstatSync(directory).isDirectory(), 'Download destination must be a regular directory');
    const target = path.join(directory, targetName);
    assert.ok(!fs.lstatSync(target, { throwIfNoEntry: false }), 'Download target already exists');
    if (expected) {
        assert.equal(asset.size, expected.size, 'Catalogue and descriptor size differ');
        assert.equal(asset.digest, `sha256:${expected.sha256}`, 'Catalogue and descriptor checksum differ');
    }
    // The physical basename can already be the logical name of another payload
    // manifest. Download privately, then move to its independently chosen name.
    const temporary = fs.mkdtempSync(path.join(directory, '.asset-download-'));
    try {
        execute(['release', 'download', origin, '--repo', catalogue.repository, '--pattern', name, '--dir', temporary],
            { timeout: asset.size <= MANIFEST_LIMIT ? 120000 : 20 * 60 * 1000 });
        const file = path.join(temporary, name); verifyDownloaded(file, asset, expected);
        assert.ok(!fs.lstatSync(target, { throwIfNoEntry: false }), 'Download target appeared during transfer');
        fs.renameSync(file, target);
        return target;
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function main() {
    if (process.argv.includes('--help')) {
        console.log('Usage: asset-catalogue.mjs --baseline <stable-tag> --output <new-json-file> [--repository owner/repo]\nReads GitHub metadata and bounded index/source manifests; resolves original tag commits and hashes; never builds or publishes.\nOutput: nora-reuse-baseline/1, expanded release assets, originCommits and sourceManifests.'); return;
    }
    const values = {};
    for (let i = 2; i < process.argv.length; i += 2) {
        const key = process.argv[i];
        assert.ok(['--baseline', '--output', '--repository'].includes(key) && !values[key] && process.argv[i + 1], 'Unknown, duplicate or incomplete option');
        values[key] = process.argv[i + 1];
    }
    assert.ok(values['--baseline'] && values['--output'], 'Specify --baseline and --output; see --help');
    const output = path.resolve(values['--output']);
    assert.ok(!fs.lstatSync(output, { throwIfNoEntry: false }), 'Baseline output must be a new file');
    const result = readAssetCatalogue({ repository: values['--repository'] || REPOSITORY, tag: values['--baseline'] });
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`Verified published baseline ${result.release.tag_name} at ${result.commit}; ${result.release.assets.length} complete assets.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
