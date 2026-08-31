import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const html = read('public/index.html');
const manifest = JSON.parse(read('public/manifest.json'));
assert.equal(manifest.name, 'tavern');
assert.equal(manifest.short_name, 'tavern');
assert.ok(manifest.icons.every(icon => !/\bst(?:-launcher)?\.ico\b/i.test(icon.src)));
const onboardingStart = html.indexOf('<div id="onboarding_template"');
const onboardingEnd = html.indexOf('<div id="bogus_folder_template"', onboardingStart);
assert.ok(onboardingStart >= 0 && onboardingEnd > onboardingStart, 'The first-run onboarding template must exist.');

const onboarding = html.slice(onboardingStart, onboardingEnd);
assert.match(onboarding, /欢迎来到 tavern/);
assert.match(onboarding, /为你在故事中的角色取一个名字/);
assert.doesNotMatch(onboarding, /SillyTavern|docs\.sillytavern|discord\.gg\/sillytavern/i);
assert.doesNotMatch(html, /docs\.sillytavern|github\.com\/SillyTavern|discord\.gg\/sillytavern/i);

const welcomePanel = read('public/scripts/templates/welcomePanel.html');
assert.match(welcomePanel, /img\/logo\.png/);
assert.match(welcomePanel, /alt="Nora"/);
assert.doesNotMatch(welcomePanel, /SillyTavern|docs\.sillytavern|github\.com\/SillyTavern|discord\.gg\/sillytavern/i);

for (const relativePath of [
    'public/scripts/nora-compat/st-kernel.js',
    'public/scripts/nora-adapters/st-runtime-adapter.js',
    'public/scripts/nora-adapters/st-world-adapter.js',
]) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /SillyTavern (?:context|compatibility kernel) (?:is missing|did not expose)/);
    assert.match(source, /故事运行核心/);
}

const serverMain = read('src/server-main.js');
assert.match(serverMain, /console\.log\(`Nora Tavern \$\{version\.pkgVersion\}`\)/);
assert.match(serverMain, /setWindowTitle\('Nora Tavern WebServer'\)/);
assert.match(serverMain, /Nora Tavern is listening on/);
assert.doesNotMatch(serverMain, /SillyTavern (?:\$\{version\.pkgVersion\}|WebServer|is listening on)/);

const serverStartup = read('src/server-startup.js');
assert.match(serverStartup, /Another Nora Tavern instance may already be running/);
assert.doesNotMatch(serverStartup, /Another SillyTavern instance may already be running/);

assert.doesNotMatch(html, /#loader\.splash-screen/);
for (const obsoleteIcon of ['public/st.ico', 'public/st-launcher.ico']) {
    assert.equal(fs.existsSync(path.join(root, obsoleteIcon)), false, `${obsoleteIcon} must be removed`);
}

const noraBundle = read('public/dist/nora/entry.js');
assert.match(noraBundle, /故事运行核心/);
assert.doesNotMatch(noraBundle, /SillyTavern (?:context|compatibility kernel) (?:is missing|did not expose)/);

console.log('Nora visible-brand surface contract passed.');
