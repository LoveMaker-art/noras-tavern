import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const filters = read('public/scripts/filters.js');
assert.doesNotMatch(filters, /from ['"]\.\/tags\.js['"]/, 'filters.js must not create a tags/filter module cycle');
assert.doesNotMatch(filters, /fuzzySearchCategories\.groups/, 'FilterHelper must not retain Group search state');

const script = read('public/script.js');
assert.match(
    script,
    /new FilterHelper\(printCharactersDebounced,\s*\(\) => tag_map\)/,
    'the character filter must receive tag lookup without a static filters-to-tags import',
);

const powerUser = read('public/scripts/power-user.js');
assert.doesNotMatch(
    powerUser,
    /from ['"]\.\/personas\.js['"]/,
    'power-user.js must not import personas.js and complete the filters/power-user/personas cycle',
);

const constants = read('public/scripts/constants.js');
assert.match(
    constants,
    /export const persona_description_positions\s*=\s*\{/,
    'persona description positions must live in the dependency-free constants module',
);

const personas = read('public/scripts/personas.js');
assert.doesNotMatch(
    personas,
    /export const personasFilter\s*=\s*new FilterHelper/,
    'personas.js must not instantiate FilterHelper while the circular module graph is evaluating',
);
assert.match(
    personas,
    /function getPersonasFilter\(\)/,
    'the persona filter must be initialized lazily on first runtime use',
);

const worldInfo = read('public/scripts/world-info.js');
assert.doesNotMatch(
    worldInfo,
    /export const worldInfoFilter\s*=\s*new FilterHelper/,
    'world-info.js must not instantiate FilterHelper while the circular module graph is evaluating',
);
assert.match(
    worldInfo,
    /function getWorldInfoFilter\(\)/,
    'the world-info filter must be initialized lazily on first runtime use',
);

console.log('nora-module-cycle-contract=PASS');
