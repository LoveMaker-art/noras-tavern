export function createStoryScroller({
    getContainer,
    scheduleFrame = callback => requestAnimationFrame(callback),
    observeResize = (element, callback) => {
        if (!element || typeof ResizeObserver !== 'function') return () => {};
        const observer = new ResizeObserver(callback);
        observer.observe(element);
        return () => observer.disconnect();
    },
    observeMutations = (element, callback) => {
        if (!element || typeof MutationObserver !== 'function') return () => {};
        const observer = new MutationObserver(callback);
        observer.observe(element, { attributes: true, characterData: true, childList: true, subtree: true });
        return () => observer.disconnect();
    },
    observeUserIntent = (element, callback) => {
        if (!element?.addEventListener) return () => {};
        let touchY = null;
        const onWheel = event => {
            if (Number(event.deltaY) < 0) callback();
        };
        const onTouchStart = event => {
            touchY = Number(event.touches?.[0]?.clientY);
        };
        const onTouchMove = event => {
            const nextY = Number(event.touches?.[0]?.clientY);
            if (Number.isFinite(touchY) && Number.isFinite(nextY) && nextY > touchY + 4) callback();
            touchY = nextY;
        };
        const onKeydown = event => {
            if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) callback();
        };
        const keyboardTarget = globalThis.document?.addEventListener ? globalThis.document : element;
        element.addEventListener('wheel', onWheel, { passive: true });
        element.addEventListener('touchstart', onTouchStart, { passive: true });
        element.addEventListener('touchmove', onTouchMove, { passive: true });
        keyboardTarget.addEventListener('keydown', onKeydown);
        return () => {
            element.removeEventListener('wheel', onWheel);
            element.removeEventListener('touchstart', onTouchStart);
            element.removeEventListener('touchmove', onTouchMove);
            keyboardTarget.removeEventListener('keydown', onKeydown);
        };
    },
    settleFrames = 3,
} = {}) {
    if (typeof getContainer !== 'function') throw new TypeError('Story scroller requires a container provider.');
    let releasePreviousFollow = () => {};

    const nextFrame = () => new Promise(resolve => scheduleFrame(resolve));
    const scrollLatest = () => {
        const container = getContainer();
        if (container) container.scrollTop = container.scrollHeight;
    };

    async function toLatest() {
        for (let frame = 0; frame < settleFrames; frame += 1) {
            scrollLatest();
            await nextFrame();
        }
        scrollLatest();
    }

    function followLatest() {
        releasePreviousFollow();
        let frameActive = true;
        let observersActive = true;
        let releaseFrames = null;
        let releasePromise;
        let resolveRelease;
        const container = getContainer();
        const stopObserving = observeResize(container?.firstElementChild || container, () => {
            if (observersActive) scrollLatest();
        });
        const stopWatchingMutations = observeMutations(container?.firstElementChild || container, () => {
            if (observersActive) scrollLatest();
        });
        let stopWatchingUserIntent = () => {};
        const releaseObservers = () => {
            if (!observersActive) return;
            observersActive = false;
            stopObserving();
            stopWatchingMutations();
            stopWatchingUserIntent();
            if (releasePreviousFollow === releaseAll) releasePreviousFollow = () => {};
        };
        const releaseAll = () => {
            frameActive = false;
            releaseObservers();
            resolveRelease?.();
        };
        releasePreviousFollow = releaseAll;
        stopWatchingUserIntent = observeUserIntent(container, releaseAll);
        const follow = () => {
            if (!frameActive) return;
            scrollLatest();
            if (releaseFrames !== null) {
                releaseFrames -= 1;
                if (releaseFrames <= 0) {
                    frameActive = false;
                    resolveRelease();
                    return;
                }
            }
            scheduleFrame(follow);
        };
        follow();
        return () => {
            if (releasePromise) return releasePromise;
            if (!frameActive) return Promise.resolve();
            releaseFrames = Math.max(1, settleFrames);
            releasePromise = new Promise(resolve => { resolveRelease = resolve; });
            return releasePromise;
        };
    }

    return Object.freeze({ followLatest, toLatest });
}
