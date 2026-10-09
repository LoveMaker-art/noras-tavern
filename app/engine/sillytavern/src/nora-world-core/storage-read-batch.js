export const STORAGE_READ_BUFFER_BYTES = 1024 * 1024;

/** Bound open readers without stalling the whole pool on one slow file. */
export async function mapStorageReads(items, read) {
    const values = new Array(items.length);
    let cursor = 0, failure;
    const worker = async () => {
        while (!failure && cursor < items.length) {
            const index = cursor++;
            try { values[index] = await read(items[index]); }
            catch (error) { failure ||= { error }; }
        }
    };
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
    if (failure) throw failure.error;
    return values;
}
