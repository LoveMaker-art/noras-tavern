// This describes scoped configuration, not whether a process is installed or
// still present in memory. Counting enabled scripts is not proof of execution.
export function scriptUsage(group) {
    let total = 0, enabled = 0;
    function visit(items, parentEnabled) {
        for (const item of items || []) {
            if (item.id === 'nora-mvu-headless-runtime') continue;
            const active = parentEnabled && item.enabled !== false;
            if (item.type === 'folder') visit(item.scripts, active);
            else { total++; if (active) enabled++; }
        }
    }
    visit(group.trees, group.enabled === true);
    return { total, enabled };
}

export function regexUsage(groups) {
    return groups.reduce((result, group) => {
        result.total += group.scripts.length;
        if (group.allowed === true) result.enabled += group.scripts.filter(rule => !rule.disabled).length;
        return result;
    }, { total: 0, enabled: 0 });
}
