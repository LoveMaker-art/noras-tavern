import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(target);
        return /\.(?:js|mjs|html|css|json)$/.test(entry.name) ? [target] : [];
    });
}

for (const removedPath of [
    'public/scripts/group-chats.js',
    'public/css/character-group-overlay.css',
    'src/endpoints/groups.js',
]) {
    assert.equal(fs.existsSync(path.join(root, removedPath)), false, `${removedPath} must be removed`);
}

const files = [
    ...sourceFiles(path.join(root, 'public')),
    ...sourceFiles(path.join(root, 'src')),
    ...sourceFiles(path.join(root, 'default/content')),
    path.resolve(root, '../../native-extensions/nora-ui/index.js'),
].filter((file) => !file.endsWith('nora-no-groups-contract.mjs'));

assert.equal(
    fs.readFileSync(path.join(root, 'public/style.css'), 'utf8').includes('character-group-overlay.css'),
    false,
    'public/style.css must not load the removed Group overlay stylesheet',
);

const forbidden = [
    'group-chats.js',
    'groupsRouter',
    'migrateGroupChatsMetadataFormat',
    'createWorldGroup',
    'openWorldGroup',
    'deleteWorldGroup',
    'generateWorldGroupOnce',
    '/api/groups',
    'GROUP_CHAT_',
    'new_group_chat_prompt',
    'group_nudge_prompt',
    'groupNudge',
    'rm_group_chats_block',
    'newgroupchat_prompt',
];

for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const signal of forbidden) {
        assert.equal(source.includes(signal), false, `${path.relative(root, file)} must not reference ${signal}`);
    }
}

console.log(`nora-no-groups-contract=PASS files=${files.length}`);
