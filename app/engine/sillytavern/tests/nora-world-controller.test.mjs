import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorldController } from '../../../native-extensions/nora-ui/world-controller.js';
import { translate as tr } from '../public/scripts/nora-i18n/core.js';
import { english } from '../public/scripts/nora-i18n/strings.js';

function fixture(operation) {
    const list = { innerHTML: '' };
    const state = { worldModels: [], worldStatus: { operation } };
    const calls = [];
    const controller = createWorldController({
        store: { read: () => state }, readState() {}, select: () => list,
        worldRuntime: { retryPendingCreation: async () => calls.push('create'), refresh: async () => {} },
        timedUiStep: (_name, action) => action(), recordBootMilestone() {}, showToast() {},
    });
    return { controller, list, state, calls };
}

test('World progress uses the actual operation, not a creation fallback', () => {
    for (const [kind, label] of Object.entries({
        DELETE: '正在删除世界…', REPAIR: '正在检查世界…',
        IMPORT: '正在导入角色卡…', RESTART: '正在准备新开局…',
        BLANK: '正在创建世界…', CREATE_RECOVERY: '正在恢复世界创建…',
        UNKNOWN: '正在处理世界操作…',
    })) {
        const f = fixture({ kind, status: 'RUNNING' });
        f.controller.renderRail();
        assert.ok(Object.hasOwn(english, label), `Missing translation: ${label}`);
        assert.ok(f.list.innerHTML.includes(tr(label)), kind);
    }
});

test('only recoverable creation operations offer the creation retry control', () => {
    for (const kind of ['DELETE', 'REPAIR', 'UNKNOWN', 'BLANK', 'IMPORT', 'RESTART', 'CREATE_RECOVERY']) {
        for (const retryable of [true, false]) {
            const f = fixture({ kind, status: 'FAILED', error: { retryable } });
            f.controller.renderRail();
            assert.ok(f.list.innerHTML.includes('role="alert"'), kind);
            assert.equal(f.list.innerHTML.includes('data-retry-world-import'),
                retryable && ['BLANK', 'IMPORT', 'RESTART', 'CREATE_RECOVERY'].includes(kind), kind);
            if (kind === 'DELETE') assert.ok(f.list.innerHTML.includes(tr('世界删除未完成')));
            if (kind === 'REPAIR') assert.ok(f.list.innerHTML.includes(tr('世界检查未完成')));
        }
    }
});

test('a stale creation retry button cannot retry creation after a delete failure', async t => {
    const previous = globalThis.Element;
    class Button {
        closest(selector) { return selector === '[data-retry-world-import]' ? this : null; }
    }
    globalThis.Element = Button;
    t.after(() => { if (previous === undefined) delete globalThis.Element; else globalThis.Element = previous; });
    for (const kind of ['DELETE', 'REPAIR', 'UNKNOWN', 'BLANK']) {
        const f = fixture({ kind, status: 'FAILED', error: { retryable: true } });
        await f.controller.selectWorld({ target: new Button() });
        assert.deepEqual(f.calls, kind === 'BLANK' ? ['create'] : []);
    }
});

test('idle and completed operations do not leave a progress or failure banner', () => {
    for (const status of ['IDLE', 'COMPLETED']) {
        const f = fixture({ kind: 'DELETE', status });
        f.controller.renderRail();
        assert.equal(f.list.innerHTML.includes('nora-world-progress'), false);
    }
});
