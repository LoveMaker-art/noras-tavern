#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { dirname, extname, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), '../..');
const outputPath = resolve(repositoryRoot, 'docs/architecture/project-index.json');
const outputRelativePath = posix.normalize(relative(repositoryRoot, outputPath));

const runGit = (args) => execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
});

const splitNull = (value) => value.split('\0').filter(Boolean).map((path) => posix.normalize(path));

const excludedPrefixes = [
    '.codebase-memory/',
    '.git/',
    'app/engine/sillytavern/data/',
    'app/engine/sillytavern/node_modules/',
    'app/engine/sillytavern/public/scripts/extensions/third-party/',
    'app/engine/sillytavern/src/electron/node_modules/',
    'app/native-extensions/JS-Slash-Runner/vendor/',
    'local-state/',
    'release/',
];

const excludedSegments = new Set(['node_modules', '.git', '.codebase-memory']);

function exclusionReason(path) {
    if (path === outputRelativePath) {
        return 'generated index excludes itself';
    }
    const prefix = excludedPrefixes.find((candidate) => path.startsWith(candidate));
    if (prefix) {
        return `excluded runtime, dependency, or duplicate tree: ${prefix}`;
    }
    if (path.split('/').some((segment) => excludedSegments.has(segment))) {
        return 'excluded dependency or repository metadata segment';
    }
    return null;
}

function classifyRole(path) {
    if (path === 'CONTEXT.md' || path.startsWith('docs/adr/') || path.startsWith('docs/architecture/')) return 'architecture-documentation';
    if (path.includes('/tests/') || path.startsWith('tests/')) return 'test';
    if (path.startsWith('story-profile/')) return 'story-profile-source';
    if (path.startsWith('app/story_profile_runtime/')) return 'generated-profile-runtime';
    if (path.startsWith('app/engine/sillytavern/public/dist/nora/') || path === 'app/engine/sillytavern/public/lib-core.js') return 'generated-runtime';
    if (path.startsWith('app/engine/sillytavern/build/') || path.endsWith('webpack.nora.config.mjs') || path.endsWith('webpack.config.js')) return 'build-tool';
    if (path.startsWith('app/engine/sillytavern/src/nora-') || path.startsWith('app/engine/sillytavern/src/endpoints/nora-')) return 'backend-nora';
    if (path.startsWith('app/engine/sillytavern/src/')) return 'backend-compatibility-engine';
    if (path.startsWith('app/engine/sillytavern/public/scripts/nora-') || path === 'app/engine/sillytavern/public/nora-entry.js') return 'frontend-nora-runtime';
    if (path.startsWith('app/engine/sillytavern/public/') && ['.js', '.mjs', '.html'].includes(extname(path))) return 'frontend-compatibility-engine';
    if (path.startsWith('app/native-extensions/nora-ui/')) return 'nora-ui-extension';
    if (path.startsWith('app/native-extensions/nora-mvu/')) return 'nora-mvu-extension';
    if (path.startsWith('app/native-extensions/')) return 'native-compatibility-extension';
    if (path === 'app/native_lifecycle.py' || path === 'app/native_model_config.py') return 'lifecycle';
    if (path.startsWith('ops/')) return 'operations';
    if (['package.json', 'package-lock.json', 'manifest.json'].includes(posix.basename(path)) || /\.(ya?ml|toml|json)$/.test(path)) return 'configuration-or-manifest';
    if (/\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|mp3|mp4)$/i.test(path)) return 'asset';
    if (/\.(md|txt)$/i.test(path)) return 'documentation';
    return 'other-source';
}

function isGenerated(path) {
    return path.startsWith('app/story_profile_runtime/')
        || path.startsWith('app/engine/sillytavern/public/dist/nora/')
        || path === 'app/engine/sillytavern/public/lib-core.js'
        || path === 'app/native-extensions/JS-Slash-Runner/dist/index.js';
}

function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

function increment(counter, key) {
    counter[key] = (counter[key] || 0) + 1;
}

const head = runGit(['rev-parse', 'HEAD']).trim();
const tracked = new Set(splitNull(runGit(['ls-files', '-z'])));
const untracked = new Set(splitNull(runGit(['ls-files', '--others', '--exclude-standard', '-z'])));
const modified = new Set(splitNull(runGit(['diff', '--name-only', '-z'])));
const staged = new Set(splitNull(runGit(['diff', '--cached', '--name-only', '-z'])));
const allPaths = [...new Set([...tracked, ...untracked])].sort((a, b) => a.localeCompare(b));

const files = [];
const exclusions = [];
const counts = {
    byRole: {},
    byStatus: {},
    byExtension: {},
    generated: 0,
    source: 0,
    totalBytes: 0,
};

for (const path of allPaths) {
    const reason = exclusionReason(path);
    if (reason) {
        exclusions.push({ path, reason });
        continue;
    }

    const absolutePath = resolve(repositoryRoot, path);
    let metadata;
    try {
        metadata = await lstat(absolutePath);
    } catch (error) {
        if (error?.code === 'ENOENT' && tracked.has(path)) {
            const role = classifyRole(path);
            files.push({ path, role, status: 'deleted', generated: isGenerated(path), size: null, sha256: null, kind: 'missing' });
            increment(counts.byRole, role);
            increment(counts.byStatus, 'deleted');
            continue;
        }
        throw error;
    }

    let content;
    let kind = 'file';
    if (metadata.isSymbolicLink()) {
        content = Buffer.from(await readlink(absolutePath), 'utf8');
        kind = 'symlink';
    } else if (metadata.isFile()) {
        content = await readFile(absolutePath);
    } else {
        exclusions.push({ path, reason: 'not a regular file or symbolic link' });
        continue;
    }

    const status = untracked.has(path)
        ? 'untracked'
        : staged.has(path) && modified.has(path)
            ? 'staged-and-modified'
            : staged.has(path)
                ? 'staged'
                : modified.has(path)
                    ? 'modified'
                    : 'tracked';
    const role = classifyRole(path);
    const generated = isGenerated(path);
    const extension = extname(path).toLowerCase() || '[none]';

    files.push({
        path,
        role,
        status,
        generated,
        kind,
        size: content.byteLength,
        sha256: sha256(content),
    });
    increment(counts.byRole, role);
    increment(counts.byStatus, status);
    increment(counts.byExtension, extension);
    counts[generated ? 'generated' : 'source'] += 1;
    counts.totalBytes += content.byteLength;
}

for (const counter of [counts.byRole, counts.byStatus, counts.byExtension]) {
    const ordered = Object.fromEntries(Object.entries(counter).sort(([left], [right]) => left.localeCompare(right)));
    for (const key of Object.keys(counter)) delete counter[key];
    Object.assign(counter, ordered);
}

const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repositoryRoot,
    head,
    dirty: files.some((file) => !['tracked'].includes(file.status)),
    policy: {
        purpose: 'Content-addressed supplement to the structural .codebase-memory index.',
        includes: 'Tracked and untracked project files that participate in source, tests, build, operations, architecture, or shipped generated assets.',
        excludes: 'Dependencies, repository metadata, mutable runtime state, release copies, and managed extension copies duplicated from app/native-extensions.',
        generatedFilesAreNotAuthoritativeSource: true,
    },
    counts: {
        files: files.length,
        exclusions: exclusions.length,
        ...counts,
    },
    files,
    exclusions,
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, head, counts: result.counts }, null, 2));
