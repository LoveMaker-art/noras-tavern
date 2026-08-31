import { connectLedger, refreshLedger, requestLedger } from '../../engine/sillytavern/public/scripts/nora-story-ledger/client.js';

export function startStoryLedgerPlugin(getContext) {
    connectLedger(getContext);
// Headless configuration interface for an agent. No plugin-management UI.
globalThis.NoraStoryLedger = Object.freeze({
    status: () => requestLedger('status'),
    configure: options => requestLedger('configure', options).then(async result => { await refreshLedger(); return result; }),
    compress: () => requestLedger('compress').then(async result => { await refreshLedger(); return result; }),
});
}
