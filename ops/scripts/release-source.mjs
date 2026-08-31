import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function digest(value) { return createHash('sha256').update(value).digest('hex'); }

export function assertSafeReleasePath(relative) {
    const parts = relative.split('/');
    if (!relative || path.isAbsolute(relative) || parts.some(part => !part || part === '..') || /[\r\n\0\\]/.test(relative)) {
        throw new Error(`Unsafe release path: ${relative}`);
    }
    const defaultTemplate = ['app/engine/sillytavern/default/config.yaml', 'app/engine/sillytavern/default/content/settings.json'].includes(relative);
    if (parts.some(part => ['.git', 'node_modules', 'local-state', 'tavern-state', 'data', 'logs', 'backups', '__pycache__', '_cache'].includes(part))
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
        : ['ls-tree', '-r', '--name-only', '-z', commit]).split('\0').filter(Boolean))].sort();
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-release-source-'));
    const hashes = {};
    try {
        if (!candidate) {
            const archive = execFileSync('git', ['archive', '--format=tar', commit], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
            execFileSync('tar', ['-x', '-C', stage], { input: archive, env: { ...process.env, COPYFILE_DISABLE: '1' } });
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
        return { stage, files: Object.keys(hashes), identity: { schema: 'tavern-release/v2', commit, candidate, dirty,
            sourceDigest: digest(JSON.stringify(hashes)), node: process.version, sourceFiles: hashes } };
    } catch (error) {
        fs.rmSync(stage, { recursive: true, force: true });
        throw error;
    }
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
        'ops/skills/INSTALL.md',
        'ops/skills/agents-tavern.md',
    ]);
    const skillRoots = ['ops/skills/creative/tavern/', 'ops/skills/creative/tavern-ops/', 'ops/skills/system/tavern-updater/', 'ops/skills/creative/nora-cardforge/'];
    const selected = new Set(sourceFiles.filter(file => (
        file.startsWith('app/') || operationFiles.has(file)
        || file.startsWith('ops/updater/')
        || file.startsWith('ops/hooks/tavern-liveware-register/') || file === 'ops/eslint-owned.cjs'
        || ['nora-mcp/package.json', 'nora-mcp/npm-shrinkwrap.json', 'nora-mcp/README.md'].includes(file)
        || skillRoots.some(root => file.startsWith(root) && (
            file === `${root}SKILL.md` || file.startsWith(`${root}references/`)
            || (root.includes('nora-cardforge/') && !['tests/', 'agents/'].some(exclude => file.startsWith(root + exclude)))
            || file === 'ops/skills/system/tavern-updater/scripts/update.py'
        ))
    )
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
    for (const relative of selected) {
        assertSafeReleasePath(relative);
        assertSafeReleaseContent(relative, fs.readFileSync(path.join(stage, relative)));
    }
    return [...selected].sort();
}
