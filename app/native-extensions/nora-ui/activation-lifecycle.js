export function createUiActivationLifecycle({ mount = () => {}, hydrate, finalize, onTransition = () => {} } = {}) {
    if (typeof mount !== 'function' || typeof hydrate !== 'function' || typeof finalize !== 'function') {
        throw new TypeError('UI activation lifecycle requires mount, hydrate, and finalize operations.');
    }

    let currentState = 'idle';
    let mountPromise;
    let hydrationPromise;
    let finalizationPromise;

    function transition(nextState) {
        if (currentState === nextState) return;
        currentState = nextState;
        onTransition(nextState);
    }

    function runMount() {
        if (mountPromise) return mountPromise;

        let attempt;
        attempt = Promise.resolve()
            .then(() => {
                transition('mounting');
                return mount();
            })
            .then((value) => {
                transition('mounted');
                return value;
            })
            .catch((error) => {
                if (mountPromise === attempt) mountPromise = null;
                transition('idle');
                throw error;
            });
        mountPromise = attempt;
        return attempt;
    }

    function runHydration() {
        if (hydrationPromise) return hydrationPromise;

        let attempt;
        attempt = runMount()
            .then(() => {
                transition('hydrating');
                return hydrate();
            })
            .then((value) => {
                transition('hydrated');
                return value;
            })
            .catch((error) => {
                if (hydrationPromise === attempt) hydrationPromise = null;
                transition(mountPromise ? 'mounted' : 'idle');
                throw error;
            });
        hydrationPromise = attempt;
        return attempt;
    }

    function runFinalization() {
        if (finalizationPromise) return finalizationPromise;

        let attempt;
        attempt = runHydration()
            .then(() => {
                transition('finalizing');
                return finalize();
            })
            .then((value) => {
                transition('ready');
                return value;
            })
            .catch((error) => {
                if (finalizationPromise === attempt) finalizationPromise = null;
                if (hydrationPromise) transition('hydrated');
                throw error;
            });
        finalizationPromise = attempt;
        return attempt;
    }

    return Object.freeze({
        mount: runMount,
        hydrate: runHydration,
        finalize: runFinalization,
        state: () => currentState,
    });
}
