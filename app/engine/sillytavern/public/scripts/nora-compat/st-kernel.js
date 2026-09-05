let kernelPromise;

function recordMilestone(name) {
    const metrics = globalThis.__NORA_BOOT_METRICS__;
    if (!metrics) return;
    metrics.milestones ??= [];
    metrics.milestones.push({
        name,
        at: Math.round((performance.now() - metrics.startedAt) * 10) / 10,
    });
}

function createAppReadyPromise(getContext) {
    const context = getContext();
    if (document.body.classList.contains('nora-runtime-ready')) {
        return Promise.resolve(context);
    }
    return new Promise((resolve) => {
        context.eventSource.once(context.eventTypes.APP_READY, () => resolve(getContext()));
    });
}

async function loadKernel() {
    recordMilestone('st-compat-import-start');
    const importResource = globalThis.__NORA_TRACK_BOOT_RESOURCE__?.('st-kernel-module', '/script.js') || {
        complete() {},
        fail() {},
    };
    try {
        const loadModule = globalThis.__NORA_LOAD_MODULE__;
        if (typeof loadModule !== 'function') {
            throw new Error('Nora module loader is unavailable.');
        }
        await loadModule('/script.js');
        importResource.complete();
    } catch (error) {
        importResource.fail(error);
        recordMilestone('st-compat-import-failed');
        globalThis.__NORA_REPORT_EARLY_BOOT_METRICS__?.('boot-runtime-error', {
            stageName: 'st-compat-import',
            message: String(error?.message || error).slice(0, 200),
        });
        throw error;
    }

    const st = globalThis.SillyTavern;
    if (typeof st?.getContext !== 'function') {
        throw new Error('故事运行核心未提供 getContext() 接口。');
    }

    const getContext = () => {
        const context = st.getContext();
        if (!context?.eventSource || !context?.eventTypes) {
            throw new Error('故事运行核心缺少生命周期接口。');
        }
        return context;
    };
    const whenAppReady = createAppReadyPromise(getContext);
    recordMilestone('st-compat-import-end');

    return Object.freeze({ getContext, whenAppReady });
}

export function loadStCompatibilityKernel() {
    return kernelPromise ??= loadKernel();
}
