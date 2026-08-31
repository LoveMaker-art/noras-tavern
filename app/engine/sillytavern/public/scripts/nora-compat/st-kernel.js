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
    await import(/* webpackIgnore: true */ '/script.js');

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
