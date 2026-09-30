import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import fs from 'node:fs/promises';
import { parse } from 'acorn';
import { buildInlineModuleManifest } from '../build/generate-nora-runtime-assets.mjs';

// The public formatter delegates its final rendering to the host. Exercise hooks
// without mounting Nora's UI or running scripts from a real character card.
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === '../script.js' && context.parentURL?.endsWith('/message-formatter.js')) {
        return { url: 'data:text/javascript,export function messageFormatting(...args){return args}', shortCircuit: true };
    }
    return nextResolve(specifier, context);
} });
const { MessageFormatter: formatter } = await import('../public/scripts/message-formatter.js');
hooks.deregister();

test('public formatter orders synchronous hooks, isolates failures and preserves context', t => {
    const contexts = [];
    formatter.addHook((text, context) => { contexts.push(context); return text + 'late'; }, { order: formatter.order.LATE });
    formatter.addHook(text => text + 'early:', { order: formatter.order.EARLY });
    formatter.addHook(() => { throw new Error('fixture hook'); });
    formatter.addHook(() => Promise.resolve('invalid asynchronous result'));
    t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
    const metadata = { characterName: 'Example', messageId: 3, isReasoning: false };
    assert.equal(formatter.runStage(formatter.stage.AFTER_MARKDOWN, 'text:', metadata), 'text:early:late');
    assert.equal(contexts[0].characterName, 'Example');
    assert.ok(Object.isFrozen(contexts[0]));
    assert.equal(contexts[0].stage, formatter.stage.AFTER_MARKDOWN);
    assert.equal(formatter.runStage(formatter.stage.BEFORE_REGEX, 'unchanged', metadata), 'unchanged');
    assert.throws(() => formatter.addHook(async text => text), /synchronous/);
    assert.throws(() => formatter.addHook(text => text, { stage: 'postSanitize' }), /unknown stage/);
    assert.deepEqual(formatter.format('text', 'Example', false, true, 3), ['text', 'Example', false, true, 3, {}, false]);
});

test('shipped rendering supplies documented metadata and runs every hook before sanitization', async () => {
    const source = await fs.readFile(new URL('../public/script.js', import.meta.url), 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const fn = ast.body.find(node => node.declaration?.id?.name === 'messageFormatting').declaration;
    const body = source.slice(fn.start, fn.end);
    const calls = [...body.matchAll(/MessageFormatter\.runStage\([\s\S]*?\);/g)];
    assert.equal(calls.length, 3);
    for (const call of calls) {
        assert.match(call[0], /characterName:\s*ch_name/);
        assert.ok(call.index < body.indexOf('DOMPurify.sanitize'), 'hooks must not bypass sanitization');
    }
    const manifest = await buildInlineModuleManifest(['/script.js']);
    assert.ok(manifest.modules['scripts/message-formatter.js']);
    assert.ok(manifest.aliases['scripts/message-formatter.js']);
});
