import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildCommand } from './build-commands.mjs';
import { embedReleaseSources } from './embed-release-sources.mjs';
import { projectDelivery, readLayout, translatePath } from '../../tooling/layout.mjs';

export function digest(value) { return createHash('sha256').update(value).digest('hex'); }
export const LAUNCHER_CAPABILITIES=Object.freeze({operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2});
export const UPDATER_CAPABILITIES=Object.freeze({operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2});
export const UPDATER_DEPENDENCY_ROOT = 'ops/updater/actor-dependencies';
const ACTOR_DEPENDENCIES = Object.freeze({ 'fs-native-extensions': '1.5.1', semver: '7.8.5' });
const MODEL_SKILL_SCRIPTS = ['configure_provider.py']
    .map(name => `ops/skills/system/model-provider-config/scripts/${name}`);

export const NORA_SYSTEM_REQUIRED_FILES = [
    'app/engine/sillytavern/src/nora-world-core/builtin-welcome.js',
    'app/engine/sillytavern/src/nora-world-core/builtin/welcome-zh.md',
    'ops/installer/first_install.py', 'ops/installer/nora_system.py', 'ops/installer/nora_profile.py',
    'ops/installer/templates/SOUL.md', 'ops/installer/templates/greeting.md',
    'ops/hooks/tavern-liveware-register/HOOK.yaml', 'ops/hooks/tavern-liveware-register/handler.py',
    'ops/updater/liveware_integration.py', 'ops/updater/liveware_notice.py', 'ops/updater/runtime_lock.py',
    'ops/updater/managed_context.py', 'ops/installer/update_recovery.py', 'ops/installer/error_diagnostics.py',
    'ops/installer/operation_control.py', 'ops/installer/operation_cli.py', 'ops/installer/operation_node.mjs', 'ops/installer/operation_evidence.py', 'ops/installer/operation-budget.json',
    'ops/installer/desktop/operation-delegate.js', 'ops/installer/desktop/operation-history.js',
    'ops/installer/desktop/updater-task.js', 'ops/installer/desktop/updater-capability.js', 'ops/installer/desktop/updater-policy.js',
    'ops/updater/task.py', 'ops/updater/task_backend.py',
    ...['receipt.json', 'package.json', 'package-lock.json'].map(name => `${UPDATER_DEPENDENCY_ROOT}/${name}`),
    'ops/installer/mcp_probe.mjs',
    'ops/updater/clawchat_greeting_patch.py', 'ops/updater/clawchat-greeting-order.patch',
    'ops/scripts/nora-instance.py', 'ops/scripts/nora-tavern-update-check.py',
    'ops/scripts/nora-tavern-card-send.py', 'ops/skills/agents-tavern.md',
    ...MODEL_SKILL_SCRIPTS,
    ...['hermes_model_config.py', 'hermes_model_probe.py', 'hermes_model_state.py'].map(name => `ops/installer/${name}`),
    ...['scripts/library.py', 'scripts/activate.py', 'references/sources.json']
        .map(name => `ops/skills/creative/nora-skill-library/${name}`),
    ...['references/starter-stories.md', 'scripts/starter-story.py',
        'resources/starter-stories/manifest.json', 'resources/starter-stories/suzhou-rain.json',
        'resources/starter-stories/xiamen-breeze.json'].map(name => `ops/skills/creative/nora-cardforge/${name}`),
    ...['creative/tavern', 'creative/tavern-ops', 'creative/nora-cardforge', 'system/tavern-updater', 'system/model-provider-config', 'creative/nora-skill-library']
        .map(name => `ops/skills/${name}/SKILL.md`),
];

export function assertNoraSystemArtifacts(files) {
    const selected = new Set(files);
    const missing = NORA_SYSTEM_REQUIRED_FILES.filter(file => !selected.has(file));
    if (missing.length) throw new Error(`Incomplete Nora system artifacts: ${missing.join(', ')}`);
}

export function assertSafeReleasePath(relative, { updaterDependencies = false } = {}) {
    const parts = relative.split('/');
    if (!relative || path.isAbsolute(relative) || parts.some(part => !part || part === '..') || /[\r\n\0\\]/.test(relative)) {
        throw new Error(`Unsafe release path: ${relative}`);
    }
    const defaultTemplate = ['app/engine/sillytavern/default/config.yaml', 'app/engine/sillytavern/default/content/settings.json'].includes(relative);
    if (relative.startsWith('outputs/')
        || parts.some(part => ['.git', 'local-state', 'tavern-state', 'data', 'logs', 'backups', '__pycache__', '_cache'].includes(part))
        || (parts.includes('node_modules') && !(updaterDependencies && relative.startsWith(`${UPDATER_DEPENDENCY_ROOT}/node_modules/`)))
        || parts.some(part => /^\.env(?:\.|$)/.test(part))
        || (!defaultTemplate && /(?:^|\/)(?:secrets\.json|config\.yaml|settings\.json|cookie-secret\.txt|apps\.json)$/.test(relative))
        || /(?:^|\/)(?:model_configs\.json|model-input\.json|secrets\.json)(?:\.[^/]*)?$/.test(relative)
        || /\.(?:log|pyc|pem|key)$/.test(relative)) {
        throw new Error(`Private/runtime file is forbidden in a release: ${relative}`);
    }
}

export function assertSafeReleaseContent(relative, bytes) {
    if (!/\.(?:js|mjs|cjs|json|ya?ml|py|sh|env|md|txt)$/.test(relative)) return;
    const content = bytes.toString('utf8');
    if (relative === 'app/engine/sillytavern/default/content/settings.json') {
        // Inspect the template itself, not only key prefixes: private provider
        // keys need not look like sk-*. Generation parameters and API support
        // code are not saved account/model selections and remain available.
        const modelField = /^(?:.*_model|model_.*|model|models|modelProfiles|hermesModel|activeModel|api_server(?:_.*)?|apiUrl|apiKey|api_key|custom_url|reverse_proxy|proxy_password|api_url_.*|secretId|connectionProfiles|selectedProfile)$/;
        const empty = value => value == null || value === '' || value === false
            || (typeof value === 'object' && Object.keys(value).length === 0);
        const inspect = (value, location = '') => {
            if (!value || typeof value !== 'object') return;
            for (const [key, item] of Object.entries(value)) {
                const field = location ? `${location}.${key}` : key;
                if (modelField.test(key) && !empty(item)) {
                    throw new Error(`Model configuration is forbidden in release defaults: ${field}`);
                }
                inspect(item, field);
            }
        };
        inspect(JSON.parse(content));
    }
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)
        || /\b(?:sk-[A-Za-z0-9_-]{32,}|ghp_[A-Za-z0-9]{30,})\b/.test(content)) {
        throw new Error(`Potential credential in release file: ${relative}`);
    }
}

export function createReleaseSource(root, { candidate = false } = {}) {
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const commit = git(['rev-parse', 'HEAD']).trim();
    const dirty = Boolean(git(['status', '--porcelain', '--untracked-files=all']).trim());
    if (dirty && !candidate) throw new Error('Stable packaging requires a clean committed tree. Use --candidate for local verification only.');
    const files = [...new Set(git(candidate ? ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
        : ['ls-tree', '-r', '--name-only', '-z', commit]).split('\0').filter(relative => relative && !relative.startsWith('outputs/')))].sort();
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-release-source-'));
    const hashes = {};
    try {
        if (!candidate) {
            const archive = execFileSync('git', ['archive', '--format=tar', commit], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
            const extract = buildCommand('tar', ['-x', '-C', stage]);
            execFileSync(extract.command, extract.args, { input: archive, env: { ...process.env, COPYFILE_DISABLE: '1' } });
            // Historical tracked evidence is excluded as well as new ignored
            // reports. This removes only the disposable export's copy.
            fs.rmSync(path.join(stage, 'outputs'), { recursive: true, force: true });
        }
        for (const relative of files) {
            const source = path.join(candidate ? root : stage, relative);
            if (!fs.existsSync(source) && candidate) continue;
            const stat = fs.lstatSync(source);
            if (!stat.isFile()) throw new Error(`Release source must be a regular file: ${relative}`);
            // GitHub source exports must be as clean as runtime archives. The
            // sole local-state member is documentation, never installation data.
            if (relative !== 'local-state/README.md') assertSafeReleasePath(relative);
            const bytes = fs.readFileSync(source);
            assertSafeReleaseContent(relative, bytes);
            hashes[relative] = digest(bytes);
            if (candidate) {
                const target = path.join(stage, relative);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, bytes, { mode: stat.mode & 0o777 });
            }
        }
        // Source fingerprints describe authored bytes. Seal generated entry
        // configuration only in the disposable export, with its own receipt.
        let generatedSourceFiles;
        if (['launcher/desktop/release-sources.json', 'ops/installer/desktop/release-sources.json']
            .some(relative => Object.hasOwn(hashes, relative))) {
            const report = embedReleaseSources(stage);
            const rules = readLayout(stage);
            if (hashes[report.configurationPath] !== report.configurationSha256
                || report.files.some(file => hashes[file.path] !== file.beforeSha256))
                throw new Error('Generated release sources do not match the recorded authored inputs');
            generatedSourceFiles = {...report, configurationDeliveryPath: translatePath(report.configurationPath, rules),
                files: report.files.map(file => ({...file, deliveryPath: translatePath(file.path, rules)}))};
        }
        const deliveryFiles = projectDelivery(stage, Object.keys(hashes));
        return { stage, files: deliveryFiles, identity: { schema: 'tavern-release/v2', commit, candidate, dirty,launcherCapabilities:LAUNCHER_CAPABILITIES,
            updaterCapabilities: UPDATER_CAPABILITIES,
            sourceDigest: digest(JSON.stringify(hashes)), node: process.version, sourceFiles: hashes,
            ...(generatedSourceFiles ? {generatedSourceFiles} : {}) } };
    } catch (error) {
        fs.rmSync(stage, { recursive: true, force: true });
        throw error;
    }
}

// The desktop lock remains the only authored dependency authority. Generate a
// small production-only package in the disposable export, never install Electron
// or execute dependency scripts, and seal every delivered byte in the manifest.
function actorDependencyLock(stage) {
    const bytes = fs.readFileSync(path.join(stage, 'ops/installer/desktop/package-lock.json'));
    const source = JSON.parse(bytes);
    if (source.lockfileVersion !== 3 || JSON.stringify(source.packages?.['']?.dependencies) !== JSON.stringify(ACTOR_DEPENDENCIES))
        throw new Error('Independent updater dependencies differ from the canonical desktop lock');
    const packageJson = { name: 'nora-updater-actor-dependencies', version: '1.0.0', private: true,
        dependencies: ACTOR_DEPENDENCIES, engines: { node: '>=20' } };
    const packages = { '': { name: packageJson.name, version: packageJson.version,
        dependencies: ACTOR_DEPENDENCIES, engines: packageJson.engines } };
    const visit = name => {
        const key = `node_modules/${name}`;
        if (packages[key]) return;
        const value = source.packages[key];
        if (!value || value.dev || value.link || !value.resolved?.startsWith('https://registry.npmjs.org/') || !value.integrity)
            throw new Error(`Missing locked updater dependency: ${name}`);
        packages[key] = value;
        for (const child of Object.keys(value.dependencies || {})) visit(child);
    };
    for (const name of Object.keys(ACTOR_DEPENDENCIES)) visit(name);
    const lock = { name: packageJson.name, version: packageJson.version, lockfileVersion: 3, requires: true,
        packages: Object.fromEntries(Object.entries(packages).sort(([left], [right]) => left.localeCompare(right))) };
    return { packageJson, lock, canonicalLockSha256: digest(bytes) };
}

function dependencyInventory(directory) {
    const files = {};
    const visit = relative => {
        for (const item of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
            const name = relative ? `${relative}/${item.name}` : item.name;
            if (!relative && item.name === 'receipt.json') continue;
            if (item.isDirectory()) visit(name);
            else if (item.isFile()) files[name] = digest(fs.readFileSync(path.join(directory, name)));
            else throw new Error(`Non-regular updater dependency: ${name}`);
        }
    };
    visit('');
    return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
}

function verifyActorDirectory(directory, expected) {
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'receipt.json'), 'utf8'));
    if (receipt.schema !== 'nora-updater-dependencies/1' || receipt.canonicalLockSha256 !== expected.canonicalLockSha256
        || JSON.stringify(receipt.dependencies) !== JSON.stringify(ACTOR_DEPENDENCIES)
        || JSON.stringify(JSON.parse(fs.readFileSync(path.join(directory, 'package.json')))) !== JSON.stringify(expected.packageJson)
        || JSON.stringify(JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json')))) !== JSON.stringify(expected.lock)
        || JSON.stringify(receipt.files) !== JSON.stringify(dependencyInventory(directory)))
        throw new Error('Updater dependency closure differs from its sealed lock or receipt');
    const names = fs.readdirSync(path.join(directory, 'node_modules')).sort();
    const locked = Object.keys(expected.lock.packages).filter(Boolean).map(name => name.slice('node_modules/'.length)).sort();
    if (JSON.stringify(names) !== JSON.stringify(locked)) throw new Error('Unexpected updater dependency package');
    for (const name of names) {
        const installed = JSON.parse(fs.readFileSync(path.join(directory, 'node_modules', name, 'package.json')));
        if (installed.version !== expected.lock.packages[`node_modules/${name}`].version)
            throw new Error(`Updater dependency version mismatch: ${name}`);
    }
    return receipt;
}

export function verifyUpdaterDependencies(stage) {
    const directory = path.join(stage, UPDATER_DEPENDENCY_ROOT);
    return verifyActorDirectory(directory, actorDependencyLock(stage));
}

function restoreUpdaterDependencies(stage, baseline, expected) {
    const names = Object.keys(baseline?.identity?.artifacts || {}).filter(name => name.startsWith(`${UPDATER_DEPENDENCY_ROOT}/`));
    if (!names.includes(`${UPDATER_DEPENDENCY_ROOT}/receipt.json`)) return false;
    const descriptor = baseline.identity.archives?.ops;
    if (!descriptor) return false;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(descriptor.name || '')) throw new Error('Unsafe baseline updater archive name');
    const archive = path.join(baseline.directory, descriptor.name);
    if (digest(fs.readFileSync(archive)) !== descriptor.sha256) throw new Error('Baseline updater archive checksum mismatch');
    const runTar = args => {
        const command = buildCommand('tar', args);
        return execFileSync(command.command, command.args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    };
    if (!runTar(['-tvzf', archive]).trim().split(/\r?\n/).every(line => line.startsWith('-')))
        throw new Error('Baseline updater archive links are forbidden');
    for (const name of names) assertSafeReleasePath(name, { updaterDependencies: true });
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-updater-dependencies-'));
    try {
        const list = path.join(scratch, 'members.txt');
        fs.writeFileSync(list, names.sort().join('\n') + '\n');
        runTar(['-xzf', archive, '-C', scratch, '-T', list]);
        for (const name of names) {
            const file = path.join(scratch, name);
            if (!fs.lstatSync(file).isFile() || digest(fs.readFileSync(file)) !== baseline.identity.artifacts[name])
                throw new Error(`Baseline updater dependency mismatch: ${name}`);
        }
        const directory = path.join(scratch, UPDATER_DEPENDENCY_ROOT);
        const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'receipt.json')));
        if (receipt.canonicalLockSha256 !== expected.canonicalLockSha256) return false;
        verifyActorDirectory(directory, expected);
        fs.cpSync(directory, path.join(stage, UPDATER_DEPENDENCY_ROOT), { recursive: true });
        return true;
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

export function materializeUpdaterDependencies(stage, { baseline, install } = {}) {
    const expected = actorDependencyLock(stage), directory = path.join(stage, UPDATER_DEPENDENCY_ROOT);
    if (fs.existsSync(directory)) return verifyActorDirectory(directory, expected);
    if (restoreUpdaterDependencies(stage, baseline, expected)) return verifyActorDirectory(directory, expected);
    fs.mkdirSync(directory, { recursive: true });
    try {
        fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(expected.packageJson, null, 2) + '\n');
        fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify(expected.lock, null, 2) + '\n');
        if (!install) throw new Error('Updater dependencies require a verified production install');
        install(directory);
        fs.rmSync(path.join(directory, 'node_modules/.package-lock.json'), { force: true });
        const receipt = { schema: 'nora-updater-dependencies/1', canonicalLockSha256: expected.canonicalLockSha256,
            dependencies: ACTOR_DEPENDENCIES, files: dependencyInventory(directory) };
        fs.writeFileSync(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
        return verifyActorDirectory(directory, expected);
    } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}

export function collectRuntimeFiles(stage, sourceFiles) {
    // Build/QA still use the complete source export. Only this delivery list is
    // narrowed; retired CLIs and development tools must not ship as operations.
    const operationFiles = new Set([
        'ops/scripts/runtime.sh',
        'ops/scripts/bringup-native.sh',
        'ops/scripts/provision.sh',
        'ops/scripts/profile_memory.py',
        'ops/scripts/analyze-boot-metrics.mjs',
        'ops/scripts/analyze-runtime-phases.mjs',
        'ops/scripts/install-hermes-skills.py',
        'ops/scripts/nora-tavern-update-check.sh',
        'ops/scripts/nora-tavern-update-check.py',
        'ops/scripts/nora-instance.py',
        'ops/scripts/nora-tavern-card-send.py',
        'ops/skills/INSTALL.md',
        'ops/skills/agents-tavern.md',
    ]);
    const skillRoots = ['ops/skills/creative/tavern/', 'ops/skills/creative/tavern-ops/', 'ops/skills/system/tavern-updater/', 'ops/skills/creative/nora-cardforge/', 'ops/skills/system/model-provider-config/', 'ops/skills/creative/nora-skill-library/'];
    // Upstream sample content and text fonts remain in the source reference,
    // not the installed product. Nora uses system fonts. Font Awesome is an
    // icon dependency (including extension controls), not a text-font choice.
    const engineRoot = 'app/engine/sillytavern/';
    const omittedRoots = [
        `${engineRoot}default/content/backgrounds/`,
        `${engineRoot}default/content/Seraphina/`,
        `${engineRoot}public/webfonts/NotoSans/`,
        `${engineRoot}public/webfonts/NotoSansMono/`,
        `${engineRoot}src/tokenizers/`,
    ];
    const omittedFiles = new Set([
        'ops/installer/launcher-ui-prototype.html',
        'ops/installer/launcher-refinement-preview.html',
        'ops/installer/launcher-directory-preview.html',
        'ops/installer/launcher-directory-preview.js',
        `${engineRoot}default/content/default_Seraphina.png`,
        `${engineRoot}default/content/Eldoria.json`,
        `${engineRoot}public/lib/pdf.min.mjs`,
        `${engineRoot}public/lib/pdf.worker.min.mjs`,
        `${engineRoot}public/lib/epub.min.js`,
        `${engineRoot}public/lib/jszip.min.js`,
    ]);
    const shippedLocales = new Set(['lang.json', 'en.json', 'zh-cn.json', 'zh-tw.json']);
    const localeRoot = `${engineRoot}public/locales/`;
    const isUnshippedLocale = file => file.startsWith(localeRoot) && !shippedLocales.has(file.slice(localeRoot.length));
    const selected = new Set(sourceFiles.filter(file => (
        file.startsWith('app/') || operationFiles.has(file)
        || file.startsWith('ops/installer/')
        || file.startsWith('ops/updater/')
        || file.startsWith('ops/hooks/tavern-liveware-register/') || file === 'ops/eslint-owned.cjs'
        || ['nora-mcp/package.json', 'nora-mcp/npm-shrinkwrap.json', 'nora-mcp/README.md'].includes(file)
        || skillRoots.some(root => file.startsWith(root) && (
            file === `${root}SKILL.md` || file.startsWith(`${root}references/`)
            || (root.includes('nora-cardforge/') && !['tests/', 'agents/'].some(exclude => file.startsWith(root + exclude)))
            || file === 'ops/skills/system/tavern-updater/scripts/update.py'
            || MODEL_SKILL_SCRIPTS.includes(file)
            || (root.includes('nora-skill-library/') && file.startsWith(`${root}scripts/`))
        ))
    )
        && !omittedRoots.some(root => file.startsWith(root)) && !omittedFiles.has(file) && !isUnshippedLocale(file)
        && !file.startsWith('app/engine/sillytavern/tests/')
        && !file.startsWith('app/tests/')
        && !file.startsWith('app/engine/sillytavern/public/dist/nora/')
        && !file.startsWith('app/engine/sillytavern/dist/')));
    function visit(relative) {
        for (const entry of fs.readdirSync(path.join(stage, relative), { withFileTypes: true })) {
            const child = `${relative}/${entry.name}`;
            if (entry.isDirectory()) visit(child);
            else if (entry.isFile()) selected.add(child);
            else throw new Error(`Non-regular build artifact: ${child}`);
        }
    }
    visit('app/engine/sillytavern/public/dist/nora');
    visit('app/engine/sillytavern/dist/_webpack/output');
    visit('nora-mcp/dist');
    const dependencyRoot = path.join(stage, UPDATER_DEPENDENCY_ROOT);
    if (fs.existsSync(dependencyRoot)) {
        const receipt = verifyUpdaterDependencies(stage);
        for (const file of [...Object.keys(receipt.files), 'receipt.json']) selected.add(`${UPDATER_DEPENDENCY_ROOT}/${file}`);
    }
    // Never ship an index that asks first startup to copy absent resources.
    const contentRoot = `${engineRoot}default/content/`;
    if (selected.has(`${contentRoot}index.json`)) {
        const index = JSON.parse(fs.readFileSync(path.join(stage, contentRoot, 'index.json'), 'utf8'));
        for (const item of index) {
            const target = contentRoot + item.filename;
            if (!selected.has(target) && ![...selected].some(file => file.startsWith(`${target}/`))) {
                throw new Error(`Default content index references an omitted release asset: ${item.filename}`);
            }
        }
    }
    for (const relative of selected) {
        assertSafeReleasePath(relative, { updaterDependencies: relative.startsWith(`${UPDATER_DEPENDENCY_ROOT}/`) });
        assertSafeReleaseContent(relative, fs.readFileSync(path.join(stage, relative)));
    }
    return [...selected].sort();
}

const NORA_ENGINE_PREFIXES = [
    'app/engine/sillytavern/public/dist/nora/',
    'app/engine/sillytavern/public/scripts/nora-',
    'app/engine/sillytavern/src/nora-',
    'app/engine/sillytavern/src/endpoints/nora-',
];

const NORA_ENGINE_FILES = new Set([
    'app/engine/sillytavern/public/actor.html',
    'app/engine/sillytavern/public/index.html',
    'app/engine/sillytavern/public/manifest.json',
    'app/engine/sillytavern/public/nora-entry.js',
    'app/engine/sillytavern/public/story-profile-icon-v2.png',
    'app/engine/sillytavern/public/tavern-icon-dbf4ecbd54ec.png',
]);

// Incremental bootstrap extracts only the updater module into its cold runner.
// Keep both Python imports and delegated Node resources in that same archive.
const UPDATER_RUNTIME_FILES = new Set([
    'ops/installer/update_recovery.py', 'ops/installer/error_diagnostics.py',
    'ops/installer/operation_control.py', 'ops/installer/operation_cli.py',
    'ops/installer/operation_evidence.py', 'ops/installer/operation-budget.json',
    'ops/installer/operation_node.mjs', 'ops/installer/mcp_probe.mjs',
    'ops/installer/desktop/operation-delegate.js', 'ops/installer/desktop/operation-history.js',
]);

/**
 * Assign every installed artifact to exactly one independently downloadable
 * module.  The target manifest is the authority; installers never need to
 * understand these path rules.
 */
export function releaseModuleFor(relative) {
    if (relative.startsWith('ops/installer/') && (
        /^ops\/installer\/[^/]+\.(?:py|mjs|json)$/.test(relative)
        || relative.startsWith('ops/installer/templates/')
        || /^ops\/installer\/desktop\/[^/]+\.(?:js|json)$/.test(relative)
            && !['main.js', 'preload.js', 'native-crash.js', 'package.json', 'package-lock.json'].includes(path.posix.basename(relative))
    )) return 'updater';
    if (UPDATER_RUNTIME_FILES.has(relative)) return 'updater';
    if (relative.startsWith('ops/updater/')) return 'updater';
    if (relative.startsWith('ops/skills/')) return 'skills';
    if (relative.startsWith('ops/')) return 'operations';
    if (relative.startsWith('nora-mcp/')) return 'nora-mcp';
    if (relative.startsWith('app/story_profile_runtime/')) return 'story-profile';
    if (relative.startsWith('app/native-extensions/')) {
        const extension = relative.split('/')[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (!extension) throw new Error(`Cannot classify extension artifact: ${relative}`);
        return `extension-${extension}`;
    }
    if (!relative.startsWith('app/engine/sillytavern/')) return 'nora-runtime';
    if (NORA_ENGINE_FILES.has(relative) || NORA_ENGINE_PREFIXES.some(prefix => relative.startsWith(prefix))) {
        return relative.includes('/public/') ? 'nora-web' : 'nora-runtime';
    }
    return 'tavern-engine';
}

export function groupRuntimeModules(files) {
    const modules = new Map();
    for (const relative of files) {
        const name = releaseModuleFor(relative);
        if (!modules.has(name)) modules.set(name, []);
        modules.get(name).push(relative);
    }
    return new Map([...modules].sort(([left], [right]) => left.localeCompare(right))
        .map(([name, members]) => [name, members.sort()]));
}
