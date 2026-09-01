/** Own Nora's viewport-sized CSS variables. */
export function createViewportController({
    windowRef = window,
    root = document.documentElement,
    scheduleFrame = callback => windowRef.requestAnimationFrame(callback),
    ResizeObserverImpl = globalThis.ResizeObserver,
} = {}) {
    let observer;
    let mounted = false;
    let scheduled = false;
    let visualViewport;

    const update = () => {
        scheduled = false;
        const visualHeight = Number(visualViewport?.height);
        const layoutHeight = Number(windowRef.innerHeight);
        const height = Number.isFinite(visualHeight) && visualHeight > 0 ? visualHeight : layoutHeight;
        const visualTop = Number(visualViewport?.offsetTop);
        const top = Number.isFinite(visualTop) && visualTop > 0 ? visualTop : 0;
        root.style.setProperty('--nora-vh', `${Math.max(1, Math.round(height))}px`);
        root.style.setProperty('--nora-vv-top', `${Math.max(0, Math.round(top))}px`);
    };
    const scheduleUpdate = () => {
        if (scheduled) return;
        scheduled = true;
        scheduleFrame(update);
    };

    function mount() {
        if (mounted) return;
        mounted = true;
        visualViewport = windowRef.visualViewport;
        windowRef.addEventListener('resize', scheduleUpdate);
        windowRef.addEventListener('orientationchange', scheduleUpdate);
        visualViewport?.addEventListener('resize', scheduleUpdate);
        visualViewport?.addEventListener('scroll', scheduleUpdate);
        if (typeof ResizeObserverImpl === 'function') {
            observer = new ResizeObserverImpl(scheduleUpdate);
            observer.observe(root);
        }
        update();
    }

    function dispose() {
        if (!mounted) return;
        mounted = false;
        windowRef.removeEventListener('resize', scheduleUpdate);
        windowRef.removeEventListener('orientationchange', scheduleUpdate);
        visualViewport?.removeEventListener('resize', scheduleUpdate);
        visualViewport?.removeEventListener('scroll', scheduleUpdate);
        observer?.disconnect();
        observer = undefined;
        visualViewport = undefined;
    }

    return Object.freeze({ mount, dispose });
}
