import { composeNoraWorldCore } from './service.js';

export { NoraWorldCoreError } from './errors.js';

export function createNoraWorldCore(options) {
    const core = composeNoraWorldCore(options);
    return Object.freeze({
        listLibraryCards: core.listLibraryCards.bind(core),
        saveLibraryCard: core.saveLibraryCard.bind(core),
        readLibraryCardSource: core.readLibraryCardSource.bind(core),
        listLibraryProfiles: core.listLibraryProfiles.bind(core),
        readLibraryProfile: core.readLibraryProfile.bind(core),
        saveLibraryProfile: core.saveLibraryProfile.bind(core),
        deleteLibraryProfile: core.deleteLibraryProfile.bind(core),
        listLibraryWorldbooks: core.listLibraryWorldbooks.bind(core),
        readLibraryWorldbook: core.readLibraryWorldbook.bind(core),
        saveLibraryWorldbook: core.saveLibraryWorldbook.bind(core),
        importLibraryItem: core.importLibraryItem.bind(core),
        editWorldbookEntry: core.editWorldbookEntry.bind(core),
        addWorldSetting: core.addWorldSetting.bind(core),
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
