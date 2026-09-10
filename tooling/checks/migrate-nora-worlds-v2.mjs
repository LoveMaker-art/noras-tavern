#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { migrateLegacyWorlds } from '../../app/engine/sillytavern/src/nora-world-core/legacy-migration.js';

function argumentValue(arguments_, name) {
    const index = arguments_.indexOf(name);
    return index >= 0 ? arguments_[index + 1] : '';
}

function usage() {
    return [
        'Usage:',
        '  node ops/scripts/migrate-nora-worlds-v2.mjs --user-root <absolute path> [--report <absolute path>]',
        '  node ops/scripts/migrate-nora-worlds-v2.mjs --user-root <absolute path> --apply --backup-root <absolute path> [--report <absolute path>]',
        '',
        'Analyze is the default. Apply is additive, requires a backup, and never deletes legacy data.',
    ].join('\n');
}

async function copyIfPresent(source, destination) {
    try {
        await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

async function createBackup(userRoot, backupRoot) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(backupRoot, `nora-world-v2-migration-${stamp}`);
    await fs.mkdir(destination, { recursive: false });
    const copied = [];
    for (const name of ['nora-worlds', 'nora-world-core', 'chats', 'characters', 'worlds']) {
        if (await copyIfPresent(path.join(userRoot, name), path.join(destination, name))) copied.push(name);
    }
    await fs.writeFile(
        path.join(destination, 'backup.json'),
        `${JSON.stringify({ schema: 'nora-world-migration-backup/v1', created_at: new Date().toISOString(), user_root: userRoot, copied }, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    return { destination, copied };
}

async function main() {
    const arguments_ = process.argv.slice(2);
    if (arguments_.includes('--help')) {
        process.stdout.write(`${usage()}\n`);
        return;
    }
    const apply = arguments_.includes('--apply');
    const userRoot = path.resolve(argumentValue(arguments_, '--user-root'));
    if (!argumentValue(arguments_, '--user-root') || !path.isAbsolute(userRoot)) throw new Error(`--user-root is required.\n${usage()}`);
    const backupRootArgument = argumentValue(arguments_, '--backup-root');
    if (apply && !backupRootArgument) throw new Error(`--apply requires --backup-root.\n${usage()}`);
    const backupRoot = backupRootArgument ? path.resolve(backupRootArgument) : '';
    const worldCoreRoot = path.join(userRoot, 'nora-world-core');
    const reportArgument = argumentValue(arguments_, '--report');
    const reportPath = reportArgument
        ? path.resolve(reportArgument)
        : path.join(worldCoreRoot, 'migrations', 'legacy-v1-to-v2.json');
    const directories = {
        root: userRoot,
        noraWorlds: path.join(userRoot, 'nora-worlds'),
        characters: path.join(userRoot, 'characters'),
        chats: path.join(userRoot, 'chats'),
        worlds: path.join(userRoot, 'worlds'),
    };
    const backup = apply ? await createBackup(userRoot, backupRoot) : null;
    const report = await migrateLegacyWorlds({ directories, worldCoreRoot, apply, reportPath });
    process.stdout.write(`${JSON.stringify({ ok: true, apply, backup, report_path: reportPath, report }, null, 2)}\n`);
}

main().catch(error => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2)}\n`);
    process.exitCode = 1;
});
