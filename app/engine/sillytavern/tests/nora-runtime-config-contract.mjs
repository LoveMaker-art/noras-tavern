import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const parseConfig = relativePath => yaml.parse(read(relativePath));

const defaultConfig = parseConfig('default/config.yaml');
const commandLine = read('src/command-line.js');
const configInit = read('src/config-init.js');
const serverMain = read('src/server-main.js');
const serverStartup = read('src/server-startup.js');
const lifecycle = read('../../native_lifecycle.py');
const packageJson = JSON.parse(read('package.json'));
const helperRoot = path.resolve(root, '../../native-extensions/JS-Slash-Runner');
const promptTemplateRoot = path.resolve(root, '../../native-extensions/ST-Prompt-Template');

for (const config of [defaultConfig]) {
    assert.equal(config.browserLaunch.enabled, false, 'managed Nora runtime must never auto-open a browser');
    assert.equal(config.enableUserAccounts, false);
    assert.equal(config.enableDiscreetLogin, false);
    assert.equal(config.perUserBasicAuth, false);
    assert.equal(config.sso.autheliaAuth, false);
    assert.equal(config.sso.authentikAuth, false);

    for (const securityKey of [
        'whitelistMode',
        'whitelist',
        'basicAuthMode',
        'basicAuthUser',
        'disableCsrfProtection',
        'privateAddressWhitelist',
        'requestProxy',
    ]) {
        assert.notEqual(config[securityKey], undefined, `${securityKey} is a preserved security or network capability`);
    }

    for (const providerConfig of ['openai', 'mistral', 'ollama', 'claude', 'gemini']) {
        assert.notEqual(config[providerConfig], undefined, `${providerConfig} provider config must be preserved`);
    }
}

assert.equal(fs.existsSync(path.join(root, 'config.yaml')), false, 'runtime config is generated outside the tracked source tree');

assert.doesNotMatch(commandLine, /browserLaunch|autorunHostname|autorunPortOverride|avoidLocalhost/);
assert.match(commandLine, /getRuntimeUrl/);
assert.doesNotMatch(serverMain, /import\(['"]open['"]\)|Launching in a browser/);
assert.doesNotMatch(lifecycle, /--browserLaunchEnabled/);
assert.match(lifecycle, /MANAGED_EXTENSIONS\s*=\s*\([\s\S]*['"]JS-Slash-Runner['"]/);
assert.match(lifecycle, /MANAGED_EXTENSIONS\s*=\s*\([\s\S]*['"]ST-Prompt-Template['"]/);
assert.equal(fs.existsSync(path.join(helperRoot, 'manifest.json')), true, 'managed runtime must bundle the card runtime manifest');
assert.equal(fs.existsSync(path.join(helperRoot, 'dist/index.js')), true, 'managed runtime must bundle the card runtime script');
assert.equal(fs.existsSync(path.join(helperRoot, 'dist/index.css')), true, 'managed runtime must bundle the card runtime styles');
assert.equal(fs.existsSync(path.join(promptTemplateRoot, 'manifest.json')), true, 'managed runtime must bundle the EJS prompt-template manifest');
assert.equal(fs.existsSync(path.join(promptTemplateRoot, 'dist/index.js')), true, 'managed runtime must bundle the EJS prompt-template runtime');
assert.equal(packageJson.dependencies.open, undefined);

assert.doesNotMatch(configInit, /newKey:\s*['"]browserLaunch\./);
assert.doesNotMatch(configInit, /newKey:\s*['"]sso\./);

for (const providerRouter of [
    'openAiRouter',
    'googleRouter',
    'anthropicRouter',
    'novelAiRouter',
    'openRouterRouter',
    'nanogptRouter',
    'chatCompletionsRouter',
    'textCompletionsRouter',
    'azureRouter',
    'volcengineRouter',
    'minimaxRouter',
    'hordeRouter',
    'koboldRouter',
]) {
    assert.match(serverStartup, new RegExp(`\\b${providerRouter}\\b`), `${providerRouter} must remain registered`);
}

console.log('nora-runtime-config-contract=PASS');
