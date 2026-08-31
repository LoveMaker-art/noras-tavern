import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const html = read('public/index.html');
const script = read('public/script.js');
const authorsNote = read('public/scripts/authors-note.js');
const cfg = read('public/scripts/cfg-scale.js');
const logprobs = read('public/scripts/logprobs-state.js');

for (const legacyId of [
    'movingDivs',
    'floatingPrompt',
    'cfgConfig',
    'logprobsViewer',
    'option_toggle_AN',
    'option_toggle_CFG',
    'option_toggle_logprobs',
    'extension_floating_prompt',
    'chat_cfg_guidance_scale',
    'global_cfg_guidance_scale',
]) {
    assert.doesNotMatch(html, new RegExp(`id=["']${legacyId}["']`), `${legacyId} must not exist in the Nora product DOM`);
}

assert.doesNotMatch(script, /\binitLogprobs\b/, 'startup must not initialize the removed token-probability UI');
assert.match(script, /saveLogprobsForActiveMessage/, 'generation may retain headless logprob storage');
assert.doesNotMatch(script, /scripts\/logprobs\.js/, 'generation must use the headless logprob state module');

assert.match(authorsNote, /export function getAuthorsNoteState\(/);
assert.match(authorsNote, /export function updateAuthorsNoteState\(/);
assert.doesNotMatch(authorsNote, /\$\(|document\.|floatingPrompt|extension_floating_/, 'author notes must be state-only');

assert.match(cfg, /export function getCfgState\(/);
assert.match(cfg, /export function updateCfgState\(/);
assert.doesNotMatch(cfg, /\$\(|document\.|cfgConfig|chat_cfg_|chara_cfg_|global_cfg_/, 'CFG must be state-only');

assert.match(logprobs, /export function saveLogprobsForActiveMessage\(/);
assert.doesNotMatch(logprobs, /\$\(|document\.|renderAlternativeTokensView|renderTopLogprobs|initLogprobs|callGenericPopup|Generate\(/, 'logprobs must be a headless data store');

console.log('nora-headless-config-contract=PASS');
