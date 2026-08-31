import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
const excludedDirectories = new Set(['dist', 'lib', 'node_modules', 'vendor']);

function collect(relativePath) {
    const absolutePath = path.join(root, relativePath);
    const stat = fs.statSync(absolutePath);
    if (stat.isDirectory()) {
        if (excludedDirectories.has(path.basename(relativePath))) return;
        for (const entry of fs.readdirSync(absolutePath)) collect(path.join(relativePath, entry));
        return;
    }
    if (/\.m?js$/.test(relativePath)) files.push(relativePath);
}

for (const entry of ['public', 'src', 'server.js']) collect(entry);

const patterns = [
    /\bfrom\s+['"](\.[^'"]+)['"]/g,
    /\bimport\s+['"](\.[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
];
const missing = [];

for (const relativePath of files) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
            const specifier = match[1].replace(/[?#].*$/, '');
            const base = path.resolve(root, path.dirname(relativePath), specifier);
            const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.d.ts`, path.join(base, 'index.js')];
            if (!candidates.some(candidate => fs.existsSync(candidate))) {
                missing.push(`${relativePath}: ${match[1]}`);
            }
        }
    }
}

assert.deepEqual(missing, [], `Missing relative imports:\n${missing.join('\n')}`);
console.log(`nora-relative-imports-contract=PASS files=${files.length}`);
