import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const source = process.env.NORA_MVU_SOURCE_DIR;
const extension = new URL('../../../native-extensions/nora-mvu/', import.meta.url);
const bundle = process.env.NORA_MVU_BUNDLE_PATH || new URL('vendor/bundle.js', extension);
const misleading = /魔棒|魔杖|左下角|日志查看器|Magic Wand|Log Viewer|重\s*Roll|rerolling may help/i;

function messages() {
    const text = fs.readFileSync(path.join(source, 'src/i18n/messages/runtime.ts'), 'utf8');
    const context = vm.createContext({ defineMessages: value => value });
    vm.runInContext(text.replace(/^import .*;\s*$/m, '').replace('export const runtimeMessages', 'globalThis.runtimeMessages'), context);
    return context.runtimeMessages;
}

test('MVU failures describe the error without obsolete UI directions or speculative reroll advice', { skip: !source }, () => {
    const catalog = messages();
    for (const key of ['runtime.extraModel.updateFailed', 'runtime.variableUpdate.errorTitle']) {
        for (const [locale, text] of Object.entries(catalog[key])) {
            assert.doesNotMatch(text, misleading, `${key}/${locale}`);
        }
    }
    assert.match(catalog['runtime.variableUpdate.errorTitle']['zh-CN'], /\{command\}/);
    assert.match(catalog['runtime.variableUpdate.errorTitle'].en, /\{command\}/);
});

test('worldbook read errors do not invent group-chat or card-incompatibility diagnoses', { skip: !source }, () => {
    const notice = messages()['runtime.extraModel.characterLorebookUnavailableLog'];
    for (const text of Object.values(notice)) assert.doesNotMatch(text, /多人聊天|group chats|不支持/);
});

test('failure notice does not claim logs are durably saved or prescribe changing model settings', { skip: !source }, () => {
    for (const text of Object.values(messages()['runtime.extraModel.updateFailed'])) {
        assert.doesNotMatch(text, /已保存|已记录|saved|recorded|建议调整|Try adjusting/i);
    }
});

test('startup notices do not advertise removed ST menus or promise model success', { skip: !source }, () => {
    for (const [key, translations] of Object.entries(messages()).filter(([key]) => key.startsWith('runtime.notification.'))) {
        for (const [locale, text] of Object.entries(translations)) {
            assert.doesNotMatch(text, /正则.*下方|below.*Regex|变量更新方式 →|Variable Update Method →|取消“发送预设”|When Send Preset is disabled|提高.*成功率|improve.*success rates|不会影响你回退|without preventing you/i, `${key}/${locale}`);
        }
    }
});

test('shipped MVU bundle contains no obsolete wand or blanket reroll guidance', () => {
    assert.equal(misleading.test(fs.readFileSync(bundle, 'utf8')), false,
        'The bundled runtime still contains obsolete UI directions');
});
