import assert from 'node:assert/strict';
import fs from 'node:fs';

const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const entry = fs.readFileSync(new URL('../public/nora-entry.js', import.meta.url), 'utf8');
const kernel = fs.readFileSync(new URL('../public/scripts/nora-compat/st-kernel.js', import.meta.url), 'utf8');
const core = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');

const directCoreImports = [index, entry, kernel]
    .flatMap((source, ownerIndex) => [...source.matchAll(/import\s*\(\s*(?:\/\*[^*]*\*\/\s*)?['"]\/script\.js['"]\s*\)/g)]
        .map(() => ['index.html', 'nora-entry.js', 'st-kernel.js'][ownerIndex]));

assert.deepEqual(
    directCoreImports,
    ['st-kernel.js'],
    'the ST core must have exactly one explicit execution owner at the compatibility boundary',
);
assert.doesNotMatch(index, /__NORA_ST_CORE_READY__|nora:st-core-ready/, 'HTML cannot claim compatibility-core readiness');
assert.doesNotMatch(kernel, /waitForCoreApi|CORE_READY_TIMEOUT_MS/, 'the compatibility boundary must execute the core instead of waiting for an external owner');
assert.match(core, /globalThis\.SillyTavern\s*=\s*\{/);
assert.match(core, /await firstLoadInit\(\)/);
assert.match(kernel, /typeof st\?\.getContext !== 'function'/, 'the kernel must verify the API created by core evaluation');

console.log('nora-core-execution-contract=PASS');
