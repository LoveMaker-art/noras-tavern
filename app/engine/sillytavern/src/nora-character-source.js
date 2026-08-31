import crypto from 'node:crypto';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function sourceFingerprint(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function attachCharacterSource(character, sha256) {
    const normalized = String(sha256 || '').trim().toLowerCase();
    if (!SHA256_PATTERN.test(normalized)) throw new Error('Character source fingerprint is invalid.');
    character.data ??= {};
    character.data.extensions ??= {};
    character.data.extensions.nora_import = { source_sha256: normalized };
    return character;
}

export function characterSourceMetadata(character) {
    const sha256 = String(character?.data?.extensions?.nora_import?.source_sha256 || '').trim().toLowerCase();
    return SHA256_PATTERN.test(sha256) ? { source_sha256: sha256 } : undefined;
}
