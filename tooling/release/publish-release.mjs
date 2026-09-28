import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [rootArg, tag, commit, mode = 'full'] = process.argv.slice(2);
const root = path.resolve(rootArg);
const repository = process.env.GH_REPO;
assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
run(process.execPath, ['tooling/release/verify-launcher-release.cjs', root, tag, commit, mode]);
const notes = path.join(root, 'release-notes.generated.md');
run(process.execPath, ['tooling/release/launcher-release-notes.cjs', root, tag, repository, `docs/releases/${tag}.md`, notes]);
const beta = tag.includes('-beta.');
// A failed upload leaves a draft, never a partially published latest release.
run('gh', ['release', 'create', tag, '--verify-tag', '--draft', ...(beta ? ['--prerelease'] : []),
    '--title', `诺拉·酒馆 ${tag}${beta ? ' 测试版' : ''}`, '--notes-file', notes]);
for (const relative of fs.readdirSync(root, { recursive: true })) {
    const file = path.join(root, relative), name = path.basename(file);
    if (!fs.statSync(file).isFile() || file === notes || name.endsWith('.blockmap') || /^latest.*\.yml$/.test(name)) continue;
    run('gh', ['release', 'upload', tag, file]);
}
run('gh', ['release', 'edit', tag, '--draft=false', `--prerelease=${beta}`, `--latest=${!beta}`]);
