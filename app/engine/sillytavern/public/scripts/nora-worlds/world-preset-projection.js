// One active projection, not a second store of World presets.
export function createWorldPresetProjection() {
    let active = null;
    return {
        bind(worldId, apply) { active = { worldId, apply }; },
        clear() { active = null; },
        restore(worldId) {
            if (!worldId) return;
            if (active?.worldId !== worldId) throw new Error('当前世界的预设尚未就绪，请重新打开世界。');
            active.apply();
        },
    };
}

// The product bundle and native import-map modules must use the same projection.
export const worldPresetProjection = globalThis[Symbol.for('tavern.world-preset-projection')] ??= createWorldPresetProjection();
