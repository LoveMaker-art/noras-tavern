import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mvuRoot = path.resolve(engineRoot, '../../native-extensions/nora-mvu');
const runtime = fs.readFileSync(path.join(mvuRoot, 'runtime.js'), 'utf8');
const mvuPatch = fs.readFileSync(path.join(mvuRoot, 'upstream/nora.patch'), 'utf8');
const runnerPatch = fs.readFileSync(path.join(mvuRoot, 'upstream/slash-runner.patch'), 'utf8');
const bundle = fs.readFileSync(path.join(mvuRoot, 'vendor/bundle.js'), 'utf8');

assert.match(runtime, /NORA_MVU_SETTINGS_VERSION = 5;/,
    'MVU settings migration must carry the bounded-context defaults');
assert.match(runtime, /'最大上下文token数': 64000/,
    'managed MVU must not default to an unbounded 128k request');
assert.match(runnerPatch, /\+\s+custom_api,\n\s+processedImageArray,/,
    'the independent model budget must reach prompt construction, not only the final HTTP request');
assert.match(mvuPatch, /MVU_CONTEXT_TOO_LARGE/,
    'a rejected prompt budget must be reported as a preparation error');
assert.match(bundle, /MVU_CONTEXT_TOO_LARGE/,
    'the shipped bundle must contain the context-budget diagnostic');

console.log('nora-mvu-budget-contract=PASS');
