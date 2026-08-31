// A single non-blocking long poll per page. Commands are never re-executed after a lost acknowledgement.
export function startControlClient({ controls, headers, fetcher = (...args) => fetch(...args),
    clientId = crypto.randomUUID(), reload = () => location.reload(), pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
    let stopped = false; let token = ''; let polling = null;
    const executions = new Map();
    const identity = () => ({ clientId, token, ...controls.scope(), busy: controls.busy() });
    async function request(route, body, signal) {
        const deadline = AbortSignal.timeout(30000);
        const response = await fetcher('/api/nora-controls/' + route, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, deadline]) : deadline, cache: 'no-store' });
        if (!response.ok) throw new Error('Nora control transport unavailable');
        return response.json();
    }
    async function execute(command) {
        let reply;
        try { reply = { status: 'completed', result: await controls.execute(command) }; } catch (error) {
            // Execution may have had side effects before rejecting; never infer safe retry.
            reply = { status: 'unknown', result: { code: error.code || 'NORA_CONTROL_EXECUTION_FAILED', message: 'Control action did not confirm completion; inspect current state before retrying.' } };
        }
        for (let attempt = 0; attempt < 5 && !stopped; attempt++) {
            try {
                await request('ack', { ...identity(), id: command.id, ...reply });
                if (command.action === 'page.reload' && reply.status === 'completed') reload();
                return;
            } catch { await pause(1000); }
        }
    }
    async function loop() {
        while (!stopped) {
            try {
                if (!token) ({ token } = await request('hello', identity()));
                polling = new AbortController();
                const { command } = await request('poll', identity(), polling.signal);
                if (command && !executions.has(command.id)) {
                    // Keep polling while a model operation runs, so stop/read commands still work.
                    // Broker durably marks a command claimed before delivery and never re-delivers it.
                    executions.set(command.id, execute(command).finally(() => executions.delete(command.id)));
                }
            } catch {
                if (!stopped) { token = ''; await pause(3000); }
            }
        }
    }
    void loop();
    return Object.freeze({ clientId, stop() { stopped = true; polling?.abort(); } });
}
