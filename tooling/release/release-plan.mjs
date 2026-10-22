#!/usr/bin/env node
// This is a build decision, never acceptance of a package or permission to publish.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { translatePath } from '../layout.mjs';
import { releaseModuleFor } from './release-source.mjs';

export const PLATFORMS = Object.freeze(['darwin-arm64', 'darwin-x64', 'win32-x64']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = values => [...new Set(values)].sort();
const configPaths = ['tooling/source-layout.json', 'launcher/desktop/package.json', '.github/workflows/build-integrated-launcher.yml',
    '.github/workflows/publish-component-update.yml', '.github/workflows/publish-accepted-release.yml', 'launcher/desktop/package-lock.json'];
// Full normalized step bodies audited against 65a2a7a and 78f122e on 2026-10-21.
// Only these component-job verification bodies are exempt, never their titles.
// The historical inventory receipt is classified as verification, not accepted
// as native evidence: publication still requires the current schema-2 consumer.
// Any command/argument/env change needs another review. See release-process.md.
const reviewedComponentVerificationSteps = new Set([
    '238142be0d95ec58ef44b95d8f4259f441e5491c47f45a4dbe9d035b7d90f7c5', // prior contract tests
    '44562722440abb8c134a3649ba092ac04d54a1570c865fdfc9193029e46506a9', // tests include native evidence contracts
    'f9f4bb8bcec453dcbed827fe9a65ba4b93083c43e676b7ecf98889f26b9e0f07', // prior verifier/inventory receipt
    '5b7e5a671693d8bd6c6dde6063d63d61e725140a6920f6227d06c5f524708c91', // verifier; native receipt is sealed later
]);
// Exact old/new test-only steps reviewed for impact selection on 2026-10-22.
// This includes the source-only test venv/dependencies, never product/runtime
// installation. Changed commands, arguments, conditions or env need review again.
const reviewedNativeTestSelectionSteps = new Set([
    '2da6a1a8de7b860607192a9ecfa59ca19e4034d4944a4155cc6b7ba8dc057ec0',
    '97d29ed162654f5670ca0d0aa6f7c803650a44fbf477862972a852f6bf5051d4',
    '95dd44f2f8a846a7b3ba04b68d79fc221bc2e8db32afad1843f3fe74d285c588',
    'ccddb7416c1d7e33c6da352b3a1e84a8006cb8619b230ac09b2d58cec7f50ea5',
    '75aaad60faf77ee4ceb4b5fcfa7c725fef6ae7a87af877836fee0ad2e763fcf4',
    '90555be991486aeb1170bb58fc50ad299212c25eb7d4c8ba6eec2e62dc634baa',
    'bd4a02fcf8828755a63159928d1cfa0659210fdc2f8fc4e2e421244b9811066c',
    '9ffc4d62b7b66a3d866eb1de41406d71932a05f702df42129095470733826333',
    'c7125a45c8bc3879779152daa96dc4628d9e3f0e24b2dae97790d797292d0f9d',
    '38106a73d472a9903e47ea494896e2b8024fe25ab63e595a58d76547f2a1a2ce',
    'dc72a6fec093e498fb13cd37e8caa286bbfbc9914cadc42f4eeccc3a697c8e73',
    'df2533461418b2da689e4aff68dc70889bd51ad628d7f3e7f4b953ac6061b1a4',
    '7b85e8bdbbc0863965c70ef8f8fc2a50e44d2312553f4455226f008a9d69317d',
    'e22024d07d6feb836d5b76b281349a2e4a18856f72f2f0e174f642de1e737b82',
]);
const reviewedComponentTestSelectionSteps = new Set([
    '38106a73d472a9903e47ea494896e2b8024fe25ab63e595a58d76547f2a1a2ce',
    '0d1ca1161a0b88ea66935bd52b51f2a7e2f4a88ce0f3bd3088172e26b89da857',
    'a25c1740609ec5426762862d71173a8ff86c50a9c8b023dff2cead7f2e4039ec',
    'e1e89079723bce49871136dc774d3cff55618721f37d853d5a481f59f209251e',
    'ed0d250bbbf04ad0613215422008eb49c464332df032a5a0d8387502762aad94',
    '5e7fadd1bdcd9db6d9db9a0a3449c7c68e5f62d10a4f16917457a480db915810',
    '8e309e8319ea29445eb88ab88f2b84203d2d8025fd1aab6c86cfc4cd6ed6babd',
    'edb8c2e7d6490c109364770b3148ad785864646d9cc1857d8d9a1db0da7b8097',
]);
const fullTools = new Set(['tooling/layout.mjs', 'tooling/source-layout.json', 'tooling/release/release-source.mjs',
    'tooling/release/build-commands.mjs', 'tooling/release/package-release.mjs', 'tooling/release/package-release.sh',
    'tooling/release/system-release.mjs', 'tooling/release/asset-catalogue.mjs', 'tooling/release/app-only-release.mjs']);
const automation = new Set(['tooling/run.mjs', 'tooling/release/release-plan.mjs', 'tooling/release/publish-release.mjs',
    'tooling/release/publication-state.mjs', 'tooling/release/publication-source.cjs', 'tooling/release/publication-providers.mjs',
    'tooling/release/acceptance-baseline.mjs', 'tooling/release/app-only-acceptance.cjs',
    'tooling/release/app-only-native-ui.ps1', 'tooling/release/app-only-native-ui.applescript',
    'tooling/release/sourceforge-credentials.mjs', 'tooling/release/verify-publish-source.cjs',
    'tooling/release/reuse-windows-build.cjs', 'tooling/release/verify-launcher-release.cjs',
    'tooling/release/launcher-release-notes.cjs', 'tooling/release/package-local-launcher.mjs', 'tooling/release/final-consumer.mjs',
    'tooling/release/component-acceptance.mjs', 'tooling/release/jihulab-provider.mjs', 'tooling/release/jihulab-transport.mjs']);
const rootDocuments = new Set(['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'CONTEXT.md', 'LICENSE', '.gitignore', '.gitattributes']);
const engine = 'app/engine/sillytavern/';
const omitted = ['default/content/backgrounds/', 'default/content/Seraphina/', 'public/webfonts/NotoSans/',
    'public/webfonts/NotoSansMono/', 'src/tokenizers/', 'tests/'].map(name => engine + name);
const omittedFiles = new Set(['default/content/default_Seraphina.png', 'default/content/Eldoria.json',
    'public/lib/pdf.min.mjs', 'public/lib/pdf.worker.min.mjs', 'public/lib/epub.min.js', 'public/lib/jszip.min.js'].map(name => engine + name));
const allModules = ['nora-runtime', 'nora-web', 'tavern-engine', 'operations', 'updater', 'skills', 'nora-mcp', 'story-profile'];

function safeRelative(name) {
    assert.ok(typeof name === 'string' && name && !name.startsWith('/') && !/[\\:\0\r\n]/.test(name)
        && name.split('/').every(part => part && part !== '.' && part !== '..'), `Unsafe source path: ${name}`);
}

// Only the build job affects the delivered environment. Changing upload/test steps
// is not a binary input. Unrecognized changes inside a build step remain blocked.
export function workflowInputs(text = '', job = 'build') {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex(line => line.trimEnd() === `  ${job}:`);
    if (start < 0) return { environment: [], packaging: [], unknown: [], unrecognized: Boolean(text) };
    let end = start + 1;
    while (end < lines.length && !/^ {2}[\w-]+:\s*$/.test(lines[end])) end++;
    const body = lines.slice(start + 1, end);
    const normalize = block => block.filter(line => line.trim() && !/^\s*#/.test(line) && !/^\s*-\s+name\s*:/.test(line))
        .map(line => line.trim().replace(/\s+#.*$/, '')).join('\n');
    const environment = body.filter(line => /\b(?:runs-on|runner|node-version|python-version)\s*:/.test(line)
        || /"(?:runner|platform|arch|package_script)"\s*:/.test(line));
    const packaging = [], unknown = [];
    let block = [];
    const flush = () => {
        const value = normalize(block);
        const reviewedVerification = ((job === 'build-components' || job === 'publish')
            && reviewedComponentVerificationSteps.has(hash(value)))
            || (job==='build' && reviewedNativeTestSelectionSteps.has(hash(value)))
            || (job==='build-components' && reviewedComponentTestSelectionSteps.has(hash(value)));
        if (reviewedVerification) { block=[];return; }
        if (/actions\/setup-(?:node|python)@|repository:\s*clawling\/|hermes-agent\.nousresearch\.com\/|prepare-hermes-bootstrap|package-hermes-runtime|restore-launcher-runtime|UV_MANAGED_PYTHON|UV_PYTHON_INSTALL/.test(value)) environment.push(value);
        else if (/package-release\.(?:mjs|sh)|package-launcher-update|package-component-update|npm run pack:|npm (?:ci|install|prune)(?:\s|$)|electron-builder/.test(value)) packaging.push(value);
        // Step labels do not establish what a command does. Only a literal
        // test-only command or the existing artifact actions are recognized;
        // other changed execution content remains a review requirement.
        else if (!reviewedVerification && /^[- ]*(?:run|uses):/m.test(value)
            && !(/^(?:- )?run: node --test(?: tests\/[A-Za-z0-9_./*-]+)+$/.test(value)
                && value.split(/\s+/).filter(token => token.startsWith('tests/'))
                    .every(file => file.split('/').every(part => part && part !== '.' && part !== '..')))
            && !/^(?:- )?uses:\s*actions\/(?:checkout|upload-artifact|download-artifact)@/m.test(value)) unknown.push(value);
        block = [];
    };
    for (const line of body) {
        if (/^ {6}- /.test(line)) flush();
        block.push(line);
    }
    flush();
    return { environment: sorted(environment.map(line => line.trim())), packaging: sorted(packaging), unknown: sorted(unknown), unrecognized: false };
}

function configuration(contents) {
    const parse = name => contents[name] ? JSON.parse(contents[name]) : null;
    const layout = parse(configPaths[0]);
    if (layout) {
        assert.equal(layout.schema, 1, 'Unsupported source layout');
        assert.ok(Array.isArray(layout.rules), 'Missing source mapping');
        for (const pair of layout.rules) {
            assert.ok(Array.isArray(pair) && pair.length === 2 && pair.every(value => typeof value === 'string'));
            pair.forEach(value => safeRelative(value.replace(/\/$/, '')));
            assert.equal(pair[0].endsWith('/'), pair[1].endsWith('/'), 'Mismatched source mapping');
        }
    }
    const component = contents[configPaths[3]] || '';
    return { layout: layout?.rules || null, launcher: parse(configPaths[1]), launcherLock: parse(configPaths[5]), workflow: workflowInputs(contents[configPaths[2]]),
        componentWorkflow: workflowInputs(component, /^ {2}build-components:\s*$/m.test(component) ? 'build-components' : 'publish'),
        publicationWorkflowHasBuild: /(?:\bnode\s+[^\n]*(?:package-release|package-hermes-runtime|package-launcher-update)|\bnpm\s+(?:ci|install|run\s+(?:build|pack:))|\belectron-builder\b)/.test(contents[configPaths[4]] || '') };
}

// Version labels do not change npm's dependency closure. Ignore only the two
// package version labels, after proving both agree with this snapshot's package.
// Every other lock field (integrity, resolved, platform, scripts, format...) stays
// significant; absent/old/inconsistent lock evidence must take the full path.
function launcherLockInputs(config) {
    const lock = config?.launcherLock, manifest = config?.launcher;
    if (lock?.lockfileVersion !== 3 || !manifest?.name || !manifest.version
        || lock.name !== manifest.name || lock.version !== manifest.version
        || lock.packages?.['']?.name !== manifest.name || lock.packages[''].version !== manifest.version) return null;
    const normalized = structuredClone(lock);
    delete normalized.version; delete normalized.packages[''].version;
    const canonical = value => Array.isArray(value) ? value.map(canonical)
        : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    return JSON.stringify(canonical(normalized));
}

/** Read committed bytes without checking out, building, invoking npm, or using the network. */
export function readGitSnapshot(root, ref) {
    const git = (args, options = {}) => execFileSync('git', args, { cwd: root, maxBuffer: 512 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options });
    assert.ok(typeof ref === 'string' && ref && !ref.startsWith('-'), 'Use an explicit Git ref');
    const commit = git(['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
    assert.match(commit, /^[a-f0-9]{40}$/);
    const entries = git(['ls-tree', '-r', '-z', commit]).toString('utf8').split('\0').filter(Boolean).map(line => {
        const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
        assert.ok(match, 'Invalid Git tree entry'); safeRelative(match[4]);
        return { mode: match[1], type: match[2], oid: match[3], name: match[4] };
    }).filter(entry => !entry.name.startsWith('outputs/')).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const blobs = sorted(entries.filter(entry => entry.type === 'blob').map(entry => entry.oid));
    const output = blobs.length ? git(['cat-file', '--batch'], { input: blobs.join('\n') + '\n' }) : Buffer.alloc(0);
    const fingerprints = new Map(), content = new Map(); let offset = 0;
    for (const oid of blobs) {
        const newline = output.indexOf(10, offset); assert.ok(newline >= offset, 'Missing Git blob header');
        const match = /^([a-f0-9]+) blob (\d+)$/.exec(output.subarray(offset, newline).toString('utf8'));
        assert.ok(match && match[1] === oid, 'Unexpected Git blob');
        const size = Number(match[2]); offset = newline + 1;
        const bytes = output.subarray(offset, offset + size); assert.equal(bytes.length, size);
        fingerprints.set(oid, hash(bytes)); content.set(oid, bytes); offset += size + 1;
    }
    assert.equal(offset, output.length, 'Unexpected Git output suffix');
    const sourceFiles = Object.fromEntries(entries.map(entry => [entry.name, fingerprints.get(entry.oid) || hash(`gitlink:${entry.oid}`)]));
    const sourceModes = Object.fromEntries(entries.map(entry => [entry.name, entry.mode]));
    const contents = Object.fromEntries(entries.filter(entry => configPaths.includes(entry.name))
        .map(entry => [entry.name, content.get(entry.oid)?.toString('utf8')]));
    return { commit, ref, sourceFiles, sourceModes, sourceDigest: hash(JSON.stringify(sourceFiles)),
        configuration: configuration(contents), environmentInputs: null, contextVerified: true };
}

export function readManifestSnapshot(file, root) {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(manifest.schema, 'tavern-release/v2', 'Use a release source manifest');
    assert.equal(manifest.candidate, false, 'A candidate cannot be a stable build input');
    assert.equal(manifest.dirty, false, 'A dirty source cannot be planned for stable release');
    assert.match(manifest.commit || '', /^[a-f0-9]{40}$/);
    assert.ok(manifest.sourceFiles && Object.keys(manifest.sourceFiles).length, 'Missing source fingerprints');
    for (const [name, value] of Object.entries(manifest.sourceFiles)) { safeRelative(name); assert.match(value, /^[a-f0-9]{64}$/); }
    const sourceFiles = Object.fromEntries(Object.entries(manifest.sourceFiles).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    if (manifest.sourceDigest) assert.equal(manifest.sourceDigest, hash(JSON.stringify(sourceFiles)), 'Manifest source digest mismatch');
    let context = null;
    try { context = readGitSnapshot(root, manifest.commit); }
    catch { /* Unknown source context must force review, never assume the local checkout is equivalent. */ }
    if (context) {
        for (const name of configPaths) assert.equal(context.sourceFiles[name], sourceFiles[name], `Manifest/config mismatch: ${name}`);
        assert.deepEqual(sourceFiles, context.sourceFiles, 'Manifest source fingerprints differ from its claimed Git commit');
        if (manifest.sourceModes) assert.deepEqual(manifest.sourceModes, context.sourceModes, 'Manifest source modes differ from its claimed Git commit');
    }
    return { commit: manifest.commit, ref: file, sourceFiles, sourceModes: manifest.sourceModes || null,
        sourceDigest: hash(JSON.stringify(sourceFiles)), configuration: context?.configuration || null,
        environmentInputs: manifest.environmentInputs || null, contextVerified: Boolean(context) };
}

function launcherMembers(config) {
    if (!config?.launcher?.build || !config.layout) return null;
    const base = 'ops/installer/desktop';
    const entries = [['ops/installer/desktop/package.json', PLATFORMS], ['ops/installer/desktop/package-lock.json', PLATFORMS]];
    const add = (relative, platforms = PLATFORMS) => {
        assert.equal(typeof relative, 'string', 'Unsupported launcher build resource');
        assert.ok(!/[!*?{}]/.test(relative), `Review unsupported launcher resource glob: ${relative}`);
        const target = path.posix.normalize(path.posix.join(base, relative)); safeRelative(target);
        entries.push([target, platforms]);
    };
    for (const name of config.launcher.build.files || []) add(name);
    for (const resource of config.launcher.build.extraResources || []) {
        if (resource.to !== 'payload') add(resource.from);
    }
    if (config.launcher.build.icon) add(config.launcher.build.icon);
    if (config.launcher.build.nsis?.include) add(config.launcher.build.nsis.include, ['win32-x64']);
    return entries;
}

function delivery(name, config) { return config?.layout ? translatePath(name, config.layout) : name; }
function shipped(name) {
    if (omittedFiles.has(name) || omitted.some(prefix => name.startsWith(prefix))) return false;
    if (name.startsWith(`${engine}public/locales/`)) return ['lang.json', 'en.json', 'zh-cn.json', 'zh-tw.json'].includes(name.slice(`${engine}public/locales/`.length));
    if (name.startsWith('app/tests/') || /^(?:ops|nora-mcp)\/tests\//.test(name)) return false;
    if (name.startsWith('app/')) return true;
    if (name.startsWith('ops/installer/')) return !['launcher-ui-prototype.html', 'launcher-refinement-preview.html', 'launcher-directory-preview.html', 'launcher-directory-preview.js'].some(file => name === `ops/installer/${file}`);
    if (name.startsWith('ops/updater/') || name.startsWith('ops/hooks/tavern-liveware-register/')) return true;
    if (name.startsWith('ops/skills/')) return !/\/(?:tests|agents)\//.test(name);
    if (name.startsWith('ops/scripts/')) return /^ops\/scripts\/(?:runtime\.sh|bringup-native\.sh|provision\.sh|profile_memory\.py|analyze-(?:boot-metrics|runtime-phases)\.mjs|install-hermes-skills\.py|nora-instance\.py|nora-tavern-(?:update-check\.(?:py|sh)|card-send\.py))$/.test(name);
    if (name.startsWith('nora-mcp/')) return ['package.json', 'npm-shrinkwrap.json', 'README.md'].includes(name.slice(9));
    return false;
}

/** Compare source inputs; reasons are deliberately retained for independent review. */
export function createReleasePlan({ baseline = null, current, platforms = PLATFORMS }) {
    assert.ok(current?.sourceFiles && current.commit, 'Missing current source');
    for (const snapshot of [baseline, current].filter(Boolean)) {
        assert.match(snapshot.commit, /^[a-f0-9]{40}$/, 'Invalid source commit');
        assert.match(snapshot.sourceDigest, /^[a-f0-9]{64}$/, 'Missing source digest');
        for (const [name, fingerprint] of Object.entries(snapshot.sourceFiles)) { safeRelative(name); assert.match(fingerprint, /^[a-f0-9]{64}$/); }
    }
    assert.ok(platforms.length && platforms.every(platform => PLATFORMS.includes(platform)), 'Unsupported platform');
    const selected = sorted(platforms), changed = [], review = [], modules = new Set();
    const launcher = new Set(), hermesRuntime = new Set(), tavernDependencies = new Set(), launcherDependencies = new Set();
    const environment = { hermesRuntime, tavernDependencies, launcherDependencies };
    const add = (set, values = selected) => values.filter(value => selected.includes(value)).forEach(value => set.add(value));
    let metadata = false;
    let members;
    try { members = [...(launcherMembers(current.configuration) || []), ...(launcherMembers(baseline?.configuration) || [])]; }
    catch (error) { review.push(error.message); members = []; }
    if (!current.configuration?.layout || !current.configuration?.launcher) review.push('Missing verified source layout or launcher build configuration');
    const names = sorted([...Object.keys(baseline?.sourceFiles || {}), ...Object.keys(current.sourceFiles)]);
    const knownModules = sorted([...allModules, ...names.flatMap(name => {
        const target = delivery(name, current.configuration); return shipped(target) ? [releaseModuleFor(target)] : [];
    })]);
    for (const name of names) {
        const previous = baseline?.sourceFiles[name], next = current.sourceFiles[name];
        const modeChanged = baseline?.sourceModes && current.sourceModes && baseline.sourceModes[name] !== current.sourceModes[name];
        if (previous === next && !modeChanged) continue;
        const item = { path: name, status: !previous ? 'added' : !next ? 'deleted' : 'modified', roles: [], reasons: [], modules: [], platforms: [] };
        const reason = (role, text) => { item.roles.push(role); item.reasons.push(text); };
        const full = text => {
            reason('build-input', text); knownModules.forEach(module => modules.add(module));
            add(launcher); Object.values(environment).forEach(set => add(set)); metadata = true;
        };
        if (current.sourceModes?.[name] && !['100644', '100755'].includes(current.sourceModes[name])) {
            review.push(`Non-regular product source requires review: ${name}`); full('Git symlink or submodule input is not safely reusable');
        } else if (name.startsWith('tests/') || name.startsWith('docs/') || rootDocuments.has(name)
            || /^(?:app\/tests|app\/engine\/sillytavern\/tests|nora-mcp\/(?:tests|docs)|story-profile\/(?:tests|docs))\//.test(name)
            || ['tooling/README.md', 'local-state/README.md', 'story-profile/README.md'].includes(name)) {
            reason('verification-only', 'Not selected by the product delivery/build inputs');
        } else if (/^tooling\/release\/compatibility\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name)) {
            reason('components','Reviewed compatibility declaration changes release metadata, not runtime construction'); metadata=true;
        } else if (fullTools.has(name)) full('Shared packaging/projection/archive input affects product and environment construction');
        else if (name.startsWith('.github/')) {
            if (name === configPaths[4] && !current.configuration?.publicationWorkflowHasBuild) reason('verification-only', 'Audited accepted-artifact publication workflow does not construct product bytes');
            else if (name !== configPaths[2] && name !== configPaths[3]) { review.push(`Unclassified changed CI configuration: ${name}`); full('Other workflow/build automation has not been audited for product inputs'); }
            else {
                const key = name === configPaths[2] ? 'workflow' : 'componentWorkflow';
                const before = baseline?.configuration?.[key] || workflowInputs('');
                const after = current.configuration?.[key] || { unrecognized: true };
                if (after.unrecognized || before.unrecognized) { review.push(`Unrecognized build workflow: ${name}`); full('Build instructions cannot be compared safely'); }
                else if (JSON.stringify(before.unknown || []) !== JSON.stringify(after.unknown || [])) { review.push(`Unclassified changed build step: ${name}`); full('Changed workflow command is not an audited test/publication-only step'); }
                else if (JSON.stringify(before.environment) !== JSON.stringify(after.environment)) full('Native runner, Node/Python/ABI, external checkout or Hermes construction instructions changed');
                else if (JSON.stringify(before.packaging) !== JSON.stringify(after.packaging)) full('npm installation or product package construction instructions changed');
                else reason('verification-only', 'Build input instructions are unchanged; CI/test/upload orchestration changed');
            }
        } else if (automation.has(name) || name.startsWith('tooling/checks/')) reason('verification-only', 'Validation/publication tooling does not construct product bytes');
        else if (name === 'tooling/release/package-hermes-runtime.mjs' || name.startsWith('tooling/runtime/')) {
            reason('environment', 'Runtime packer, fixed ClawChat input or runtime audit/probe changed'); add(hermesRuntime); add(launcher); metadata = true;
        } else if (name === 'tooling/release/restore-launcher-runtime.cjs' || name === 'tooling/release/launcher-build-baseline.mjs') {
            full('Runtime restoration/reuse gate is part of the build closure');
        } else if (name === 'tooling/release/package-launcher-update.cjs') { reason('launcher', 'Lightweight launcher archive construction changed'); add(launcher); metadata = true; }
        else if (name === 'tooling/release/package-component-update.mjs') { reason('components', 'Component assembly changed; rebuild module descriptors without assuming environment equivalence'); knownModules.forEach(module => modules.add(module)); metadata = true; }
        else {
            const targets = sorted([delivery(name, baseline?.configuration), delivery(name, current.configuration)]);
            const affected = sorted(members.filter(([member]) => targets.some(target => target === member || target.startsWith(`${member}/`)))
                .flatMap(([, values]) => values).filter(platform => selected.includes(platform)));
            if (affected.length) { reason('launcher', 'Selected by actual launcher build.files/extraResources/icon/NSIS include'); add(launcher, affected); item.platforms = affected; metadata = true; }
            if (name === 'launcher/desktop/runtime.js') { reason('environment', 'Runtime packer imports this link normalization helper'); add(hermesRuntime); }
            if (name === 'launcher/desktop/package-lock.json') {
                const before = launcherLockInputs(baseline?.configuration), after = launcherLockInputs(current.configuration);
                if (before === null || after === null || before !== after) {
                    reason('launcher-dependencies', 'Electron/native launcher dependency lock changed or equivalence is unproven'); add(launcherDependencies);
                } else reason('launcher', 'Lockfile package-version metadata changed; exact dependency and toolchain lock inputs are unchanged');
            }
            if (name === 'launcher/desktop/package.json') {
                const dependencyInput = config => JSON.stringify([config?.launcher?.dependencies, config?.launcher?.devDependencies, config?.launcher?.engines]);
                if (dependencyInput(baseline?.configuration) !== dependencyInput(current.configuration)) {
                    reason('launcher-dependencies', 'Electron/native launcher dependency or engine requirement changed'); add(launcherDependencies);
                }
            }
            if ([`${engine}package.json`, `${engine}package-lock.json`, 'nora-mcp/package.json', 'nora-mcp/npm-shrinkwrap.json'].includes(name)) {
                reason('dependencies', 'npm build/install input changes production dependency closure'); add(tavernDependencies); add(launcher); metadata = true;
            }
            for (const target of targets) if (shipped(target)) {
                const module = releaseModuleFor(target); modules.add(module); item.modules.push(module);
                reason('components', `Delivered as ${module}: ${target}`); metadata = true;
                if (target.startsWith(`${engine}public/`) || target.startsWith('app/native-extensions/')) modules.add('nora-web');
            }
            if (/^nora-mcp\/(?:src\/|tsconfig\.json$)/.test(name)) { reason('components', 'TypeScript compilation input'); modules.add('nora-mcp'); metadata = true; }
            if (/^story-profile\/(?:core\/|public\/|adapters\/)/.test(name) || name === 'story-profile/package.json') {
                reason('components', 'Story Profile canonical source must be synchronized to embedded artifacts'); modules.add('story-profile'); modules.add('nora-web'); metadata = true;
            }
            if (name.startsWith(`${engine}build/`) || /webpack.*\.(?:mjs|js)$/.test(name)) {
                reason('components', 'Application bundler/build helper input'); ['nora-web', 'nora-runtime', 'tavern-engine'].forEach(module => modules.add(module)); metadata = true;
            }
            if (/^deployment\/update\/clawchat-(?:greeting-order\.patch|greeting_patch\.py)$/.test(name)
                || /^deployment\/shared\/clawchat-(?:greeting-order\.patch|greeting_patch\.py)$/.test(name)
                || name === 'deployment/shared/clawchat_greeting_patch.py') {
                reason('environment', 'ClawChat greeting transformation is sealed in integrated runtime'); add(hermesRuntime); add(launcher);
            }
            if (!item.roles.length && (omittedFiles.has(name) || omitted.some(prefix => name.startsWith(prefix)) || targets.every(target => !shipped(target) && /^(?:launcher\/previews\/|nora\/skills\/.*\/(?:tests|agents)\/)/.test(name)))) {
                reason('verification-only', 'Explicitly omitted source preview/test/sample');
            }
            if (!item.roles.length) { review.push(`Unclassified changed input: ${name}`); full('Unknown input: conservative full build and explicit review required'); }
        }
        item.roles = sorted(item.roles); item.reasons = sorted(item.reasons); item.modules = sorted(item.modules); changed.push(item);
    }
    if (JSON.stringify(baseline?.environmentInputs || null) !== JSON.stringify(current.environmentInputs || null)) {
        Object.values(environment).forEach(set => add(set)); add(launcher); metadata = true;
        changed.push({ path: '@environmentInputs', status: 'modified', roles: ['environment'], modules: [], platforms: selected,
            reasons: ['Recorded native toolchain, Node/Python ABI or external environment identity changed'] });
    }
    if (!baseline) { knownModules.forEach(module => modules.add(module)); add(launcher); Object.values(environment).forEach(set => add(set)); metadata = true; }
    if (review.length) { knownModules.forEach(module => modules.add(module)); add(launcher); Object.values(environment).forEach(set => add(set)); metadata = true; }
    const env = Object.fromEntries(Object.entries(environment).map(([name, set]) => [name, sorted(set)]));
    const environmentBuild = Object.values(env).some(values => values.length);
    const mode = review.length ? 'review-required' : environmentBuild ? 'full' : launcher.size ? 'launcher' : modules.size || metadata ? 'components' : 'verification-only';
    const identity = snapshot => snapshot ? { ref: snapshot.ref || null, commit: snapshot.commit, sourceDigest: snapshot.sourceDigest,
        sourceModesDigest: snapshot.sourceModes ? hash(JSON.stringify(snapshot.sourceModes)) : null } : { ref: 'EMPTY', commit: null, sourceDigest: null, sourceModesDigest: null };
    const plan = { schema: 'nora-release-plan/v1', baseline: identity(baseline), source: identity(current), initialRelease: !baseline,
        platforms: selected, mode, requiresReview: review.length > 0, review: sorted(review), changed,
        build: { modules: sorted(modules), launcher: sorted(launcher), environment: env, metadata },
        verification: sorted(['source-and-plan', ...(modules.size ? ['component-contracts'] : []),
            ...(mode === 'components' ? ['native-component-install-and-upgrade'] : []),
            ...(launcher.size || environmentBuild ? ['native-package-and-upgrade'] : []), 'sealed-artifact-provenance-before-publication']),
        buildWorkflow: mode === 'verification-only' ? null : mode === 'components'
            ? '.github/workflows/publish-component-update.yml' : '.github/workflows/build-integrated-launcher.yml',
        reuse: { sourceComparisonOnly: true, acceptedArtifactRequired: true,
            environmentEvidenceRequired: ['platform', 'architecture', 'Node/Python versions and ABI', 'external revisions', 'archive SHA256', 'build provenance'],
            limitations: ['Unpinned external downloads are not established by Git source equality',
                ...(!current.sourceModes || (baseline && !baseline.sourceModes) ? ['Manifest lacks file-mode fingerprints; verify accepted archive modes before reuse'] : [])] } };
    return { ...plan, planDigest: hash(JSON.stringify(plan)) };
}

function main(args = process.argv.slice(2)) {
    if (args.includes('--help') || args.includes('-h')) {
        console.log('Usage: node tooling/release/release-plan.mjs --base <ref|EMPTY> --head <ref> [--repo <path>] [--output <new-file>] [--github-output <file>]\n'
            + '   or: --baseline-manifest <release-manifest.json> --current-manifest <release-manifest.json>\n'
            + 'Reads committed inputs only; --target aliases --head. EMPTY requests a first full build.\n'
            + 'Prints a sealed JSON plan. Unknown inputs require explicit review and a conservative full build.\n'
            + 'Does not build, upload, publish, or validate reusable artifact bytes.'); return;
    }
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
        assert.ok(['--base', '--head', '--target', '--repo', '--output', '--github-output', '--baseline-manifest', '--current-manifest'].includes(args[index]), `Unknown option: ${args[index]}`);
        assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `Missing value: ${args[index]}`);
        assert.ok(!options[args[index]], `Duplicate option: ${args[index]}`); options[args[index]] = args[index + 1];
    }
    assert.ok(!(options['--head'] && options['--target']), 'Choose --head or --target');
    const root = path.resolve(options['--repo'] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
    const manifestMode = options['--baseline-manifest'] || options['--current-manifest'];
    let baseline, current;
    if (manifestMode) {
        assert.ok(options['--baseline-manifest'] && options['--current-manifest'] && !options['--base'] && !options['--head'] && !options['--target'], 'Choose exactly two refs or two manifests');
        baseline = readManifestSnapshot(options['--baseline-manifest'], root); current = readManifestSnapshot(options['--current-manifest'], root);
    } else {
        assert.ok(options['--base'] && (options['--head'] || options['--target']), 'Specify --base and --head');
        baseline = options['--base'] === 'EMPTY' ? null : readGitSnapshot(root, options['--base']);
        current = readGitSnapshot(root, options['--head'] || options['--target']);
    }
    const plan = createReleasePlan({ baseline, current }); const bytes = JSON.stringify(plan, null, 2) + '\n';
    if (options['--output']) fs.writeFileSync(path.resolve(options['--output']), bytes, { flag: 'wx' });
    else process.stdout.write(bytes);
    if (options['--github-output']) fs.appendFileSync(options['--github-output'], [
        `mode=${plan.mode}`, `requires_review=${plan.requiresReview}`, `product_build=${plan.mode !== 'verification-only'}`,
        `launcher_build=${plan.build.launcher.length > 0}`, `environment_build=${Object.values(plan.build.environment).some(values => values.length)}`,
        `platforms=${JSON.stringify(plan.build.launcher)}`, `plan_digest=${plan.planDigest}`,
        `build_workflow=${plan.buildWorkflow || ''}`,
    ].join('\n') + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { main(); } catch (error) { console.error(`Release plan rejected: ${error.message}`); process.exitCode = 1; }
}
