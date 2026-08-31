import { projectWorldTheme } from '../../engine/sillytavern/public/scripts/nora-worlds/world-theme.js';

// Style existing elements only; ownership lets reset/switch restore their previous inline values.
export function createWorldThemeController(select) {
    const owned = new Map();
    let lastKey; let state = { ready: false };
    function render(world) {
        const targets = ['#nora-stage', '#nora-panel'].map(select);
        if (targets.some(target => !target)) { lastKey = undefined; state = { ready: false }; return state; }
        const key = JSON.stringify([world?.id, world?.ui]);
        if (key === lastKey && targets.every(target => owned.has(target))) return state;
        const projected = projectWorldTheme(world?.ui);
        for (const [target, originals] of owned) {
            if (!targets.includes(target)) {
                for (const [name, previous] of originals) restore(target, name, previous);
                target.removeAttribute('data-world-reading-surface'); owned.delete(target);
            }
        }
        for (const target of targets) {
            const originals = owned.get(target) || new Map(); owned.set(target, originals);
            for (const [name, previous] of originals) if (!(name in projected.properties)) { restore(target, name, previous); originals.delete(name); }
            for (const [name, value] of Object.entries(projected.properties)) {
                if (!originals.has(name)) originals.set(name, [target.style.getPropertyValue(name), target.style.getPropertyPriority(name)]);
                target.style.setProperty(name, value);
            }
            if (projected.readingSurface === 'plain') target.removeAttribute('data-world-reading-surface');
            else target.setAttribute('data-world-reading-surface', projected.readingSurface);
        }
        lastKey = key;
        state = { ready: true, worldId: world?.id || '', applied: true, visualVerified: false };
        return state;
    }
    function restore(target, name, previous) {
        if (previous[0]) target.style.setProperty(name, previous[0], previous[1]);
        else target.style.removeProperty(name);
    }
    return Object.freeze({ render, inspect: () => ({ ...state }) });
}
