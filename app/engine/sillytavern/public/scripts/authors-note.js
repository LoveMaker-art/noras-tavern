import {
    MAX_INJECTION_DEPTH,
    chat_metadata,
    eventSource,
    event_types,
    extension_prompt_types,
    saveSettingsDebounced,
    this_chid,
} from '../script.js';
import { extension_settings, getContext, saveMetadataDebounced } from './extensions.js';
import { getCharaFilename } from './utils.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from './slash-commands/SlashCommandArgument.js';
export { MODULE_NAME as NOTE_MODULE_NAME };
import { t } from './i18n.js';
import { macros, MacroCategory } from './macros/macro-system.js';
import { MacrosParser } from './macros.js';
import { power_user } from './power-user.js';

const MODULE_NAME = '2_floating_prompt'; // <= Deliberate, for sorting lower than memory

export var shouldWIAddPrompt = false;

export const metadata_keys = {
    prompt: 'note_prompt',
    interval: 'note_interval',
    depth: 'note_depth',
    position: 'note_position',
    role: 'note_role',
};

const chara_note_position = {
    replace: 0,
    before: 1,
    after: 2,
};

const defaultNoteState = Object.freeze({
    depth: 4,
    position: 1,
    interval: 1,
    role: 0,
});

function ensureAuthorsNoteState() {
    const note = extension_settings.note ??= {};
    note.chara = Array.isArray(note.chara) ? note.chara : [];
    note.default = String(note.default ?? '');
    note.defaultPosition ??= defaultNoteState.position;
    note.defaultDepth ??= defaultNoteState.depth;
    note.defaultInterval ??= defaultNoteState.interval;
    note.defaultRole ??= defaultNoteState.role;
    note.allowWIScan = Boolean(note.allowWIScan);

    chat_metadata[metadata_keys.prompt] ??= note.default;
    chat_metadata[metadata_keys.interval] ??= note.defaultInterval;
    chat_metadata[metadata_keys.position] ??= note.defaultPosition;
    chat_metadata[metadata_keys.depth] ??= note.defaultDepth;
    chat_metadata[metadata_keys.role] ??= note.defaultRole;
    return note;
}

export function getAuthorsNoteState() {
    const note = ensureAuthorsNoteState();
    const characterName = getContext().characterId === undefined ? '' : getCharaFilename();
    const character = characterName ? note.chara.find(item => item.name === characterName) : null;
    return {
        chat: {
            prompt: chat_metadata[metadata_keys.prompt],
            interval: chat_metadata[metadata_keys.interval],
            position: chat_metadata[metadata_keys.position],
            depth: chat_metadata[metadata_keys.depth],
            role: chat_metadata[metadata_keys.role],
        },
        defaults: {
            prompt: note.default,
            interval: note.defaultInterval,
            position: note.defaultPosition,
            depth: note.defaultDepth,
            role: note.defaultRole,
        },
        character: character ? { ...character } : null,
        allowWIScan: note.allowWIScan,
    };
}

export function updateAuthorsNoteState({ chat = null, defaults = null, character = undefined, allowWIScan = undefined } = {}) {
    const note = ensureAuthorsNoteState();
    let metadataChanged = false;
    let settingsChanged = false;

    if (chat) {
        const fields = {
            prompt: metadata_keys.prompt,
            interval: metadata_keys.interval,
            position: metadata_keys.position,
            depth: metadata_keys.depth,
            role: metadata_keys.role,
        };
        for (const [field, key] of Object.entries(fields)) {
            if (!Object.hasOwn(chat, field)) continue;
            const value = field === 'prompt' ? String(chat[field] ?? '') : Math.abs(Number(chat[field]));
            if (field !== 'prompt' && !Number.isFinite(value)) continue;
            chat_metadata[key] = value;
            metadataChanged = true;
        }
    }

    if (defaults) {
        const fields = {
            prompt: 'default',
            interval: 'defaultInterval',
            position: 'defaultPosition',
            depth: 'defaultDepth',
            role: 'defaultRole',
        };
        for (const [field, key] of Object.entries(fields)) {
            if (!Object.hasOwn(defaults, field)) continue;
            const value = field === 'prompt' ? String(defaults[field] ?? '') : Math.abs(Number(defaults[field]));
            if (field !== 'prompt' && !Number.isFinite(value)) continue;
            note[key] = value;
            settingsChanged = true;
        }
    }

    if (allowWIScan !== undefined) {
        note.allowWIScan = Boolean(allowWIScan);
        settingsChanged = true;
    }

    if (character !== undefined) {
        const name = String(character?.name || getCharaFilename() || '');
        const index = note.chara.findIndex(item => item.name === name);
        if (character === null) {
            if (index >= 0) note.chara.splice(index, 1);
            settingsChanged = index >= 0;
        } else if (name) {
            const current = index >= 0 ? note.chara[index] : { name, prompt: '', useChara: false, position: chara_note_position.replace };
            const next = { ...current };
            if (Object.hasOwn(character, 'prompt')) next.prompt = String(character.prompt ?? '');
            if (Object.hasOwn(character, 'useChara')) next.useChara = Boolean(character.useChara);
            if (Object.hasOwn(character, 'position')) next.position = Number(character.position);
            if (!next.prompt && !next.useChara) {
                if (index >= 0) note.chara.splice(index, 1);
            } else if (index >= 0) {
                note.chara[index] = next;
            } else {
                note.chara.push(next);
            }
            settingsChanged = true;
        }
    }

    if (metadataChanged) saveMetadataDebounced();
    if (settingsChanged) saveSettingsDebounced();
    setFloatingPrompt();
    return getAuthorsNoteState();
}

function setNoteTextCommand(_, text) {
    if (text) {
        updateAuthorsNoteState({ chat: { prompt: text } });
        toastr.success(t`Author's Note text updated`);
    }
    return chat_metadata[metadata_keys.prompt];
}

function setNoteDepthCommand(_, text) {
    if (text) {
        const value = Number(text);

        if (Number.isNaN(value)) {
            toastr.error(t`Not a valid number`);
            return;
        }

        updateAuthorsNoteState({ chat: { depth: value } });
        toastr.success(t`Author's Note depth updated`);
    }
    return chat_metadata[metadata_keys.depth];
}

function setNoteIntervalCommand(_, text) {
    if (text) {
        const value = Number(text);

        if (Number.isNaN(value)) {
            toastr.error(t`Not a valid number`);
            return;
        }

        updateAuthorsNoteState({ chat: { interval: value } });
        toastr.success(t`Author's Note frequency updated`);
    }
    return chat_metadata[metadata_keys.interval];
}

function setNotePositionCommand(_, text) {
    const validPositions = {
        'after': 0,
        'scenario': 0,
        'chat': 1,
        'before_scenario': 2,
        'before': 2,
    };

    if (text) {
        const position = validPositions[text?.trim()?.toLowerCase()];

        if (typeof position === 'undefined') {
            toastr.error(t`Not a valid position`);
            return;
        }

        updateAuthorsNoteState({ chat: { position } });
        toastr.info(t`Author's Note position updated`);
    }
    return Object.keys(validPositions).find(key => validPositions[key] == chat_metadata[metadata_keys.position]);
}

function setNoteRoleCommand(_, text) {
    const validRoles = {
        'system': 0,
        'user': 1,
        'assistant': 2,
    };

    if (text) {
        const role = validRoles[text?.trim()?.toLowerCase()];

        if (typeof role === 'undefined') {
            toastr.error(t`Not a valid role`);
            return;
        }

        updateAuthorsNoteState({ chat: { role } });
        toastr.info(t`Author's Note role updated`);
    }
    return Object.keys(validRoles).find(key => validRoles[key] == chat_metadata[metadata_keys.role]);
}

function loadSettings() {
    ensureAuthorsNoteState();
}

export function setFloatingPrompt() {
    ensureAuthorsNoteState();
    const context = getContext();
    if (!context.groupId && context.characterId === undefined) {
        console.debug('setFloatingPrompt: Not in a chat. Skipping.');
        shouldWIAddPrompt = false;
        return;
    }

    // take the count of messages
    let lastMessageNumber = Array.isArray(context.chat) && context.chat.length ? context.chat.filter(m => m.is_user).length : 0;

    console.debug(`
    setFloatingPrompt entered
    ------
    lastMessageNumber = ${lastMessageNumber}
    metadata_keys.interval = ${chat_metadata[metadata_keys.interval]}
    metadata_keys.position = ${chat_metadata[metadata_keys.position]}
    metadata_keys.depth = ${chat_metadata[metadata_keys.depth]}
    metadata_keys.role = ${chat_metadata[metadata_keys.role]}
    ------
    `);

    // interval 1 should be inserted no matter what
    if (chat_metadata[metadata_keys.interval] === 1) {
        lastMessageNumber = 1;
    }

    if (lastMessageNumber <= 0 || chat_metadata[metadata_keys.interval] <= 0) {
        context.setExtensionPrompt(MODULE_NAME, '', extension_prompt_types.NONE, MAX_INJECTION_DEPTH);
        shouldWIAddPrompt = false;
        return;
    }

    const messagesTillInsertion = lastMessageNumber >= chat_metadata[metadata_keys.interval]
        ? (lastMessageNumber % chat_metadata[metadata_keys.interval])
        : (chat_metadata[metadata_keys.interval] - lastMessageNumber);
    const shouldAddPrompt = messagesTillInsertion == 0;
    shouldWIAddPrompt = shouldAddPrompt;

    let prompt = shouldAddPrompt ? chat_metadata[metadata_keys.prompt] : '';
    if (shouldAddPrompt && extension_settings.note.chara && getContext().characterId !== undefined) {
        const charaNote = extension_settings.note.chara.find((e) => e.name === getCharaFilename());

        // Only replace with the chara note if the user checked the box
        if (charaNote && charaNote.useChara) {
            switch (charaNote.position) {
                case chara_note_position.before:
                    prompt = charaNote.prompt + '\n' + prompt;
                    break;
                case chara_note_position.after:
                    prompt = prompt + '\n' + charaNote.prompt;
                    break;
                default:
                    prompt = charaNote.prompt;
                    break;
            }
        }
    }
    context.setExtensionPrompt(
        MODULE_NAME,
        String(prompt),
        chat_metadata[metadata_keys.position],
        chat_metadata[metadata_keys.depth],
        extension_settings.note.allowWIScan,
        chat_metadata[metadata_keys.role],
    );
}

function onChatChanged() {
    loadSettings();
    setFloatingPrompt();
}

/**
 * Inject author's note options and setup event listeners.
 */
// Inserts the extension first since it's statically imported
export function initAuthorsNote() {
    loadSettings();

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'note',
        callback: setNoteTextCommand,
        returns: 'current author\'s note',
        unnamedArgumentList: [
            new SlashCommandArgument(
                'text', [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        helpString: `
            <div>
                Sets an author's note for the currently selected chat if specified and returns the current note.
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'note-depth',
        aliases: ['depth'],
        callback: setNoteDepthCommand,
        returns: 'current author\'s note depth',
        unnamedArgumentList: [
            new SlashCommandArgument(
                'number', [ARGUMENT_TYPE.NUMBER], false,
            ),
        ],
        helpString: `
            <div>
                Sets an author's note depth for in-chat positioning if specified and returns the current depth.
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'note-frequency',
        aliases: ['freq', 'note-freq'],
        callback: setNoteIntervalCommand,
        returns: 'current author\'s note insertion frequency',
        namedArgumentList: [],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'number', [ARGUMENT_TYPE.NUMBER], false,
            ),
        ],
        helpString: `
            <div>
                Sets an author's note insertion frequency if specified and returns the current frequency.
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'note-position',
        callback: setNotePositionCommand,
        aliases: ['pos', 'note-pos'],
        returns: 'current author\'s note insertion position',
        namedArgumentList: [],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'position', [ARGUMENT_TYPE.STRING], false, false, null, ['before', 'after', 'chat'],
            ),
        ],
        helpString: `
            <div>
                Sets an author's note position if specified and returns the current position.
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'note-role',
        callback: setNoteRoleCommand,
        returns: 'current author\'s note chat insertion role',
        namedArgumentList: [],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'role', [ARGUMENT_TYPE.STRING], false, false, null, ['system', 'user', 'assistant'],
            ),
        ],
        helpString: `
            <div>
                Sets an author's note chat insertion role if specified and returns the current role.
            </div>
        `,
    }));
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    registerAuthorsNoteMacros();
}

function registerAuthorsNoteMacros() {
    if (power_user.experimental_macro_engine) {
        macros.register('authorsNote', {
            category: MacroCategory.PROMPTS,
            description: t`The contents of the Author's Note`,
            handler: () => chat_metadata[metadata_keys.prompt] ?? '',
        });
        macros.register('charAuthorsNote', {
            category: MacroCategory.PROMPTS,
            description: t`The contents of the Character Author's Note`,
            handler: () => this_chid !== undefined ? (extension_settings.note.chara.find((e) => e.name === getCharaFilename())?.prompt ?? '') : '',
        });
        macros.register('defaultAuthorsNote', {
            category: MacroCategory.PROMPTS,
            description: t`The contents of the Default Author's Note`,
            handler: () => extension_settings.note.default ?? '',
        });
    } else {
        // TODO: Remove this when the experimental macro engine is replacing the old macro engine
        MacrosParser.registerMacro('authorsNote',
            () => chat_metadata[metadata_keys.prompt] ?? '',
            t`The contents of the Author's Note`,
        );
        MacrosParser.registerMacro('charAuthorsNote',
            () => this_chid !== undefined ? (extension_settings.note.chara.find((e) => e.name === getCharaFilename())?.prompt ?? '') : '',
            t`The contents of the Character Author's Note`,
        );
        MacrosParser.registerMacro('defaultAuthorsNote',
            () => extension_settings.note.default ?? '',
            t`The contents of the Default Author's Note`,
        );
    }
}
