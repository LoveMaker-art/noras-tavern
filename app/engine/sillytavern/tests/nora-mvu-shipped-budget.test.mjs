import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await fs.readFile(new URL('../../../native-extensions/JS-Slash-Runner/dist/index.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('runner.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
// Execute the shipped dispatcher, prompt collector and HTTP override function together.
const names = ['EK', 'uG', 'BG'];
const declarations = ast.statements.filter(ts.isFunctionDeclaration).filter(node => names.includes(node.name?.text));
assert.equal(declarations.length, names.length, 'Recheck the managed runner bindings on vendor upgrades');

function runtime() {
    const budgets = [];
    const requests = [];
    const settings = { openai_max_context: 32768, openai_max_tokens: 2048, temp_openai: 0.4, top_p_openai: 0.8 };
    const context = vm.createContext({
        wt: settings, pK: new Map(), mK: new Set(), AbortController,
        k: { emit: async () => {} }, A: {}, yK() {}, RW() {},
        fG: async input => ({ processedUserInput: input, processedImageArray: [] }),
        GW: async () => ({}),
        vt: class {
            setTokenBudget(context, output) { budgets.push({ context, output }); }
            reserveBudget() {} freeBudget() {} getChat() { return []; }
        },
        oG: async () => ({ systemPrompts: new Map(), dialogue_examples: [] }),
        yt: { createAsync: async () => ({}) }, sG: async () => {},
        GG: async (_prompt, _stream, _id, _image, _abort, custom) => {
            const request = { max_tokens: settings.openai_max_tokens, temperature: settings.temp_openai, top_p: settings.top_p_openai };
            if (custom) context.BG(request, custom);
            requests.push(request);
            return 'ok';
        },
    });
    vm.runInContext(declarations.map(node => node.getText(ast)).join('\n'), context);
    return { budgets, requests, settings, generate: custom => context.EK({
        generation_id: 'budget-test', user_input: 'update variables', use_preset: false,
        bindToStopButton: false, order: [], custom_api: custom,
    }) };
}

test('independent MVU uses its own budgets in both prompt collection and outgoing overrides', async () => {
    const run = runtime();
    const before = structuredClone(run.settings);
    await run.generate({ max_context: 64000, max_tokens: 8000, temperature: 0.2, top_p: 0.6 });
    assert.deepEqual(run.budgets, [{ context: 64000, output: 8000 }]);
    assert.deepEqual(run.requests, [{ max_tokens: 8000, temperature: 0.2, top_p: 0.6 }]);
    assert.deepEqual(run.settings, before, 'Independent requests must not rewrite World settings');
});

test('following mode follows the current World; independent mode stays unchanged between Worlds', async () => {
    const run = runtime();
    const independent = { max_context: 16000, max_tokens: 1000 };
    await run.generate();
    await run.generate(independent);
    Object.assign(run.settings, { openai_max_context: 65536, openai_max_tokens: 4096 });
    await run.generate();
    await run.generate(independent);
    assert.deepEqual(run.budgets, [
        { context: 32768, output: 2048 }, { context: 16000, output: 1000 },
        { context: 65536, output: 4096 }, { context: 16000, output: 1000 },
    ]);
    assert.deepEqual(run.requests.map(request => request.max_tokens), [2048, 1000, 4096, 1000]);
});

test('legacy custom connections without budget overrides keep the preset fallback', async () => {
    const run = runtime();
    await run.generate({ model: 'independent', max_tokens: 'same_as_preset' });
    assert.deepEqual(run.budgets, [{ context: 32768, output: 2048 }]);
    assert.equal(run.requests[0].max_tokens, 2048);
});
