/** Own Nora's viewport-sized CSS variables. */
export function createViewportController({
    windowRef = window,
    documentRef = document,
    root = document.documentElement,
    scheduleFrame = callback => windowRef.requestAnimationFrame(callback),
    ResizeObserverImpl = globalThis.ResizeObserver,
} = {}) {
    let observer;
    let mounted = false;
    let scheduled = false;
    let visualViewport;

    const isEditableElement = element => {
        if (!element) return false;
        if (element.isContentEditable === true) return true;
        const tagName = String(element.tagName || '').toLowerCase();
        if (tagName === 'textarea') return true;
        if (tagName !== 'input') return false;
        const inputType = String(element.type || 'text').toLowerCase();
        return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(inputType);
    };

    const update = () => {
        scheduled = false;
        const visualHeight = Number(visualViewport?.height);
        const layoutHeight = Number(windowRef.innerHeight);
        const hasVisualHeight = Number.isFinite(visualHeight) && visualHeight > 0;
        const hasLayoutHeight = Number.isFinite(layoutHeight) && layoutHeight > 0;
        const keyboardViewportActive = hasVisualHeight
            && hasLayoutHeight
            && visualHeight < layoutHeight
            && isEditableElement(documentRef.activeElement);
        const height = keyboardViewportActive
            ? visualHeight
            : (hasLayoutHeight ? layoutHeight : visualHeight);
        const visualTop = Number(visualViewport?.offsetTop);
        const top = keyboardViewportActive && Number.isFinite(visualTop) && visualTop > 0 ? visualTop : 0;
        root.style.setProperty('--nora-vh', `${Math.max(1, Math.round(height || 1))}px`);
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
        const disposeEarlyViewport = windowRef.__NORA_DISPOSE_EARLY_VIEWPORT__;
        if (typeof disposeEarlyViewport === 'function') disposeEarlyViewport();
        delete windowRef.__NORA_DISPOSE_EARLY_VIEWPORT__;
        visualViewport = windowRef.visualViewport;
        windowRef.addEventListener('resize', scheduleUpdate);
        windowRef.addEventListener('orientationchange', scheduleUpdate);
        visualViewport?.addEventListener('resize', scheduleUpdate);
        visualViewport?.addEventListener('scroll', scheduleUpdate);
        documentRef.addEventListener('focusin', scheduleUpdate);
        documentRef.addEventListener('focusout', scheduleUpdate);
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
        documentRef.removeEventListener('focusin', scheduleUpdate);
        documentRef.removeEventListener('focusout', scheduleUpdate);
        observer?.disconnect();
        observer = undefined;
        visualViewport = undefined;
    }

    return Object.freeze({ mount, dispose });
}
