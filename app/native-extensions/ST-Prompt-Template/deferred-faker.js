export function createFakerLoader(load = () => import('./libs/faker.mjs')) {
    let pending;
    return function loadFaker() {
        if (!pending) pending = load().catch(error => { pending = null; throw error; });
        return pending;
    };
}

export const loadFaker = createFakerLoader();
