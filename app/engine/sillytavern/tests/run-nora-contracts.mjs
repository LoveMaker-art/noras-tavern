import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testsRoot = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.dirname(testsRoot);
const contracts = fs.readdirSync(testsRoot)
    .filter(file => /^nora-.*-contract\.mjs$/.test(file))
    .sort();

for (const contract of contracts) {
    const arguments_ = [path.join(testsRoot, contract)];
    if (contract === 'nora-ui-shell-contract.mjs') {
        arguments_.push('public/index.html', '../../native-extensions/nora-ui/index.js');
    }
    const result = spawnSync(process.execPath, arguments_, {
        cwd: engineRoot,
        stdio: 'inherit',
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`nora-contracts=PASS count=${contracts.length}`);
