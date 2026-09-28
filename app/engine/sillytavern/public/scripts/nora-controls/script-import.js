import { controlError } from './contract.js';

// Accept the Helper export formats, not a character card or an arbitrary JSON object.
// The live Helper still validates and owns persistence/lifecycle after this conversion.
export function prepareScriptImport(input, uuid = () => crypto.randomUUID()) {
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    const fail = () => { throw controlError('NORA_SCRIPT_IMPORT_INVALID', '请选择酒馆助手导出的脚本或脚本文件夹 JSON。'); };
    function script(value) {
        if (!object(value) || (value.type !== undefined && value.type !== 'script') || typeof value.content !== 'string') return fail();
        if (value.name !== undefined && typeof value.name !== 'string') return fail();
        const old = Object.hasOwn(value, 'buttons');
        const button = old ? { enabled: true, buttons: value.buttons } : value.button ?? { enabled: true, buttons: [] };
        if (!object(button) || (button.enabled !== undefined && typeof button.enabled !== 'boolean') ||
            !Array.isArray(button.buttons ?? []) || (button.buttons ?? []).some(b => !object(b) || typeof b.name !== 'string' || (b.visible !== undefined && typeof b.visible !== 'boolean'))) return fail();
        if (value.data !== undefined && !object(value.data)) return fail();
        if (value.export_with !== undefined && (!object(value.export_with) || ['data', 'button'].some(k => value.export_with[k] !== undefined && typeof value.export_with[k] !== 'boolean'))) return fail();
        if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return fail();
        return { type: 'script', id: uuid(), name: value.name || '', enabled: value.enabled === true,
            content: value.content, info: typeof value.info === 'string' ? value.info : '',
            button: { enabled: button.enabled !== false, buttons: (button.buttons ?? []).map(b => ({ name: b.name, visible: b.visible !== false })) },
            data: structuredClone(value.data ?? {}), export_with: { data: value.export_with?.data !== false, button: value.export_with?.button !== false } };
    }
    if (!object(input)) return fail();
    let tree;
    if (input.type === 'folder') {
        if (!Array.isArray(input.scripts) || input.scripts.length > 100 || (input.name !== undefined && typeof input.name !== 'string')) return fail();
        tree = { type: 'folder', id: uuid(), name: input.name || '', enabled: false,
            icon: typeof input.icon === 'string' ? input.icon : 'fa-solid fa-folder',
            color: typeof input.color === 'string' ? input.color : '', scripts: input.scripts.map(script) };
    } else {
        if (input.type !== 'script' && !Object.hasOwn(input, 'buttons')) return fail();
        tree = script(input);
        tree.enabled = false;
    }
    return tree;
}
