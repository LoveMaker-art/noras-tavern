import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = path.resolve(engineRoot, '..', '..');
const repositoryRoot = path.resolve(appRoot, '..');
const sourceRoot = path.resolve(process.env.NORA_STORY_PROFILE_SOURCE || path.join(repositoryRoot, 'story-profile'));
const runtimeRoot = path.join(appRoot, 'story_profile_runtime');
const manifestPath = path.join(runtimeRoot, 'manifest.json');

const sourceFiles = [
    ['core/story_profile.py', 'story_profile_runtime/core/story_profile.py'],
    ['core/reflection.py', 'story_profile_runtime/core/reflection.py'],
    ['adapters/nora/cli.py', 'story_profile_runtime/adapters/nora/cli.py'],
    ['adapters/nora/model-config.js', 'story_profile_runtime/adapters/nora/model-config.js'],
    ['adapters/nora/preference-checkpoint.js', 'story_profile_runtime/adapters/nora/preference-checkpoint.js'],
    ['public/actor.html', 'engine/sillytavern/public/actor.html'],
    ['public/story-profile-book.svg', 'engine/sillytavern/public/story-profile-book.svg'],
    ['public/story-profile-icon-v2.png', 'engine/sillytavern/public/story-profile-icon-v2.png'],
    ['public/actor.js', 'engine/sillytavern/public/actor.js'],
    ['public/console.css', 'engine/sillytavern/public/console.css'],
    ['public/i18n.js', 'engine/sillytavern/public/i18n.js'],
    ['public/security.js', 'engine/sillytavern/public/security.js'],
];

const generatedFiles = [
    ['story_profile_runtime/package.json', `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`],
];

function digest(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function outputPath(relativePath) {
    const normalized = String(relativePath || '').replaceAll('\\', '/');
    if (!normalized || path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
        throw new Error(`Unsafe Story Profile runtime output: ${relativePath}`);
    }
    const resolved = path.resolve(appRoot, normalized);
    if (resolved !== appRoot && !resolved.startsWith(`${appRoot}${path.sep}`)) {
        throw new Error(`Story Profile runtime output escapes app root: ${relativePath}`);
    }
    return resolved;
}

function sourcePath(relativePath) {
    const normalized = String(relativePath || '').replaceAll('\\', '/');
    if (!normalized || path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
        throw new Error(`Unsafe Story Profile source: ${relativePath}`);
    }
    const resolved = path.resolve(sourceRoot, normalized);
    if (resolved !== sourceRoot && !resolved.startsWith(`${sourceRoot}${path.sep}`)) {
        throw new Error(`Story Profile source escapes project root: ${relativePath}`);
    }
    return resolved;
}

function atomicWrite(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath) && fs.readFileSync(filePath).equals(content)) return false;
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(temporary, content);
        fs.renameSync(temporary, filePath);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return true;
}

function readPreviousManifest() {
    try {
        const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return value?.schema === 'nora-story-profile-runtime/v1' ? value : null;
    } catch {
        return null;
    }
}

function expectedSnapshot() {
    const files = {};
    const contents = new Map();
    for (const [sourceRelative, outputRelative] of sourceFiles) {
        const original = fs.readFileSync(sourcePath(sourceRelative));
        let content = original;
        // Keep upstream UI/behaviour; adapt only transport to the Tavern host.
        if (sourceRelative === 'public/actor.js') {
            content = Buffer.from(original.toString().replaceAll('await fetch(', 'await globalThis.noraProfileRequest('));
        } else if (sourceRelative === 'public/actor.html') {
            let html = original.toString().replace('<script src="actor.js"></script>', '<script src="nora-profile-request.js"></script>\n  <script src="actor.js"></script>');
            // Liveware may cache static extensions independently of the origin
            // headers. Change the URL only when the resource content changes.
            for (const asset of ['console.css', 'i18n.js']) {
                const version = digest(fs.readFileSync(sourcePath(`public/${asset}`))).slice(0, 16);
                html = html.replace(`"${asset}"`, `"${asset}?v=${version}"`);
            }
            content = Buffer.from(html);
        }
        files[outputRelative] = {
            source: path.posix.join('story-profile', sourceRelative),
            sourceSha256: digest(original),
            sha256: digest(content),
        };
        contents.set(outputRelative, content);
    }
    for (const [outputRelative, value] of generatedFiles) {
        const content = Buffer.from(value, 'utf8');
        files[outputRelative] = { source: null, sha256: digest(content) };
        contents.set(outputRelative, content);
    }
    const manifest = {
        schema: 'nora-story-profile-runtime/v1',
        source: 'repository-project',
        // Content identity is stable across commits and works in Git archives.
        // Git HEAD here would make every commit invalidate its own snapshot.
        sourceRevision: `sha256:${digest(JSON.stringify(sourceFiles.map(([source, output]) => [source, files[output].sourceSha256])))}`,
        files,
    };
    return {
        contents,
        manifest,
        manifestContent: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    };
}

function checkEmbedded() {
    const manifest = readPreviousManifest();
    if (!manifest) throw new Error('Missing Story Profile snapshot manifest. Run sync:story-profile explicitly.');
    const expected = [...sourceFiles.map(([, output]) => output), ...generatedFiles.map(([output]) => output)].sort();
    if (JSON.stringify(Object.keys(manifest.files || {}).sort()) !== JSON.stringify(expected)) {
        throw new Error('Story Profile snapshot file list is incomplete or unexpected.');
    }
    for (const relative of expected) {
        if (digest(fs.readFileSync(outputPath(relative))) !== manifest.files[relative].sha256) {
            throw new Error(`Story Profile snapshot checksum mismatch: ${relative}`);
        }
    }
    console.log(`story-profile-runtime=PASS files=${expected.length} source=embedded`);
}

function check(snapshot) {
    const problems = [];
    for (const [relativePath, expected] of snapshot.contents) {
        const target = outputPath(relativePath);
        if (!fs.existsSync(target)) problems.push(`missing ${relativePath}`);
        else if (!fs.readFileSync(target).equals(expected)) problems.push(`stale ${relativePath}`);
    }
    if (!fs.existsSync(manifestPath)) problems.push('missing story_profile_runtime/manifest.json');
    else if (!fs.readFileSync(manifestPath).equals(snapshot.manifestContent)) {
        problems.push('stale story_profile_runtime/manifest.json');
    }
    if (problems.length) {
        throw new Error(`Story Profile runtime snapshot is not synchronized:\n- ${problems.join('\n- ')}`);
    }
}

function sync(snapshot) {
    const previous = readPreviousManifest();
    const expected = new Set(snapshot.contents.keys());
    for (const relativePath of Object.keys(previous?.files || {})) {
        if (expected.has(relativePath)) continue;
        const stale = outputPath(relativePath);
        if (fs.statSync(stale, { throwIfNoEntry: false })?.isFile()) fs.unlinkSync(stale);
    }
    let changed = 0;
    for (const [relativePath, content] of snapshot.contents) {
        if (atomicWrite(outputPath(relativePath), content)) changed += 1;
    }
    if (atomicWrite(manifestPath, snapshot.manifestContent)) changed += 1;
    return changed;
}

const checkOnly = process.argv.includes('--check');
if (checkOnly) {
    checkEmbedded();
} else if (process.argv.includes('--check-source')) {
    check(expectedSnapshot());
    console.log('story-profile-source=PASS');
} else {
    const snapshot = expectedSnapshot();
    const changed = sync(snapshot);
    check(snapshot);
    console.log(`story-profile-runtime=SYNCED files=${snapshot.contents.size} changed=${changed}`);
}
