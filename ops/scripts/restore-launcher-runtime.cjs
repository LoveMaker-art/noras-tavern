const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { installBundledHermes } = require('../installer/desktop/runtime');

const [artifacts, temporary] = process.argv.slice(2);
if (!artifacts || !temporary) throw new Error('Pass the baseline artifact directory and runner temporary directory');
const prefix = `${process.platform}-${process.arch}-`;
const name = `${prefix}nora-hermes-runtime.json`;
const matches = fs.readdirSync(artifacts, { recursive: true }).filter(file => path.basename(file) === name);
assert.equal(matches.length, 1, 'Expected exactly one baseline runtime manifest');
const manifestFile = path.join(artifacts, matches[0]);
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
assert.equal(manifest.platform, process.platform);
assert.equal(manifest.arch, process.arch);
assert.match(manifest.archive, /^[a-zA-Z0-9._-]+$/);
const payload = path.join(temporary, 'hermes-runtime');
fs.mkdirSync(payload, { recursive: true });
fs.copyFileSync(manifestFile, path.join(payload, 'nora-hermes-runtime.json'));
fs.copyFileSync(path.join(path.dirname(manifestFile), prefix + manifest.archive), path.join(payload, manifest.archive));
// Keep the exact archive digest so a Beta.5 partial installation can resume safely.
installBundledHermes({ payloadRoot: payload, noraHome: temporary,
  hermesHome: path.join(temporary, 'hermes'), onEvent: event => console.log(event.task) });
console.log(`Restored verified ${prefix}runtime: ${manifest.sha256}`);
