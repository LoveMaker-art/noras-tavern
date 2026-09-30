import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const start = source.indexOf('export async function sendTextareaMessage(');
const send = source.slice(start, source.indexOf('\n/**', start)).replace('export ', '');
const userStart = source.indexOf('    if ((textareaText !=');
const userBlock = source.slice(userStart, source.indexOf('\n    let {', userStart));

test('generation activity wrapper forwards the persistence callback to the core', async () => {
    const start = source.indexOf('export async function Generate(');
    const wrapper = source.slice(start, source.indexOf('\nasync function generateCore(', start)).replace('export ', '');
    const callback = () => {};
    let registered = false;
    const scope = {
        runNoraChatActivity: async (kind, run) => { assert.equal(kind, 'generation'); registered = true; return run(); },
        generateCore: async (type, options, dryRun) => {
            assert.equal(registered, true);
            assert.equal(type, 'normal');
            assert.equal(options.onUserMessagePersisted, callback);
            assert.equal(dryRun, false);
            return 'reply';
        },
        unblockGeneration() { assert.fail('successful generation must not enter error cleanup'); },
    };
    vm.createContext(scope);
    vm.runInContext(wrapper, scope);
    assert.equal(await scope.Generate('normal', { onUserMessagePersisted: callback }), 'reply');
    assert.match(source, /async function generateCore\([^\n]*onUserMessagePersisted/);
});

for (const saveFails of [false, true]) {
    test(`provider failure carries acknowledged persistence only (saveFails=${saveFails})`, async () => {
        let shown = 0;
        const scope = {
            swipeState: 0, SWIPE_STATE: { NONE: 0, EDITING: 1 },
            is_send_press: false, isExecutingCommandsFromChatInput: false,
            hideSwipeButtons() {}, showSwipeButtons() { shown++; },
            power_user: {}, chat: [], this_chid: 0, name2: 'World',
            hasPendingFileAttachment: () => false,
            textareaText: 'test', messageBias: '', automatic_trigger: false,
            type: 'normal', dryRun: false, depth: 0,
            sendMessageAsUser: async () => { if (saveFails) throw new Error('save rejected'); },
        };
        vm.createContext(scope);
        scope.Generate = async (_type, options) => {
            scope.onUserMessagePersisted = options.onUserMessagePersisted;
            await vm.runInContext(`(async () => { ${userBlock} })()`, scope);
            throw new Error('provider 503');
        };
        vm.runInContext(send, scope);
        await assert.rejects(scope.sendTextareaMessage('test'), error => {
            assert.equal(Boolean(error.noraMessagePersisted), !saveFails);
            return true;
        });
        assert.equal(shown, 1);
    });
}
