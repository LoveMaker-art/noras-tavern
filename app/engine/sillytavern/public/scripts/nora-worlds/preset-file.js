export const PRESET_MAX_BYTES = 10 * 1024 * 1024;

export function presetFileSize(text) {
    return new TextEncoder().encode(text).byteLength;
}

export function encodePresetFile(value) {
    const compact = JSON.stringify(value);
    if (presetFileSize(compact) > PRESET_MAX_BYTES) {
        throw Object.assign(new Error('Preset exceeds 10 MB.'), { code: 'NORA_PRESET_TOO_LARGE' });
    }
    const pretty = JSON.stringify(value, null, 4);
    return presetFileSize(pretty) <= PRESET_MAX_BYTES ? pretty : compact;
}
