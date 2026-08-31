import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// This schema is shared data/validation, not a browser adapter. Keep the one
// implementation, but verify it cannot acquire browser/ST or I/O dependencies.
const themeSchema = fs.readFileSync(path.resolve(moduleRoot, '../../public/scripts/nora-worlds/world-theme.js'), 'utf8');
for (const pattern of [...forbidden, /^\s*import\b/m, /\b(?:fetch|process|SillyTavern|localStorage)\b/]) {
    if (pattern.test(themeSchema)) throw new Error(`Shared World theme schema must remain platform-independent: ${pattern}`);
}

for (const file of files) {
    const source = fs.readFileSync(path.join(moduleRoot, file), 'utf8')
        .replace(/^import \{ normalizeWorldTheme \} from '\.\.\/\.\.\/public\/scripts\/nora-worlds\/world-theme\.js';$/m, '');
    for (const pattern of forbidden) {
        if (pattern.test(source)) throw new Error(`${file} crosses the browser/ST compatibility seam: ${pattern}`);
    }
}

console.log(`nora-world-core-contract=PASS files=${files.length}`);
