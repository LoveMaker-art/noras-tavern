import { controlError } from './contract.js';

const forbidden = key => /^(?:__proto__|prototype|constructor)$/.test(key)
    || /api.?key|access.?token|auth.?token|secret|password|^token$|^key$|密钥|密码/i.test(key);
const fail = () => { throw controlError('NORA_CONTROL_FIELD_DENIED', 'Only existing non-secret fields of the same type may be patched.'); };

export function patchExistingConfiguration(value, updates) {
    const next = structuredClone(value);
    function assign(target, key, replacement) {
        if (!target || typeof target !== 'object' || Array.isArray(target) && !/^(0|[1-9][0-9]*)$/.test(key)) fail();
        if (forbidden(key) || !Object.hasOwn(target, key)) fail();
        const previous = target[key];
        if (replacement === null || previous === null) { if (replacement !== previous) fail(); return; }
        if (typeof previous !== typeof replacement) fail();
        if (typeof replacement === 'object') {
            if (Array.isArray(previous) !== Array.isArray(replacement)) fail();
            if (Array.isArray(previous) && previous.length !== replacement.length) fail();
            for (const child of Object.keys(replacement)) assign(previous, child, replacement[child]);
        } else {
            if (!['string', 'boolean', 'number'].includes(typeof replacement) || typeof replacement === 'number' && !Number.isFinite(replacement)) fail();
            target[key] = replacement;
        }
    }
    for (const [path, replacement] of Object.entries(updates)) {
        const parts = path.split('.');
        if (parts.some(part => !part || forbidden(part))) fail();
        let parent = next;
        for (const part of parts.slice(0, -1)) {
            if (!parent || !Object.hasOwn(parent, part) || !parent[part] || typeof parent[part] !== 'object') fail();
            parent = parent[part];
        }
        assign(parent, parts.at(-1), replacement);
    }
    return next;
}
