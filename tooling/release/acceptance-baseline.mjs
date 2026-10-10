#!/usr/bin/env node
// Acceptance consumes a published payload. It never restores compiler outputs,
// selects build dependencies, or authorizes reuse of the current runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readAssetCatalogue, downloadCatalogueAsset, assertBaselineCatalogue, REPOSITORY } from './asset-catalogue.mjs';

const platforms = ['darwin-arm64', 'darwin-x64', 'win32-x64'];
const metadataNames = ['release-manifest.json', 'nora-hermes-runtime.json', 'nora-tavern-dependencies.json'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const text = value => JSON.stringify(value, null, 2) + '\n';
const name = value => { assert.match(value || '', /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Unsafe acceptance component name'); return value; };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function closure(system, platform, catalogue) {
    assert.ok(object(system.files), 'Missing historical system file closure');
    const names = Object.keys(system.files), unique = new Set();
    assert.ok(names.length > 0 && names.length <= 256, 'Invalid historical component count');
    for (const logical of names) {
        name(logical);
        assert.ok(!['nora-system.json', `nora-system-${platform}.json`, 'baseline-source-receipt.json', 'baseline-asset-catalogue.json'].includes(logical), 'Historical payload conflicts with acceptance controls');
        assert.ok(!unique.has(logical.toLowerCase()), 'Duplicate historical logical name'); unique.add(logical.toLowerCase());
        const entry = system.files[logical]; assert.ok(object(entry)); name(entry.asset);
        assert.equal(entry.asset, `${platform}-${logical}`, 'Historical system refers to another platform or logical component');
        assert.match(entry.sha256 || '', /^[a-f0-9]{64}$/);
        assert.ok(Number.isSafeInteger(entry.size) && entry.size > 0, 'Missing historical component size');
        const asset = catalogue.release.assets.find(item => item.name === entry.asset);
        assert.ok(asset, `Missing published historical component: ${entry.asset}`);
        assert.equal(asset.size, entry.size, 'Historical catalogue and system size differ');
        assert.equal(asset.digest, `sha256:${entry.sha256}`, 'Historical catalogue and system checksum differ');
    }
    assert.ok(metadataNames.every(logical => system.files[logical]), 'Missing historical identity/runtime/dependencies descriptor');
    return names;
}
function payloadClosure(identity, runtime, dependencies, system, platform) {
    assert.equal(identity.schema, 'tavern-release/v2');
    assert.ok(object(identity.archives), 'Missing historical business archives');
    for (const part of ['app', 'ops', 'nora-mcp']) assert.ok(identity.archives[part], `Missing historical ${part} archive`);
    for (const entry of Object.values(identity.archives)) {
        name(entry.name); assert.match(entry.sha256 || '', /^[a-f0-9]{64}$/);
        assert.equal(system.files[entry.name]?.sha256, entry.sha256, 'Historical business archive differs from system');
        if (entry.size !== undefined) assert.equal(system.files[entry.name].size, entry.size);
    }
    for (const [descriptor, key] of [[runtime, 'hermesRuntime'], [dependencies, 'dependencies']]) {
        assert.equal(descriptor.schema, 1); assert.equal(`${descriptor.platform}-${descriptor.arch}`, platform);
        name(descriptor.archive); assert.match(descriptor.sha256 || '', /^[a-f0-9]{64}$/);
        assert.equal(descriptor.sha256, identity[key]?.sha256, 'Historical environment identity differs from payload');
        assert.equal(system.files[descriptor.archive]?.sha256, descriptor.sha256, 'Historical environment archive differs from system');
        assert.equal(system.files[descriptor.archive].size, descriptor.size, 'Historical environment size differs from system');
    }
}
function catalogueProof(catalogue) {
    // Exclude GitHub's volatile counters/timestamps. This is an immutable asset
    // identity receipt, rather than the hash of a changing API response.
    return { schema: 'nora-baseline-asset-catalogue/1', repository: catalogue.repository,
        tag: catalogue.release.tag_name, commit: catalogue.commit, originCommits: catalogue.originCommits,
        sourceManifests: catalogue.sourceManifests, assets: catalogue.release.assets.map(asset => ({ name: asset.name,
            size: asset.size, sha256: asset.digest.slice(7), assetReleaseTag: asset.asset_release_tag || catalogue.release.tag_name,
            url: asset.browser_download_url })).sort((a, b) => a.name.localeCompare(b.name, 'en')) };
}

/** Read and bind only the historical JSON descriptors. Does not download any
 * environment/business archive or apply the current compiler reuse rules. */
function readAcceptanceSource({ repository = REPOSITORY, tag, platform, expectedCommit, execute } = {}) {
    assert.ok(platforms.includes(platform), 'Select a supported native platform');
    if (expectedCommit !== undefined) assert.match(expectedCommit, /^[a-f0-9]{40}$/);
    const catalogue = readAssetCatalogue({ repository, tag, execute });
    if (expectedCommit !== undefined) assert.equal(catalogue.commit, expectedCommit, 'Historical tag changed from its selected commit');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-acceptance-identity-'));
    try {
        const systemName = `nora-system-${platform}.json`, systemAsset = catalogue.release.assets.find(asset => asset.name === systemName);
        assert.ok(systemAsset && systemAsset.size <= 8 * 1024 * 1024, 'Historical system descriptor is missing or oversized');
        const systemFile = downloadCatalogueAsset(catalogue, systemName, temporary, { execute });
        const systemBytes = fs.readFileSync(systemFile), system = JSON.parse(systemBytes);
        assert.equal(system.schema, 'nora-system/v1'); assert.equal(`${system.platform}-${system.arch}`, platform);
        assertBaselineCatalogue(catalogue, system);
        const names = closure(system, platform, catalogue), metadata = { [systemName]: systemBytes };
        for (const logical of metadataNames) {
            const entry = system.files[logical]; assert.ok(entry.size <= 8 * 1024 * 1024, 'Historical JSON descriptor exceeds limit');
            const file = downloadCatalogueAsset(catalogue, entry.asset, temporary, { execute, targetName: logical, expected: entry });
            metadata[logical] = fs.readFileSync(file);
        }
        const identity = JSON.parse(metadata['release-manifest.json']); assertBaselineCatalogue(catalogue, identity);
        payloadClosure(identity, JSON.parse(metadata['nora-hermes-runtime.json']), JSON.parse(metadata['nora-tavern-dependencies.json']), system, platform);
        const proof = text(catalogueProof(catalogue));
        const files = Object.fromEntries(names.map(logical => {
            const entry = system.files[logical], asset = catalogue.release.assets.find(item => item.name === entry.asset);
            return [logical, { ...entry, assetReleaseTag: asset.asset_release_tag || tag }];
        }));
        const receipt = { schema: 'nora-acceptance-baseline/1', mode: 'identity-only', repository, tag, platform,
            commit: catalogue.commit, version: system.version, systemManifestSha256: sha(systemBytes),
            payloadManifestSha256: sha(metadata['release-manifest.json']), catalogueSha256: sha(proof), files,
            declaredFiles: names.length, verifiedFiles: metadataNames.length, verifiedNames: [...metadataNames] };
        return { catalogue, system, identity, metadata, proof, receipt };
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export function readAcceptanceIdentity(options) { return readAcceptanceSource(options).receipt; }

/** New private, flat logical payload directory for the existing native harness.
 * Failure removes only this invocation's incomplete output directory. */
export function materializeAcceptanceBaseline({ output, identityOnly = false, ...options } = {}) {
    assert.ok(typeof output === 'string' && output, 'Specify a new acceptance output directory'); output = path.resolve(output);
    assert.ok(!fs.lstatSync(output, { throwIfNoEntry: false }), 'Acceptance output must be a new directory');
    const source = readAcceptanceSource(options);
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    try {
        for (const [logical, bytes] of Object.entries(source.metadata)) fs.writeFileSync(path.join(output, logical), bytes, { flag: 'wx', mode: 0o600 });
        fs.writeFileSync(path.join(output, 'nora-system.json'), source.metadata[`nora-system-${options.platform}.json`], { flag: 'wx', mode: 0o600 });
        const receipt = { ...source.receipt };
        if (!identityOnly) {
            for (const [logical, entry] of Object.entries(source.system.files)) {
                if (metadataNames.includes(logical)) continue;
                downloadCatalogueAsset(source.catalogue, entry.asset, output, { execute: options.execute, targetName: logical, expected: entry });
            }
            receipt.mode = 'materialized'; receipt.verifiedNames = Object.keys(source.system.files); receipt.verifiedFiles = receipt.verifiedNames.length;
        }
        fs.writeFileSync(path.join(output, 'baseline-asset-catalogue.json'), source.proof, { flag: 'wx', mode: 0o600 });
        fs.writeFileSync(path.join(output, 'baseline-source-receipt.json'), text(receipt), { flag: 'wx', mode: 0o600 });
        return receipt;
    } catch (error) { fs.rmSync(output, { recursive: true, force: true }); throw error; }
}
function main() {
    if (process.argv.includes('--help')) {
        console.log('Usage: acceptance-baseline.mjs --tag STABLE_TAG --platform darwin-arm64|darwin-x64|win32-x64 --output NEW_DIR [--repository OWNER/REPO] [--expected-commit SHA] [--identity-only]\nFull mode downloads the exact historical system closure into a flat logical payload for native acceptance.\nIdentity-only verifies JSON/API identities, records its limited verification level and never downloads large archives.\nBoth modes are read-only remote operations and never build, publish, or authorize runtime reuse.'); return;
    }
    const values = {}, flags = new Set();
    for (let i = 2; i < process.argv.length; i++) {
        const option = process.argv[i];
        if (option === '--identity-only') { assert.ok(!flags.has(option), 'Duplicate option'); flags.add(option); continue; }
        assert.ok(['--tag', '--platform', '--output', '--repository', '--expected-commit'].includes(option) && !values[option], 'Unknown or duplicate option');
        const value = process.argv[++i]; assert.ok(value && !value.startsWith('--'), 'Missing option value'); values[option] = value;
    }
    assert.ok(values['--tag'] && values['--platform'] && values['--output'], 'Specify --tag, --platform and --output; see --help');
    const receipt = materializeAcceptanceBaseline({ tag: values['--tag'], platform: values['--platform'], output: values['--output'],
        repository: values['--repository'] || REPOSITORY, expectedCommit: values['--expected-commit'], identityOnly: flags.has('--identity-only') });
    console.log(`Verified ${receipt.mode} historical baseline ${receipt.tag} (${receipt.platform}) at ${receipt.commit}; ${receipt.verifiedFiles}/${receipt.declaredFiles} payload files.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
