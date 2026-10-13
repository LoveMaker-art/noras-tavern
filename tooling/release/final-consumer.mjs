import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const platforms = ['darwin-arm64', 'darwin-x64', 'win32-x64'];
const modules = ['package.json', 'releases.js', 'launcher-update.js', 'release-network.js',
    'release-sources.js', 'release-sources.json', 'launcher-errors.js', 'telemetry-contract.json'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const maxAsar = 64 * 1024 * 1024;
function sealedMetadata(object) {
    assert.ok(object && Number.isSafeInteger(object.size) && object.size > 0 && object.size <= 4 * 1024 * 1024,
        'Final consumer metadata exceeds budget');
    assert.ok(fs.lstatSync(object.file).isFile() && !fs.lstatSync(object.file).isSymbolicLink(), 'Invalid sealed metadata file');
    const bytes = fs.readFileSync(object.file);
    assert.equal(bytes.length, object.size, 'Final consumer sealed metadata size changed');
    assert.equal(sha(bytes), object.sha256, 'Final consumer sealed metadata digest changed');
    return bytes;
}

// Only the packed selector and its JavaScript dependency are read. Native files,
// symlinks and unpacked paths are never materialized or executed by this gate.
export function readConsumerAsar(bytes) {
    assert.ok(bytes.length >= 16 && bytes.length <= maxAsar, 'Invalid consumer ASAR size');
    const headerSize = bytes.readUInt32LE(4), textSize = bytes.readUInt32LE(12);
    assert.equal(bytes.readUInt32LE(0), 4, 'Invalid ASAR size pickle');
    assert.ok(headerSize >= 8 && headerSize <= 8 * 1024 * 1024 && 8 + headerSize <= bytes.length);
    assert.equal(bytes.readUInt32LE(8), headerSize - 4, 'Invalid ASAR header pickle');
    assert.ok(textSize > 0 && textSize <= headerSize - 8, 'Invalid ASAR JSON bounds');
    const header = JSON.parse(bytes.subarray(16, 16 + textSize).toString('utf8'));
    const result = new Map(), base = 8 + headerSize;
    function read(node, name) {
        assert.ok(node && !node.link && !node.unpacked && !node.files, `Unsupported consumer member: ${name}`);
        assert.ok(Number.isSafeInteger(node.size) && node.size >= 0 && node.size <= 8 * 1024 * 1024);
        assert.match(node.offset, /^(?:0|[1-9][0-9]*)$/);
        const offset = Number(node.offset);
        assert.ok(Number.isSafeInteger(offset) && offset >= 0 && base + offset + node.size <= bytes.length,
            `Consumer member escapes ASAR: ${name}`);
        const content = bytes.subarray(base + offset, base + offset + node.size);
        if (node.integrity) {
            assert.equal(node.integrity.algorithm, 'SHA256');
            assert.equal(node.integrity.hash, sha(content), `Consumer member integrity differs: ${name}`);
        }
        result.set(name, content);
    }
    for (const name of modules) read(header.files?.[name], name);
    function dependency(node, prefix) {
        assert.ok(node && !node.link && !node.unpacked, `Invalid consumer dependency: ${prefix}`);
        if (!node.files) { read(node, prefix); return; }
        for (const [name, item] of Object.entries(node.files)) {
            assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
            assert.ok(name !== '.' && name !== '..');
            dependency(item, prefix + '/' + name);
        }
    }
    dependency(header.files?.node_modules?.files?.semver, 'node_modules/semver');
    assert.ok(result.has('node_modules/semver/package.json'), 'Missing shipped semver');
    return result;
}

function packedConsumer(file) {
    // Python's ZIP reader reads just this bounded member, not the 100 MB runtime
    // or any path chosen by the archive. The publisher already verifies ZIP SHA.
    const program = `import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 members=[i for i in z.infolist() if i.filename=='resources/app.asar' or i.filename.endswith('.app/Contents/Resources/app.asar')]
 assert len(members)==1, 'Expected exactly one shipped launcher app.asar'
 member=members[0]
 assert not member.is_dir() and 16 <= member.file_size <= ${maxAsar}
 assert all(p not in ('', '.', '..') for p in member.filename.split('/'))
 with z.open(member) as stream:
  data=stream.read(${maxAsar + 1})
  assert len(data)==member.file_size
  sys.stdout.buffer.write(data)
`;
    return execFileSync(process.env.NORA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
        ['-B', '-c', program, file], {maxBuffer:maxAsar, timeout:30000, windowsHide:true});
}

// This is a final metadata-consumption gate, not native installation/GUI proof.
// Those independent reports remain mandatory in publication-source.cjs.
async function consumeFinalMetadata({plan, release}) {
    assert.ok(plan && release, 'Final consumer gate requires the sealed distribution');
    const byUrl = new Map(plan.objects.filter(item => item.phase === 'asset').map(item => [
        `https://github.com/${plan.repository}/releases/download/${item.assetReleaseTag || plan.tag}/${path.basename(item.key)}`, item]));
    const catalogue = Buffer.from(JSON.stringify(release));
    const report = {schema:'nora-final-consumer/1', scope:'shipped-selector-with-final-distribution-metadata',
        repository:plan.repository, tag:plan.tag, commit:plan.commit, catalogueSha256:sha(catalogue), platforms:{}};
    for (const target of platforms) {
        const [platform, arch] = target.split('-');
        const url = name => `https://github.com/${plan.repository}/releases/download/${plan.tag}/${name}`;
        const descriptorObject = byUrl.get(url(`nora-launcher-${target}.json`));
        assert.ok(descriptorObject, `Final consumer gate: missing shipped launcher ${target}`);
        const descriptor = JSON.parse(sealedMetadata(descriptorObject));
        assert.equal(descriptor.schema, 'nora-launcher/v1'); assert.equal(descriptor.candidate, false);
        assert.equal(descriptor.platform, platform); assert.equal(descriptor.arch, arch);
        assert.match(descriptor.version, /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-beta\.[0-9]+)?$/);
        assert.match(descriptor.commit, /^[a-f0-9]{40}$/);
        if (plan.mode === 'full') assert.equal(descriptor.commit, plan.commit, 'Shipped launcher product commit differs');
        assert.equal(descriptor.asset, `Nora-Tavern-Launcher-${descriptor.version}-${target}-update.zip`);
        const archive = byUrl.get(url(descriptor.asset));
        assert.ok(archive && archive.sha256 === descriptor.sha256 && archive.size === descriptor.size,
            `Final consumer gate: shipped launcher identity differs for ${target}`);
        const archiveHash = crypto.createHash('sha256'); let archiveSize = 0;
        assert.ok(fs.lstatSync(archive.file).isFile() && !fs.lstatSync(archive.file).isSymbolicLink(), 'Invalid shipped launcher archive');
        for await (const chunk of fs.createReadStream(archive.file)) {archiveHash.update(chunk); archiveSize += chunk.length;}
        assert.equal(archiveSize, archive.size, 'Final consumer shipped archive size changed');
        assert.equal(archiveHash.digest('hex'), archive.sha256, 'Final consumer shipped archive digest changed');
        const asar = packedConsumer(archive.file), files = readConsumerAsar(asar);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-final-consumer-'));
        const calls = [];
        try {
            for (const [name, bytes] of files) {
                const file = path.join(directory, name);
                fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, bytes);
            }
            const require = createRequire(path.join(directory, 'package.json'));
            const pkg = JSON.parse(files.get('package.json'));
            assert.equal(pkg.version, descriptor.version, 'Shipped launcher package version differs');
            const consumer = require('./releases.js');
            const shippedSources=JSON.parse(files.get('release-sources.json'));
            const {sourceCandidates} = require('./release-sources.js');
            const discoveryUrl=plan.channel==='beta'
                ?`https://api.github.com/repos/${plan.repository}/releases?per_page=100&page=1`
                :`https://api.github.com/repos/${plan.repository}/releases/latest`;
            const primarySource=sourceCandidates(discoveryUrl,{channel:plan.channel,sources:shippedSources})[0];
            const primaryPublisher=primarySource.provider || primarySource.id;
            const effectiveDestinations=plan.destinations===undefined?['github','sourceforge']:plan.destinations;
            if(primaryPublisher)
                assert.ok(effectiveDestinations.includes(primaryPublisher),
                    `Shipped primary source ${primaryPublisher} is missing from publication destinations`);
            // Use the shipped source mapper, so this gate exercises the exact
            // build-owned roots and ordering. Each physical URL still maps to
            // one sealed logical object; no host or basename wildcard exists.
            const physicalObjects = new Map();
            for (const [logical, object] of byUrl) for (const candidate of sourceCandidates(logical, {channel:plan.channel})) {
                const previous = physicalObjects.get(candidate.url);
                assert.ok(!previous || previous === object, 'Conflicting final consumer resource mapping');
                physicalObjects.set(candidate.url, object);
            }
            const api = `https://api.github.com/repos/${plan.repository}/releases`;
            const catalogueUrls = new Map();
            for (const [logical, list] of [[api + `/tags/${plan.tag}`, false],
                ...(plan.channel === 'stable' ? [[api + '/latest', false]] : [[api + '?per_page=100&page=1', true]])])
                for (const candidate of sourceCandidates(logical, {channel:plan.channel}))
                    catalogueUrls.set(candidate.url, list);
            const fetcher = async address => {
                const value = String(address);
                let bytes;
                if (catalogueUrls.has(value)) bytes = catalogueUrls.get(value) ? Buffer.from(JSON.stringify([release])) : catalogue;
                else {
                    const object = physicalObjects.get(value);
                    assert.ok(object, `Final consumer requested an unsealed resource: ${value}`);
                    bytes = sealedMetadata(object);
                }
                calls.push({url:value, sha256:sha(bytes)});
                const response = new Response(bytes);
                Object.defineProperty(response, 'url', {value});
                return response;
            };
            const modes = {};
            for (const mode of ['install', 'update']) {
                const selected = await consumer.selectPlan({mode, tag:plan.tag, platform, arch, fetcher,
                    launcherVersion:pkg.version, channel:plan.channel,
                    networkPolicy:{attempts:1, maxAttempts:1, totalBudgetMs:5000, attemptTimeoutMs:2000}});
                assert.equal(selected.commit, plan.commit, 'Consumer selected a different product');
                const expectedName = mode === 'install' ? selected.systemManifest.files['release-manifest.json'].asset : 'release-manifest.json';
                const expected = byUrl.get(url(expectedName));
                assert.ok(expected && sha(Buffer.from(selected.releaseManifestText)) === expected.sha256,
                    `Consumer selected a different ${mode} manifest`);
                if (mode === 'install') for (const name of modules.filter(name => name !== 'package.json')) {
                    // Native APP reports are bound to these same payload module
                    // hashes. A different final update ZIP cannot borrow them.
                    assert.equal(sha(files.get(name)), selected.releaseManifest.artifacts?.[`ops/installer/desktop/${name}`],
                        `Shipped consumer module differs from accepted payload: ${name}`);
                }
                // planId includes the time of this check. Record deterministic
                // byte identity so an unchanged resumed plan keeps its receipt.
                assert.match(selected.planId, /^[a-f0-9]{64}$/);
                consumer.validatePlan(selected, {mode, tag:plan.tag, platform, arch,
                    launcherVersion:pkg.version, channel:plan.channel});
                modes[mode] = {validatedPlan:true, manifest:expectedName, manifestSha256:expected.sha256};
            }
            report.platforms[target] = {launcherVersion:pkg.version, archiveSha256:archive.sha256,
                asarSha256:sha(asar), moduleHashes:Object.fromEntries(modules.map(name => [name, sha(files.get(name))])), modes, metadata:calls};
        } catch (error) {
            throw new Error(`Final consumer gate failed for ${target}: ${error.message}`, {cause:error});
        } finally {
            const cache = createRequire(import.meta.url).cache;
            for (const name of Object.keys(cache)) if (name.startsWith(directory + path.sep)) delete cache[name];
            fs.rmSync(directory, {recursive:true, force:true});
        }
    }
    return report;
}

export async function verifyFinalConsumers(publication) {
    // A malformed client cannot keep the publishing process waiting forever.
    // The child consumes only local sealed metadata; this is never a native
    // executable/GUI test and does not use the publisher's selector source.
    try {
        const output = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--consume'], {
            input:JSON.stringify({plan:publication.plan,release:publication.release}), encoding:'utf8',
            timeout:60000, maxBuffer:4 * 1024 * 1024, windowsHide:true, stdio:['pipe','pipe','pipe']});
        return JSON.parse(output);
    } catch (error) {
        const reason = error.stderr?.trim() || error.message;
        throw new Error(`Final consumer acceptance failed: ${reason}`, {cause:error});
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    assert.deepEqual(process.argv.slice(2), ['--consume']);
    try {
        const report = await consumeFinalMetadata(JSON.parse(fs.readFileSync(0, 'utf8')));
        process.stdout.write(JSON.stringify(report));
    } catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
}
