import { composeNoraWorldCore } from './service.js';

export { NoraWorldCoreError } from './errors.js';

export function createNoraWorldCore(options) {
    const core = composeNoraWorldCore(options);
    return Object.freeze({
        submitWorld: core.submitWorld.bind(core),
        createWorld: core.createWorld.bind(core),
        retryOperation: core.retryOperation.bind(core),
        getOperation: core.getOperation.bind(core),
        getWorld: core.getWorld.bind(core),
        listWorlds: core.listWorlds.bind(core),
        setWorldTheme: core.setWorldTheme.bind(core),
        updateWorld: core.updateWorld.bind(core),
        prepareOpen: core.prepareOpen.bind(core),
        deleteWorld: core.deleteWorld.bind(core),
        repairWorld: core.repairWorld.bind(core),
        beginCapabilityAttempt: core.beginCapabilityAttempt.bind(core),
        settleCapabilityAttempt: core.settleCapabilityAttempt.bind(core),
        inspectWorld: core.inspectWorld.bind(core),
    });
}
