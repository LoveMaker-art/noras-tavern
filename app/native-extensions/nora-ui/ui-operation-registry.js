export function createUiOperationRegistry() {
    const active = new Map();

    function isBusy(scope) {
        return active.has(String(scope));
    }

    function run(scope, operation) {
        const key = String(scope || 'default');
        const existing = active.get(key);
        if (existing) return existing;
        if (typeof operation !== 'function') throw new TypeError('UI operation must be a function.');

        let tracked;
        tracked = Promise.resolve()
            .then(operation)
            .finally(() => {
                if (active.get(key) === tracked) active.delete(key);
            });
        active.set(key, tracked);
        return tracked;
    }

    return Object.freeze({ run, isBusy });
}
