/** Exact token requests shared by prompt prefetch and individual async callers. */
export function createTokenCountBatcher({ request, schedule = queueMicrotask, maxBatchSize = 128 }) {
    const inflight = new Map();
    const queues = new Map();
    async function flush(model) {
        const entries = queues.get(model) || [];
        queues.delete(model);
        for (let offset = 0; offset < entries.length; offset += maxBatchSize) {
            const batch = entries.slice(offset, offset + maxBatchSize);
            try {
                const counts = await request(model, batch.map(item => item.message));
                if (!Array.isArray(counts) || counts.length !== batch.length
                    || counts.some(count => typeof count !== 'number' || !Number.isFinite(count) || count < 0)) {
                    throw new Error('The batched tokenizer returned invalid counts.');
                }
                batch.forEach((item, index) => item.resolve(counts[index]));
            } catch (error) {
                batch.forEach(item => item.reject(error));
            } finally {
                batch.forEach(item => inflight.delete(item.key));
            }
        }
    }
    function count(model, message) {
        const serialized = JSON.stringify(message);
        const key = JSON.stringify([model, serialized]);
        if (inflight.has(key)) return inflight.get(key);
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        inflight.set(key, promise);
        if (!queues.has(model)) {
            queues.set(model, []);
            schedule(() => { void flush(model); });
        }
        queues.get(model).push({ key, message: JSON.parse(serialized), resolve, reject });
        return promise;
    }
    return Object.freeze({ count });
}
