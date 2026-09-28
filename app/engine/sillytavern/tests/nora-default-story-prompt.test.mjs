import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as constants from '../public/scripts/constants.js';

const readJson = relative => JSON.parse(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'));
const main = preset => preset.prompts.find(prompt => prompt.identifier === 'main').content;
const packaged = main(readJson('../default/content/presets/openai/Default.json'));

function initializer(file, name) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const declaration = parsed.statements.filter(ts.isVariableStatement)
        .flatMap(node => [...node.declarationList.declarations])
        .find(node => node.name.getText(parsed) === name);
    assert.ok(declaration, name);
    return vm.runInNewContext(`(${declaration.initializer.getText(parsed)})`, { ...constants });
}

test('prompt manager and chat completion fallback use the packaged Chinese default exactly', () => {
    assert.ok(packaged.startsWith('# 角色\n'));
    assert.equal(main(initializer('../public/scripts/PromptManager.js', 'chatCompletionDefaultPrompts')), packaged);
    assert.equal(initializer('../public/scripts/openai.js', 'default_main_prompt'), packaged);
});

test('new user and text-completion defaults agree with the same story prompt', () => {
    const settings = readJson('../default/content/settings.json');
    assert.equal(main(settings.oai_settings), packaged);
    assert.equal(settings.power_user.sysprompt.content, packaged);
    assert.equal(readJson('../default/content/presets/sysprompt/Neutral - Chat.json').content, packaged);
});
