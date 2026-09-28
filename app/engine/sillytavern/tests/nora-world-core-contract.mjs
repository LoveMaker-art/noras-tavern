import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, parse } from 'es-module-lexer';

const testsRoot = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(testsRoot, '../src/nora-world-core');
const files = fs.readdirSync(moduleRoot).filter(file => file.endsWith('.js')).sort();
if (!files.length) throw new Error('Nora World Core source files are missing.');

const forbidden = [
    /\bwindow\b/,
    /\bdocument\b/,
    /\bglobalThis\b/,
    /\bjQuery\b/,
    /from ['"][^'"]*public\//,
    /from ['"][^'"]*nora-adapters\//,
];

// These modules are shared data/validation, not browser adapters. Keep one
// implementation, but verify they cannot acquire browser/ST or I/O dependencies.
const sharedRoot = path.resolve(moduleRoot, '../../public/scripts');
const sharedModules = [
    'nora-worlds/world-theme.js',
    'nora-worlds/worldbook-bindings.js',
    'nora-worlds/story-context.js',
    'nora-worlds/character-references.js',
    'nora-worlds/world-preset.js',
    'nora-compat/mvu-compatibility.js',
    'nora-compat/mvu-protocol.js',
    'nora-compat/prompt-template-compatibility.js',
];
const sharedPaths = new Set(sharedModules.map(relative => path.resolve(sharedRoot, relative)));
await init;
for (const relative of sharedModules) {
    const file = path.resolve(sharedRoot, relative);
    const schema = fs.readFileSync(file, 'utf8');
    // Pure modules may share definitions, but every dependency must itself be
    // in this checked set. Dynamic and platform imports remain forbidden.
    for (const dependency of parse(schema)[0]) {
        if (dependency.d !== -1 || !dependency.n?.startsWith('.')
            || !sharedPaths.has(path.resolve(path.dirname(file), dependency.n))) {
            throw new Error(`Shared compatibility module ${relative} has an unchecked dependency: ${dependency.n}`);
        }
    }
    for (const pattern of [...forbidden, /\b(?:fetch|process|SillyTavern|localStorage)\b/]) {
        if (pattern.test(schema)) throw new Error(`Shared compatibility module ${relative} must remain platform-independent: ${pattern}`);
    }
}

for (const file of files) {
    let source = fs.readFileSync(path.join(moduleRoot, file), 'utf8');
    for (const dependency of parse(source)[0].reverse()) {
        if (dependency.d === -1 && dependency.n?.startsWith('.')
            && sharedPaths.has(path.resolve(moduleRoot, dependency.n))) {
            source = source.slice(0, dependency.ss) + source.slice(dependency.se);
        }
    }
    for (const pattern of forbidden) {
        if (pattern.test(source)) throw new Error(`${file} crosses the browser/ST compatibility seam: ${pattern}`);
    }
}

console.log(`nora-world-core-contract=PASS files=${files.length}`);
