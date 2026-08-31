import { installOptionalUiResources } from '../nora-compat/optional-ui-resources.js';
import { createNoraStoryCore } from '../nora-story-core/index.js';
import { loadStCompatibilityKernel } from '../nora-compat/st-kernel.js';
import { startStoryLedgerPlugin } from '../../../../../native-extensions/nora-ledger/index.js';
import { createRuntimeControls } from '../nora-controls/runtime.js';
import { startControlClient } from '../nora-controls/client.js';
import '../../../../../native-extensions/nora-ui/index.js';

const RELEASE_VERSION = '2.17.4';

let startupPromise;

function recordMilestone(name, details = {}) {
    const metrics = globalThis.__NORA_BOOT_METRICS__;
    if (!metrics) return;
    metrics.milestones ??= [];
    metrics.milestones.push({
        name,
        at: Math.round((performance.now() - metrics.startedAt) * 10) / 10,
        ...details,
    });
}

async function loadNoraUi() {
    const ui = globalThis.NoraUI;
    if (typeof ui?.prepareShell !== 'function' || typeof ui?.mount !== 'function') {
        throw new Error('Nora UI did not expose the Stage 4 mount interface.');
    }
    return ui;
}

async function start() {
    recordMilestone('nora-runtime-start');
    globalThis.__NORA_ENTRY_ACTIVE__ = true;
    installOptionalUiResources();

    const ui = await loadNoraUi();
    ui.prepareShell();
    recordMilestone('nora-ui-interface-ready');

    const story = await createNoraStoryCore();
    startStoryLedgerPlugin((await loadStCompatibilityKernel()).getContext);
    const runtime = Object.freeze({
        version: RELEASE_VERSION,
        story,
        whenAppReady: story.state.whenReady,
    });

    globalThis.NoraRuntime = runtime;
    ui.mount({ story });
    // Not part of the entry critical path. No world selection, model request or auto-reload.
    void story.state.whenReady().then(async () => {
        const kernel = await loadStCompatibilityKernel();
        const controls = createRuntimeControls({ getContext: kernel.getContext, story, dispatch: () => ui.controlActions() });
        startControlClient({ controls, headers: story.transport.requestHeaders });
    }).catch(error => console.warn('[Nora Controls] Runtime control connection unavailable', error));
    document.documentElement.dataset.noraRuntimeVersion = RELEASE_VERSION;
    recordMilestone('nora-runtime-interface-ready');
    return runtime;
}

export function startNoraRuntime() {
    return startupPromise ??= start();
}
