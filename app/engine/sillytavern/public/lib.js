import libs from './lib-core.js';
import { toggle as slideToggle } from 'slidetoggle';
import chalk from 'chalk';
import yaml from 'yaml';

const compatibilityLibraries = {
    slideToggle,
    chalk,
    yaml,
};

export function initCompatibilityLibraries(target = globalThis.SillyTavern?.libs ?? libs) {
    Object.assign(target, compatibilityLibraries);
    return target;
}

initCompatibilityLibraries(libs);
if (globalThis.SillyTavern?.libs && globalThis.SillyTavern.libs !== libs) {
    initCompatibilityLibraries(globalThis.SillyTavern.libs);
}

export * from './lib-core.js';
export { slideToggle, chalk, yaml };
export default libs;
