import fs from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_AVATAR_PATH } from '../constants.js';
import { TavernCardValidator } from '../validator/TavernCardValidator.js';
import { NoraWorldCoreError } from './errors.js';

function normalizeStCompatibilityDefaults(card) {
    const characterBook = card?.data?.character_book;
    if (card?.spec === 'chara_card_v2'
        && characterBook
        && typeof characterBook === 'object'
        && !Array.isArray(characterBook)
        && !Object.hasOwn(characterBook, 'extensions')) {
        characterBook.extensions = {};
    }
    return card;
}

function validateCard(card) {
    normalizeStCompatibilityDefaults(card);
    const validator = new TavernCardValidator(card);
    const version = validator.validate();
    if (!version) {
        throw new NoraWorldCoreError(
            'NORA_CARD_INVALID',
            `The staged character card is invalid at ${validator.lastValidationError || 'an unknown field'}.`,
        );
    }
    return version;
}

function stringList(value) {
    if (Array.isArray(value)) return value.map(item => String(item || '')).filter(Boolean);
    if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean);
    return [];
}

function v2Card(source, fields) {
    const preserved = source && typeof source === 'object' && !Array.isArray(source)
        ? structuredClone(source)
        : {};
    const existingData = preserved.data && typeof preserved.data === 'object' && !Array.isArray(preserved.data)
        ? preserved.data
        : {};
    const existingExtensions = existingData.extensions && typeof existingData.extensions === 'object' && !Array.isArray(existingData.extensions)
        ? existingData.extensions
        : {};
    const name = String(fields.name || '').trim();
    const data = {
        ...existingData,
        name,
        description: String(fields.description || ''),
        personality: String(fields.personality || ''),
        scenario: String(fields.scenario || ''),
        first_mes: String(fields.first_mes || ''),
        mes_example: String(fields.mes_example || ''),
        creator_notes: String(fields.creator_notes || ''),
        system_prompt: String(fields.system_prompt || ''),
        post_history_instructions: String(fields.post_history_instructions || ''),
        alternate_greetings: stringList(fields.alternate_greetings),
        tags: stringList(fields.tags),
        creator: String(fields.creator || ''),
        character_version: String(fields.character_version || ''),
        extensions: {
            ...existingExtensions,
            talkativeness: fields.talkativeness ?? existingExtensions.talkativeness ?? 0.5,
            fav: fields.fav === true || fields.fav === 'true',
            ...(fields.world ? { world: String(fields.world) } : {}),
        },
    };
    return {
        ...preserved,
        name,
        description: data.description,
        personality: data.personality,
        scenario: data.scenario,
        first_mes: data.first_mes,
        mes_example: data.mes_example,
        creatorcomment: data.creator_notes,
        talkativeness: data.extensions.talkativeness,
        fav: data.extensions.fav,
        tags: data.tags,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data,
    };
}

function normalizeJsonCard(card) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
        throw new NoraWorldCoreError('NORA_CARD_INVALID', 'The character card JSON root must be an object.');
    }
    if (card.spec !== undefined) {
        const version = validateCard(card);
        if (version === 1) {
            throw new NoraWorldCoreError(
                'NORA_CARD_FORMAT_UNSUPPORTED',
                'A card with a spec label must store its fields under data.',
            );
        }
        return card;
    }
    if (card.name !== undefined) {
        return v2Card(card, {
            name: card.name,
            description: card.description,
            personality: card.personality,
            scenario: card.scenario,
            first_mes: card.first_mes,
            mes_example: card.mes_example,
            creator_notes: card.creatorcomment ?? card.creator_notes,
            system_prompt: card.system_prompt,
            post_history_instructions: card.post_history_instructions,
            alternate_greetings: card.alternate_greetings,
            tags: card.tags,
            creator: card.creator,
            character_version: card.character_version,
            talkativeness: card.talkativeness,
            fav: card.fav,
            world: card.world,
        });
    }
    if (card.char_name !== undefined) {
        return v2Card(card, {
            name: card.char_name,
            description: card.char_persona,
            scenario: card.world_scenario,
            first_mes: card.char_greeting,
            mes_example: card.example_dialogue,
            creator_notes: card.creatorcomment ?? card.creator_notes,
            tags: card.tags,
            creator: card.creator,
            talkativeness: card.talkativeness,
            fav: card.fav,
        });
    }
    throw new NoraWorldCoreError('NORA_CARD_INVALID', 'The JSON is not an ST, Tavern Card, or Pygmalion character card.');
}

function normalizeYamlCard(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source) || !String(source.name || '').trim()) {
        throw new NoraWorldCoreError('NORA_CARD_INVALID', 'The YAML character card must contain a name.');
    }
    return v2Card(source, {
        name: source.name,
        description: source.context,
        first_mes: source.greeting,
    });
}

async function encodeCard(card, avatar, serverRoot) {
    const { write } = await import('../character-card-parser.js');
    const avatarBuffer = Buffer.isBuffer(avatar)
        ? avatar
        : await fs.readFile(path.resolve(serverRoot, avatar || DEFAULT_AVATAR_PATH));
    return write(avatarBuffer, JSON.stringify(card));
}

export function createStCardCodec({ serverRoot = process.cwd() } = {}) {
    return Object.freeze({
        async encodeRuntimeCard({ card, sourceBuffer }) {
            validateCard(card);
            return encodeCard(card, sourceBuffer, serverRoot);
        },
        async decode({ buffer, format }) {
            const normalizedFormat = String(format || '').trim().toLowerCase();
            if (normalizedFormat === 'png') {
                const { read } = await import('../character-card-parser.js');
                const card = JSON.parse(read(buffer));
                validateCard(card);
                return { card, runtimeCardBuffer: buffer };
            }
            if (normalizedFormat === 'json') {
                const card = normalizeJsonCard(JSON.parse(buffer.toString('utf8')));
                validateCard(card);
                return {
                    card,
                    runtimeCardBuffer: await encodeCard(card, DEFAULT_AVATAR_PATH, serverRoot),
                };
            }
            if (normalizedFormat === 'yaml' || normalizedFormat === 'yml') {
                const yaml = await import('yaml');
                const card = normalizeYamlCard(yaml.parse(buffer.toString('utf8')));
                validateCard(card);
                return {
                    card,
                    runtimeCardBuffer: await encodeCard(card, DEFAULT_AVATAR_PATH, serverRoot),
                };
            }
            if (normalizedFormat === 'charx') {
                const { CharXParser } = await import('../charx.js');
                const parsed = await new CharXParser(buffer).parse();
                validateCard(parsed.card);
                return {
                    card: parsed.card,
                    runtimeCardBuffer: await encodeCard(parsed.card, parsed.avatar, serverRoot),
                    auxiliaryAssets: parsed.auxiliaryAssets,
                    extractedAssetBuffers: parsed.extractedBuffers,
                };
            }
            if (normalizedFormat === 'byaf') {
                const { ByafParser } = await import('../byaf.js');
                const parsed = await new ByafParser(buffer).parse();
                validateCard(parsed.card);
                return {
                    card: parsed.card,
                    runtimeCardBuffer: await encodeCard(parsed.card, parsed.images?.[0]?.image, serverRoot),
                };
            }
            throw new NoraWorldCoreError(
                'NORA_CARD_FORMAT_UNSUPPORTED',
                `Character card format ${normalizedFormat || '<empty>'} is not supported by the ST backend adapter.`,
            );
        },
    });
}
