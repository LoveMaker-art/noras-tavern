export function worldbookOverrides(knowledge = []) {
    return Object.fromEntries(knowledge.flatMap(resource => {
        const binding = resource.binding || {};
        return [...new Set([binding.original_name, ...(binding.original_names || [])])]
            .filter(name => typeof name === 'string' && name && name !== binding.name)
            .map(name => [name, binding.name]);
    }));
}

export function resolveWorldbookOverride(name, metadata) {
    const overrides = metadata?.nora_world?.id && metadata.nora_world.worldbook_overrides;
    return overrides && Object.hasOwn(overrides, name) ? overrides[name] : name;
}
