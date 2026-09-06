import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('a rejected locked-history save restores the authoritative chat once', async () => {
    const { createLedgerSaveRecovery } = await import('../public/scripts/nora-story-ledger/save-recovery.js');
    let target = 'world-1/session-1';
    let chat = ['mutated locked history'];
    let reloads = 0;
    const recover = createLedgerSaveRecovery({
        currentTarget: () => target,
        reload: async () => {
            reloads += 1;
            chat = ['authoritative history'];
        },
    });
    const error = Object.assign(new Error('locked'), { code: 'NORA_LEDGER_HISTORY_LOCKED' });

    const [left, right] = await Promise.all([
        recover(error, target),
        recover(error, target),
    ]);

    assert.equal(left, true);
    assert.equal(right, true);
    assert.equal(reloads, 1);
    assert.deepEqual(chat, ['authoritative history']);
});

test('save recovery ignores unrelated errors and a World that changed during save', async () => {
    const { createLedgerSaveRecovery } = await import('../public/scripts/nora-story-ledger/save-recovery.js');
    let target = 'world-2/session-2';
    let reloads = 0;
    const recover = createLedgerSaveRecovery({
        currentTarget: () => target,
        reload: async () => { reloads += 1; },
    });

    assert.equal(await recover(Object.assign(new Error('network'), { code: 'ECONNRESET' }), target), false);
    const staleTarget = target;
    target = 'world-3/session-3';
    assert.equal(await recover(Object.assign(new Error('locked'), { code: 'NORA_LEDGER_STORAGE_CONFLICT' }), staleTarget), false);
    assert.equal(reloads, 0);
});

test('save recovery rechecks navigation before reload and runs only once per session', async () => {
    const { createLedgerSaveRecovery } = await import('../public/scripts/nora-story-ledger/save-recovery.js');
    let target = 'world-1/session-1';
    let targetReads = 0;
    let reloads = 0;
    const recover = createLedgerSaveRecovery({
        currentTarget: () => {
            targetReads += 1;
            if (targetReads === 2) target = 'world-2/session-2';
            return target;
        },
        reload: async () => { reloads += 1; },
    });
    const error = Object.assign(new Error('locked'), { code: 'NORA_LEDGER_HISTORY_LOCKED' });

    assert.equal(await recover(error, 'world-1/session-1'), false);
    assert.equal(reloads, 0);

    target = 'world-1/session-1';
    targetReads = 2;
    assert.equal(await recover(error, target), true);
    assert.equal(await recover(error, target), false);
    assert.equal(reloads, 1);
});

test('save recovery does not mark a session restored when navigation changes during reload', async () => {
    const { createLedgerSaveRecovery } = await import('../public/scripts/nora-story-ledger/save-recovery.js');
    let target = 'world-1/session-1';
    let reloads = 0;
    const recover = createLedgerSaveRecovery({
        currentTarget: () => target,
        reload: async () => {
            reloads += 1;
            target = 'world-2/session-2';
        },
    });
    const error = Object.assign(new Error('locked'), { code: 'NORA_LEDGER_HISTORY_LOCKED' });

    assert.equal(await recover(error, 'world-1/session-1'), false);
    target = 'world-1/session-1';
    assert.equal(await recover(error, 'world-1/session-1'), false);
    assert.equal(reloads, 2);
});

test('the canonical ST save path invokes ledger recovery after releasing the save lock', () => {
    const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
    const start = source.indexOf('export async function saveChatConditional()');
    const end = source.indexOf('/**\n * Saves the chat to the server.', start);
    const implementation = source.slice(start, end);

    assert.match(implementation, /createChatSaveTarget|chatSaveTarget/);
    assert.ok(implementation.indexOf('isChatSaving = false') < implementation.indexOf('recoverLedgerSaveFailure'));
    assert.match(implementation, /noraLedgerRecoveryTarget = chatSaveTarget/);
    assert.match(source, /doNewChat[\s\S]*?waitUntilCondition\(\(\) => !isChatPersistenceBusy\(\)/);
    assert.match(source, /closeCurrentChat[\s\S]*?waitUntilCondition\(\(\) => !isChatPersistenceBusy\(\)/);
});
