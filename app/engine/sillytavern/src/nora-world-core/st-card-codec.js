import fs from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_AVATAR_PATH } from '../constants.js';
import { TavernCardValidator } from '../validator/TavernCardValidator.js';
import { NoraWorldCoreError } from './errors.js';

function validateCard(card) {
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
                const card = JSON.parse(buffer.toString('utf8'));
                const version = validateCard(card);
                if (version === 1) {
                    throw new NoraWorldCoreError(
                        'NORA_CARD_FORMAT_UNSUPPORTED',
                        'V1 JSON cards require canonical ST conversion before World materialization.',
                    );
                }
                return {
                    card,
                    runtimeCardBuffer: await encodeCard(card, DEFAULT_AVATAR_PATH, serverRoot),
                };
            }
            if (normalizedFormat === 'charx') {
                const { CharXParser } = await import('../charx.js');
                const parsed = await new CharXParser(buffer).parse();
                validateCard(parsed.card);
                if (parsed.auxiliaryAssets.length) {
                    throw new NoraWorldCoreError(
                        'NORA_CARD_UNSUPPORTED_ASSETS',
                        'This CHARX contains auxiliary assets that do not yet have authoritative World resources.',
                        { details: { assetCount: parsed.auxiliaryAssets.length } },
                    );
                }
                return {
                    card: parsed.card,
                    runtimeCardBuffer: await encodeCard(parsed.card, parsed.avatar, serverRoot),
                };
            }
            throw new NoraWorldCoreError(
                'NORA_CARD_FORMAT_UNSUPPORTED',
                `Character card format ${normalizedFormat || '<empty>'} is not supported by the ST backend adapter.`,
            );
        },
    });
}
