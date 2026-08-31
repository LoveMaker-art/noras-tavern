import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import _ from 'lodash';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { DEFAULT_USER, PUBLIC_DIRECTORIES } from './constants.js';
import { getContentOfType } from './endpoints/content-manager.js';
import { serverDirectory } from './server-directory.js';
import { color, delay, setPermissionsSync } from './util.js';
import { getUserDirectories, getUserDirectoriesList } from './workspace.js';

/**
 * Migrates the pre-data-root SillyTavern layout into the Nora workspace.
 */
export async function migrateUserData() {
    const publicDirectory = path.join(process.cwd(), 'public');
    if (!fs.existsSync(path.join(publicDirectory, 'characters'))) return;

    const timeout = 10;
    console.log();
    console.log(color.magenta('Preparing to migrate user data...'));
    console.log(`All public data will be moved to the ${globalThis.DATA_ROOT} directory.`);
    console.log(`Backups will be placed in the ${PUBLIC_DIRECTORIES.backups} directory.`);
    console.log(`The process will start in ${timeout} seconds. Press Ctrl+C to cancel.`);
    for (let remaining = timeout; remaining > 0; remaining--) {
        console.log(`${remaining}...`);
        await delay(1000);
    }

    const directories = getUserDirectories(DEFAULT_USER.handle);
    const migrations = [
        ['assets', directories.assets, false],
        ['backgrounds', directories.backgrounds, false],
        ['characters', directories.characters, false],
        ['chats', directories.chats, false],
        ['context', directories.context, false],
        ['instruct', directories.instruct, false],
        ['KoboldAI Settings', directories.koboldAI_Settings, false],
        ['movingUI', directories.movingUI, false],
        ['NovelAI Settings', directories.novelAI_Settings, false],
        ['OpenAI Settings', directories.openAI_Settings, false],
        ['TextGen Settings', directories.textGen_Settings, false],
        ['themes', directories.themes, false],
        ['user', directories.user, false],
        ['User Avatars', directories.avatars, false],
        ['worlds', directories.worlds, false],
        ['scripts/extensions/third-party', directories.extensions, false],
    ].map(([relative, destination, file]) => ({
        old: path.join(publicDirectory, relative),
        new: destination,
        file,
    }));
    migrations.push(
        { old: path.join(process.cwd(), 'thumbnails'), new: directories.thumbnails, file: false },
        { old: path.join(process.cwd(), 'secrets.json'), new: path.join(directories.root, 'secrets.json'), file: true },
        { old: path.join(publicDirectory, 'settings.json'), new: path.join(directories.root, 'settings.json'), file: true },
    );

    const currentDate = new Date().toISOString().split('T')[0];
    const backupDirectory = path.join(process.cwd(), PUBLIC_DIRECTORIES.backups, '_migration', currentDate);
    fs.mkdirSync(backupDirectory, { recursive: true });
    const errors = [];

    for (const migration of migrations) {
        console.log(`Migrating ${migration.old} to ${migration.new}...`);
        try {
            if (!fs.existsSync(migration.old)) {
                console.log(color.yellow(`Skipping migration of ${migration.old} as it does not exist.`));
                continue;
            }
            fs.cpSync(migration.old, migration.new, { recursive: !migration.file, force: true });
            fs.cpSync(migration.old, path.join(backupDirectory, path.basename(migration.old)), { recursive: true, force: true });
            fs.rmSync(migration.old, { recursive: true, force: true });
        } catch (error) {
            console.error(color.red(`Error migrating ${migration.old} to ${migration.new}:`), error.message);
            errors.push(migration.old);
        }
    }

    if (errors.length > 0) {
        console.log(color.red('Migration completed with errors. Move the following files manually:'));
        errors.forEach(error => console.error(error));
    }
    console.log(color.green('Migration completed!'));
}

export async function migrateSystemPrompts() {
    async function getDefaultSystemPrompts() {
        try {
            return getContentOfType('sysprompt', 'json');
        } catch {
            return [];
        }
    }

    for (const directory of await getUserDirectoriesList()) {
        try {
            const migrateMarker = path.join(directory.sysprompt, '.migrated');
            if (fs.existsSync(migrateMarker)) continue;

            const backupsPath = path.join(directory.backups, '_sysprompt');
            fs.mkdirSync(backupsPath, { recursive: true });
            const defaultPrompts = await getDefaultSystemPrompts();
            let migratedPrompts = [];
            for (const instruct of fs.readdirSync(directory.instruct)) {
                const instructPath = path.join(directory.instruct, instruct);
                const systemPromptPath = path.join(directory.sysprompt, instruct);
                if (path.extname(instruct) !== '.json' || fs.existsSync(systemPromptPath)) continue;

                const instructData = JSON.parse(fs.readFileSync(instructPath, 'utf8'));
                if (!('system_prompt' in instructData) || !('name' in instructData)) continue;

                fs.cpSync(instructPath, path.join(backupsPath, `${instructData.name}.json`), { force: true });
                migratedPrompts.push({ name: instructData.name, content: instructData.system_prompt });
                delete instructData.system_prompt;
                writeFileAtomicSync(instructPath, JSON.stringify(instructData, null, 4));
            }

            migratedPrompts = _.uniqBy(migratedPrompts, 'content')
                .filter(prompt => !defaultPrompts.some(item => item.content === prompt.content));
            for (const prompt of migratedPrompts) {
                prompt.name = `[Migrated] ${prompt.name}`;
                writeFileAtomicSync(path.join(directory.sysprompt, `${prompt.name}.json`), JSON.stringify(prompt, null, 4));
            }
            writeFileAtomicSync(migrateMarker, '');
        } catch (error) {
            console.error('Error migrating system prompts:', error);
        }
    }
}

export async function migratePublicOverrides() {
    const migrations = [
        ['error/forbidden-by-whitelist.html', '_errors/forbidden-by-whitelist.html'],
        ['error/host-not-allowed.html', '_errors/host-not-allowed.html'],
        ['error/unauthorized.html', '_errors/unauthorized.html'],
        ['error/url-not-found.html', '_errors/url-not-found.html'],
        ['css/user.css', '_css/user.css'],
    ];

    for (const [source, destination] of migrations) {
        const oldPath = path.join(serverDirectory, 'public', source);
        const newPath = path.join(globalThis.DATA_ROOT, destination);
        try {
            if (fs.existsSync(newPath) || !fs.existsSync(oldPath)) continue;
            fs.mkdirSync(path.dirname(newPath), { recursive: true });
            fs.cpSync(oldPath, newPath, { force: true });
            fs.unlinkSync(oldPath);
            setPermissionsSync(newPath);
            console.log(`Migrated ${path.basename(oldPath)} to data root.`);
        } catch (error) {
            console.error(`Error migrating ${oldPath} to ${newPath}:`, error);
        }
    }
}
