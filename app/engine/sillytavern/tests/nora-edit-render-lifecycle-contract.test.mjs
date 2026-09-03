import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const script = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');

function functionBody(name, nextName) {
    const start = script.indexOf(`export async function ${name}`);
    const end = script.indexOf(`\n${nextName}`, start);
    assert.notEqual(start, -1, `${name} must exist`);
    assert.notEqual(end, -1, `${name} boundary must exist`);
    return script.slice(start, end);
}

test('Nora branch edits preserve unchanged rich-message DOM nodes', () => {
    const body = functionBody('commitNoraStoryEdit', 'function openMessageDelete');
    assert.match(body, /messageElement\.nextAll\('\.mes'\)\.remove\(\)/);
    assert.match(body, /messageElement\.replaceWith\(replacement\)/);
    assert.doesNotMatch(body, /await printMessages\(\);/);
    assert.match(body, /await printMessages\(\{ announceRendered: true \}\)/);
});

test('full-history hydration announces every rebuilt message through ST render events', () => {
    const printStart = script.indexOf('export async function printMessages');
    const printEnd = script.indexOf('\nexport function scrollOnMediaLoad', printStart);
    const printBody = script.slice(printStart, printEnd);
    assert.match(printBody, /announceRendered = false/);
    assert.match(printBody, /children\('#show_more_messages'\)\.remove\(\)/);
    assert.match(printBody, /event_types\.USER_MESSAGE_RENDERED/);
    assert.match(printBody, /event_types\.CHARACTER_MESSAGE_RENDERED/);
    assert.match(script, /await printMessages\(\{ announceRendered: true \}\);\n\s*return chat;/);
});
