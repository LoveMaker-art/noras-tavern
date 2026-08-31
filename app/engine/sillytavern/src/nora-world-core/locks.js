export class KeyedLock {
    #tails = new Map();

    async run(key, operation) {
        const normalizedKey = String(key || '');
        const previous = this.#tails.get(normalizedKey) || Promise.resolve();
        let release;
        const current = new Promise(resolve => {
            release = resolve;
        });
        const tail = previous.then(() => current);
        this.#tails.set(normalizedKey, tail);

        await previous;
        try {
            return await operation();
        } finally {
            release();
            if (this.#tails.get(normalizedKey) === tail) this.#tails.delete(normalizedKey);
        }
    }
}
