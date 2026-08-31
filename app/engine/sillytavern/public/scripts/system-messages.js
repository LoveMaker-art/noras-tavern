import { lodash } from '../lib.js';
import { addOneMessage, chat, displayVersion, setSendButtonState, system_avatar, systemUserName } from '../script.js';
import { t } from './i18n.js';
import { getMessageTimeStamp } from './RossAscends-mods.js';
import { getSlashCommandsHelp } from './slash-commands.js';
import { SlashCommandBrowser } from './slash-commands/SlashCommandBrowser.js';
import { MacroBrowser, getMacrosHelp } from './macros/engine/MacroBrowser.js';
import { renderTemplateAsync } from './templates.js';

/** @type {Record<string, ChatMessage>} */
export const system_messages = {};
/** @type {ChatMessage[]} */
export const SAFETY_CHAT = [];

/**
 * @enum {string} System message types
 */
export const system_message_types = {
    HELP: 'help',
    WELCOME: 'welcome',
    EMPTY: 'empty',
    GENERIC: 'generic',
    NARRATOR: 'narrator',
    COMMENT: 'comment',
    SLASH_COMMANDS: 'slash_commands',
    FORMATTING: 'formatting',
    HOTKEYS: 'hotkeys',
    MACROS: 'macros',
    WELCOME_PROMPT: 'welcome_prompt',
    ASSISTANT_NOTE: 'assistant_note',
    ASSISTANT_MESSAGE: 'assistant_message',
};

/**
 * Ensures that system-message callers always receive a valid message without
 * loading any of the legacy ST help or settings templates. The upstream UI can
 * later replace these entries with rendered templates through initSystemMessages.
 */
export function initSystemMessageCore() {
    const defaultMessage = {
        name: systemUserName,
        force_avatar: system_avatar,
        is_user: false,
        is_system: true,
        mes: '',
        extra: { swipeable: false },
    };

    for (const type of Object.values(system_message_types)) {
        system_messages[type] ??= structuredClone(defaultMessage);
    }

    system_messages.empty.mes ||= 'No one hears you. <b>Hint&#58;</b> add more members to the group!';
    system_messages.generic.mes ||= 'Generic system message. Use the `text` parameter to override the contents.';

    if (SAFETY_CHAT.length === 0) {
        SAFETY_CHAT.push({
            ...structuredClone(defaultMessage),
            send_date: getMessageTimeStamp(),
            mes: t`You deleted a character/chat and arrived back here for safety reasons! Pick another character!`,
        });
    }
}

/**
 * Returns the safety conversation through the headless system-message interface.
 * @returns {ChatMessage[]}
 */
export function getSafetyChat() {
    initSystemMessageCore();
    return SAFETY_CHAT.map(message => structuredClone(message));
}

export async function initSystemMessages() {
    /** @type {ChatMessage} */
    const defaultMessage = {
        name: systemUserName,
        force_avatar: system_avatar,
        is_user: false,
        is_system: true,
        extra: { swipeable: false },
    };
    const [help, hotkeys, formatting, welcome, welcomePrompt, assistantNote] = await Promise.all([
        renderTemplateAsync('help'),
        renderTemplateAsync('hotkeys'),
        renderTemplateAsync('formatting'),
        renderTemplateAsync('welcome', { displayVersion }),
        renderTemplateAsync('welcomePrompt'),
        renderTemplateAsync('assistantNote'),
    ]);

    /** @type {Record<string, ChatMessage>} */
    const result = {
        /** @type {ChatMessage} */
        help: lodash.merge(structuredClone(defaultMessage), {
            mes: help,
        }),
        /** @type {ChatMessage} */
        slash_commands: lodash.merge(structuredClone(defaultMessage), {
            mes: '',
        }),
        /** @type {ChatMessage} */
        hotkeys: lodash.merge(structuredClone(defaultMessage), {
            mes: hotkeys,
        }),
        /** @type {ChatMessage} */
        formatting: lodash.merge(structuredClone(defaultMessage), {
            mes: formatting,
        }),
        /** @type {ChatMessage} */
        macros: lodash.merge(structuredClone(defaultMessage), {
            mes: '',
        }),
        /** @type {ChatMessage} */
        welcome: lodash.merge(structuredClone(defaultMessage), {
            mes: welcome,
            extra: {
                uses_system_ui: true,
            },
        }),
        /** @type {ChatMessage} */
        empty: lodash.merge(structuredClone(defaultMessage), {
            mes: 'No one hears you. <b>Hint&#58;</b> add more members to the group!',
        }),
        /** @type {ChatMessage} */
        generic: lodash.merge(structuredClone(defaultMessage), {
            mes: 'Generic system message. User `text` parameter to override the contents',
        }),
        /** @type {ChatMessage} */
        welcome_prompt: lodash.merge(structuredClone(defaultMessage), {
            mes: welcomePrompt,
            extra: {
                uses_system_ui: true,
                isSmallSys: true,
            },
        }),
        /** @type {ChatMessage} */
        assistant_note: lodash.merge(structuredClone(defaultMessage), {
            mes: assistantNote,
            extra: {
                uses_system_ui: true,
                isSmallSys: true,
            },
        }),
    };

    Object.assign(system_messages, result);

    /** @type {ChatMessage} */
    const safetyMessage = {
        name: systemUserName,
        force_avatar: system_avatar,
        is_system: true,
        is_user: false,
        send_date: getMessageTimeStamp(),
        mes: t`You deleted a character/chat and arrived back here for safety reasons! Pick another character!`,
    };
    SAFETY_CHAT.splice(0, SAFETY_CHAT.length, safetyMessage);
}


/**
 * Gets a system message by type.
 * By default system messages are not swipeable.
 * This can be overridden by setting extra.swipeable to true.
 * @param {string} type Type of system message
 * @param {string} [text] Text to be sent
 * @param {ChatMessageExtra} [extra] Additional data to be added to the message
 * @returns {ChatMessage} System message object
 */
export function getSystemMessageByType(type, text, extra = {}) {
    initSystemMessageCore();
    const systemMessage = system_messages[type] ?? system_messages.generic;

    const newMessage = { ...structuredClone(systemMessage), send_date: getMessageTimeStamp() };

    if (text) {
        newMessage.mes = text;
    }

    if (type === system_message_types.SLASH_COMMANDS) {
        newMessage.mes = getSlashCommandsHelp();
    }

    if (type === system_message_types.MACROS) {
        newMessage.mes = getMacrosHelp();
    }

    newMessage.extra = { ...(newMessage.extra ?? {}), ...extra, type };
    return newMessage;
}

/**
 * Sends a system message to the chat.
 * @param {string} type Type of system message
 * @param {string} [text] Text to be sent
 * @param {ChatMessageExtra} [extra] Additional data to be added to the message
 */
export function sendSystemMessage(type, text, extra = {}) {
    const newMessage = getSystemMessageByType(type, text, extra);
    chat.push(newMessage);
    addOneMessage(newMessage);
    setSendButtonState(false);
    if (type === system_message_types.SLASH_COMMANDS) {
        const browser = new SlashCommandBrowser();
        const spinner = document.querySelector('#chat .last_mes .custom-slashHelp');
        const parent = spinner.parentElement;
        spinner.remove();
        browser.renderInto(parent);
        browser.search.focus();
    }

    if (type === system_message_types.MACROS) {
        const browser = new MacroBrowser();
        const spinner = document.querySelector('#chat .last_mes .custom-macroHelp');
        if (spinner) {
            const parent = spinner.parentElement;
            spinner.remove();
            browser.renderInto(parent);
            browser.searchInput?.focus();
        }
    }
}
