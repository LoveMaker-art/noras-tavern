function requestHeaders(getHeaders, { multipart = false } = {}) {
    const source = getHeaders();
    if (!source || typeof source !== 'object') throw new Error('Nora World Core request headers are unavailable.');
    const headers = { ...source };
    if (multipart) {
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === 'content-type') delete headers[key];
        }
    }
    return headers;
}

function decodePayload(response, payload) {
    if (response.ok) return payload;
    const error = new Error(payload?.detail || payload?.error?.message || payload?.error || `Nora World Core request failed (${response.status}).`);
    error.code = payload?.error?.code || payload?.error || 'NORA_WORLD_HTTP_ERROR';
    error.retryable = Boolean(payload?.error?.retryable);
    error.operationId = payload?.error?.operation_id || null;
    error.worldId = payload?.error?.world_id || null;
    throw error;
}

async function decodeResponse(response) {
    const payload = await response.json().catch(() => null);
    return decodePayload(response, payload);
}

async function decodeMeasuredSnapshotResponse(response, measure) {
    const body = await measure('world.snapshot.body-download', () => response.text());
    const payload = await measure('world.snapshot.json-parse', async () => {
        try {
            return JSON.parse(body);
        } catch {
            return null;
        }
    });
    return decodePayload(response, payload);
}

async function passthroughMeasure(_name, operation) {
    return operation();
}

function normalizeChatId(value) {
    return String(value || '').replace(/\.jsonl$/i, '');
}

const PENDING_CREATION_KEY = 'nora.world-core-v2.pending-import';

async function operationIdForKey(key) {
    const bytes = new TextEncoder().encode(String(key));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    return `operation:${hex.slice(0, 32)}`;
}

export function validateActivationPlan(plan) {
    if (plan?.schema !== 'nora-world-activation/v1') throw new Error('Unsupported World Activation Plan.');
    const avatar = String(plan.runtime_card?.binding?.avatar || '').trim();
    const sessionAvatar = String(plan.session?.binding?.avatar || '').trim();
    const chatId = normalizeChatId(plan.session?.binding?.chat_id);
    if (!plan.world_id || !avatar || !chatId || sessionAvatar !== avatar) {
        throw new Error('World Activation Plan has inconsistent Runtime Card or Story Session bindings.');
    }
    if (plan.runtime_card.engine !== 'sillytavern' || plan.session.engine !== 'sillytavern') {
        throw new Error('World Activation Plan targets an unsupported compatibility engine.');
    }
    return { avatar, chatId };
}

export function validateActivationSnapshot(snapshot) {
    if (snapshot?.schema !== 'nora-world-snapshot/v1' || !snapshot.revision) {
        throw new Error('Unsupported World Activation Snapshot.');
    }
    const bindings = validateActivationPlan(snapshot.plan);
    if (snapshot.character?.avatar !== bindings.avatar || !snapshot.chat || !Array.isArray(snapshot.chat.messages)) {
        throw new Error('World Activation Snapshot has inconsistent Runtime Card or Story Session data.');
    }
    if (!Array.isArray(snapshot.worldbooks)) {
        throw new Error('World Activation Snapshot has invalid Knowledge Resources.');
    }
    return bindings;
}

export async function executeStActivationSnapshot(snapshot, runtime, { measure = passthroughMeasure } = {}) {
    const { avatar, chatId } = validateActivationSnapshot(snapshot);
    let state = runtime.read();
    const hydratedCharacterId = typeof runtime.ensureCharacter === 'function'
        ? runtime.ensureCharacter(snapshot.character)
        : null;
    const characterId = Number.isInteger(hydratedCharacterId)
        ? hydratedCharacterId
        : state.characters.findIndex(character => character.avatar === avatar);
    if (characterId < 0) throw new Error(`World Runtime Card is unavailable: ${avatar}`);
    if (typeof runtime.activateSnapshot !== 'function') {
        throw new Error('The compatibility runtime does not support aggregate World activation.');
    }
    await measure('world.snapshot.runtime-transaction', () => runtime.activateSnapshot(characterId, snapshot));
    state = runtime.read();
    if (state.activeCharacter?.avatar !== avatar || normalizeChatId(state.chatId) !== chatId) {
        throw new Error('The compatibility runtime did not activate the requested World snapshot.');
    }
    const activeWorldId = String(state.metadata?.nora_world?.id || '').trim();
    const activeSessionId = String(state.metadata?.nora_session?.id || '').trim();
    if (activeWorldId !== snapshot.plan.world_id || activeSessionId !== snapshot.plan.session.session_id) {
        throw new Error('The active chat does not belong to the requested World and Story Session.');
    }
    await measure('world.snapshot.persona', () => runtime.savePersona(snapshot.plan.persona));
    return Object.freeze({
        id: snapshot.plan.world_id,
        name: snapshot.plan.name,
        persona: { ...snapshot.plan.persona },
        persistent: true,
        active: true,
        character: state.characters[characterId],
        characterId,
        characterAvatar: avatar,
        chatId,
        chatName: chatId,
        activationSnapshot: snapshot,
    });
}

export function createWorldCoreClient(getHeaders, {
    fetchImpl = globalThis.fetch,
    pollIntervalMs = 150,
    pollMaxIntervalMs = 1000,
    operationTimeoutMs = 120_000,
    requestTimeoutMs = 30_000,
    transportRetries = 1,
    pendingStore = globalThis.sessionStorage,
    pendingRecoveryMs = 3000,
    clock = Date.now,
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
    measure = (name, operation) => globalThis.__NORA_TIMED_STEP__
        ? globalThis.__NORA_TIMED_STEP__(name, operation)
        : operation(),
} = {}) {
    const snapshotCache = new Map();
    const snapshotRequests = new Map();
    function readPending() {
        try {
            return JSON.parse(pendingStore?.getItem(PENDING_CREATION_KEY) || 'null');
        } catch {
            return null;
        }
    }

    function writePending(value) {
        if (!pendingStore) return;
        if (value) pendingStore.setItem(PENDING_CREATION_KEY, JSON.stringify(value));
        else pendingStore.removeItem(PENDING_CREATION_KEY);
    }

    function timeoutError(operationId) {
        const error = new Error(operationId
            ? 'World operation did not complete in time. It can be resumed without importing again.'
            : 'World request timed out. Please retry; a submitted operation may still be running.');
        error.code = operationId ? 'NORA_OPERATION_TIMEOUT' : 'NORA_REQUEST_TIMEOUT';
        error.retryable = true;
        error.operationId = operationId || null;
        return error;
    }

    async function withDeadline(run, { timeoutMs = requestTimeoutMs, operationId } = {}) {
        const controller = new AbortController();
        let timer;
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => {
                const error = timeoutError(operationId);
                controller.abort(error);
                reject(error);
            }, Math.max(1, timeoutMs));
        });
        try {
            // Abort real transport AND release callers of non-cooperative adapters.
            // The lifetime includes response-body consumption, not just headers.
            return await Promise.race([Promise.resolve().then(() => run(controller.signal)), deadline]);
        } finally {
            clearTimeout(timer);
        }
    }

    async function request(path, options = {}, deadline = {}) {
        return withDeadline(async signal => decodeResponse(await fetchImpl(`/api/nora-worlds-v2${path}`, {
            cache: 'no-cache',
            credentials: 'same-origin',
            ...options,
            signal,
        })), deadline);
    }

    async function downloadSnapshot(normalizedWorldId) {
        const cached = snapshotCache.get(normalizedWorldId) || null;
        const headers = requestHeaders(getHeaders);
        if (cached?.etag) headers['If-None-Match'] = cached.etag;
        const downloaded = await withDeadline(async signal => {
            const response = await measure('world.snapshot.network', () => fetchImpl(
                `/api/nora-worlds-v2/worlds/${encodeURIComponent(normalizedWorldId)}/snapshot`,
                { cache: 'no-cache', credentials: 'same-origin', headers, signal },
            ));
            return { response, payload: response.status === 304 ? null : await decodeMeasuredSnapshotResponse(response, measure) };
        });
        const { response, payload } = downloaded;
        if (response.status === 304) {
            if (!cached?.snapshot) throw new Error('World snapshot cache was revalidated without a cached value.');
            return cached.snapshot;
        }
        const snapshot = payload?.snapshot;
        await measure('world.snapshot.validate', async () => {
            validateActivationSnapshot(snapshot);
            if (snapshot.plan.world_id !== normalizedWorldId) throw new Error('World snapshot response is inconsistent.');
        });
        const etag = response.headers.get('etag') || (snapshot.revision ? `"${snapshot.revision}"` : '');
        snapshotCache.set(normalizedWorldId, { etag, snapshot });
        return snapshot;
    }

    function prepareSnapshot(worldId) {
        const normalizedWorldId = String(worldId || '').trim();
        if (!normalizedWorldId) return Promise.reject(new Error('World identity is required for activation.'));
        const activeRequest = snapshotRequests.get(normalizedWorldId);
        if (activeRequest) return activeRequest;

        const request = downloadSnapshot(normalizedWorldId).finally(() => {
            if (snapshotRequests.get(normalizedWorldId) === request) snapshotRequests.delete(normalizedWorldId);
        });
        snapshotRequests.set(normalizedWorldId, request);
        return request;
    }

    async function operation(operationId, timeoutMs = requestTimeoutMs) {
        return request(`/operations/${encodeURIComponent(operationId)}`, {
            headers: requestHeaders(getHeaders),
        }, { timeoutMs, operationId });
    }

    async function waitForOperation(operationId) {
        const startedAt = clock();
        let nextPollMs = Math.max(0, pollIntervalMs);
        for (;;) {
            const remainingMs = operationTimeoutMs - (clock() - startedAt);
            if (remainingMs <= 0) throw timeoutError(operationId);
            const current = await operation(operationId, Math.min(requestTimeoutMs, remainingMs));
            if (clock() - startedAt >= operationTimeoutMs) throw timeoutError(operationId);
            if (current.operation?.status === 'COMPLETED') return current;
            if (current.operation?.status === 'FAILED') {
                const error = new Error(current.operation.error?.message || 'World creation failed.');
                error.code = current.operation.error?.code || 'NORA_WORLD_CREATE_FAILED';
                error.retryable = Boolean(current.operation.error?.retryable);
                throw error;
            }
            await delay(Math.min(nextPollMs, operationTimeoutMs - (clock() - startedAt)));
            nextPollMs = Math.min(Math.max(nextPollMs * 2, pollIntervalMs), pollMaxIntervalMs);
        }
    }

    async function submitCreation({ idempotencyKey, kind, path, headers, body }) {
        const normalizedKey = String(idempotencyKey || '').trim();
        if (!normalizedKey) throw new Error('A World creation idempotency key is required.');
        const startedAt = clock();
        writePending({ idempotencyKey: normalizedKey, operationId: null, startedAt, kind });
        let submitted;
        for (let attempt = 0; attempt <= transportRetries; attempt += 1) {
            try {
                submitted = await request(path, { method: 'POST', headers, body });
                break;
            } catch (error) {
                if (attempt >= transportRetries || !(error instanceof TypeError)) throw error;
            }
        }
        writePending({ idempotencyKey: normalizedKey, operationId: submitted.operation.operation_id, startedAt, kind });
        if (submitted.world && submitted.operation?.status === 'COMPLETED') {
            writePending(null);
            return submitted;
        }
        const completed = await waitForOperation(submitted.operation.operation_id);
        writePending(null);
        return completed;
    }

    async function importCard(file, { idempotencyKey, persona = {}, name = '' } = {}) {
        const body = new FormData();
        body.append('avatar', file);
        body.append('idempotency_key', String(idempotencyKey || '').trim());
        body.append('persona_name', String(persona.name || ''));
        body.append('persona_description', String(persona.description || ''));
        if (name) body.append('name', String(name));
        return submitCreation({
            idempotencyKey,
            kind: 'import',
            path: '/imports',
            headers: requestHeaders(getHeaders, { multipart: true }),
            body,
        });
    }

    async function createFromLibrary({ avatar, idempotencyKey } = {}) {
        return submitCreation({ idempotencyKey, kind: 'library', path: '/library-imports',
            headers: requestHeaders(getHeaders),
            body: JSON.stringify({ avatar, idempotency_key: String(idempotencyKey || '').trim() }),
        });
    }

    async function createBlank({ idempotencyKey, persona = {}, name } = {}) {
        return submitCreation({
            idempotencyKey,
            kind: 'blank',
            path: '/worlds',
            headers: requestHeaders(getHeaders),
            body: JSON.stringify({
                idempotency_key: String(idempotencyKey || '').trim(),
                name: String(name || '').trim(),
                persona_name: String(persona.name || ''),
                persona_description: String(persona.description || ''),
            }),
        });
    }

    async function resumePendingCreation() {
        const pending = readPending();
        if (!pending?.idempotencyKey) return null;
        const operationId = pending.operationId || await operationIdForKey(pending.idempotencyKey);
        writePending({ ...pending, operationId });
        for (;;) {
            try {
                const current = await operation(operationId);
                if (current.operation?.status === 'FAILED') {
                    const error = new Error(current.operation.error?.message || 'World creation failed.');
                    error.code = current.operation.error?.code || 'NORA_WORLD_CREATE_FAILED';
                    error.retryable = Boolean(current.operation.error?.retryable);
                    throw error;
                }
                const result = current.operation?.status === 'COMPLETED' ? current : await waitForOperation(operationId);
                writePending(null);
                return result;
            } catch (error) {
                const age = clock() - Number(pending.startedAt || 0);
                if (error?.code === 'NORA_OPERATION_NOT_FOUND' && age < pendingRecoveryMs) {
                    await delay(pollIntervalMs);
                    continue;
                }
                if (error?.code === 'NORA_OPERATION_NOT_FOUND') writePending(null);
                throw error;
            }
        }
    }

    async function retryPendingCreation() {
        const pending = readPending();
        if (!pending?.idempotencyKey) throw new Error('There is no pending World creation to retry.');
        const operationId = pending.operationId || await operationIdForKey(pending.idempotencyKey);
        writePending({ ...pending, operationId });
        const retried = await request(`/operations/${encodeURIComponent(operationId)}/retry`, {
            method: 'POST',
            headers: requestHeaders(getHeaders),
        });
        const result = retried.operation?.status === 'COMPLETED'
            ? retried
            : await waitForOperation(operationId);
        writePending(null);
        return result;
    }

    async function beginCapabilityAttempt(worldId, capability) {
        return request(`/worlds/${encodeURIComponent(worldId)}/capabilities/${encodeURIComponent(capability)}/attempts`, {
            method: 'POST',
            headers: requestHeaders(getHeaders),
        });
    }

    async function settleCapabilityAttempt(worldId, capability, attemptId, result) {
        return request(`/worlds/${encodeURIComponent(worldId)}/capabilities/${encodeURIComponent(capability)}/attempts/${encodeURIComponent(attemptId)}`, {
            method: 'PUT',
            headers: requestHeaders(getHeaders),
            body: JSON.stringify(result),
        });
    }

    async function mutateWorld(worldId, idempotencyKey, { method, suffix = '' }) {
        const normalizedWorldId = String(worldId || '').trim();
        const normalizedKey = String(idempotencyKey || '').trim();
        if (!normalizedWorldId || !normalizedKey) throw new Error('World identity and mutation idempotency key are required.');
        return request(`/worlds/${encodeURIComponent(normalizedWorldId)}${suffix}`, {
            method,
            headers: requestHeaders(getHeaders),
            body: JSON.stringify({ idempotency_key: normalizedKey }),
        });
    }

    return Object.freeze({
        status: () => request('/status', { headers: requestHeaders(getHeaders) }),
        list: async () => (await request('/worlds', { headers: requestHeaders(getHeaders) })).worlds || [],
        importCard,
        createBlank,
        createFromLibrary,
        updateWorld: async (worldId, patch, expectedRevision) => (await request(`/worlds/${encodeURIComponent(worldId)}`, {
            method: 'PATCH', headers: requestHeaders(getHeaders),
            body: JSON.stringify({ patch, expected_revision: expectedRevision }),
        })).world,
        getOperation: operation,
        retryOperation: operationId => request(`/operations/${encodeURIComponent(operationId)}/retry`, {
            method: 'POST',
            headers: requestHeaders(getHeaders),
        }),
        prepareOpen: async worldId => (await request(`/worlds/${encodeURIComponent(worldId)}/open-plan`, {
            headers: requestHeaders(getHeaders),
        })).plan,
        prepareSnapshot,
        waitForOperation,
        pendingCreation: () => readPending(),
        resumePendingCreation,
        retryPendingCreation,
        deleteWorld: (worldId, { idempotencyKey } = {}) => mutateWorld(worldId, idempotencyKey, { method: 'DELETE' }),
        repairWorld: (worldId, { idempotencyKey } = {}) => mutateWorld(worldId, idempotencyKey, { method: 'POST', suffix: '/repair' }),
        beginCapabilityAttempt,
        settleCapabilityAttempt,
    });
}
