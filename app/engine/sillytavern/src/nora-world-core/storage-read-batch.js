/** Drain each small read batch before returning or reporting a failure. */
export async function mapStorageReads(items, read) {
    const values = [];
    for (let offset = 0; offset < items.length; offset += 4) {
        const results = await Promise.allSettled(items.slice(offset, offset + 4).map(read));
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        values.push(...results.map(result => result.value));
    }
    return values;
}
