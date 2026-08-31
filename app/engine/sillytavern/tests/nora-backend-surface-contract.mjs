import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const exists = relativePath => fs.existsSync(path.join(root, relativePath));

const startup = source('src/server-startup.js');
const extensions = source('public/scripts/extensions.js');
const packageJson = JSON.parse(source('package.json'));
const defaultConfig = source('default/config.yaml');

for (const removedPath of [
    'src/endpoints/moving-ui.js',
    'src/endpoints/themes.js',
    'src/endpoints/data-maid.js',
    'src/endpoints/stable-diffusion.js',
    'src/endpoints/translate.js',
    'src/endpoints/classify.js',
    'src/endpoints/caption.js',
    'src/transformers.js',
    'public/scripts/extensions/stable-diffusion',
    'public/scripts/extensions/translate',
    'public/scripts/extensions/expressions',
    'public/scripts/extensions/caption',
]) {
    assert.equal(exists(removedPath), false, `${removedPath} must be removed from the Nora core runtime`);
}

for (const removedRoute of [
    '/api/moving-ui',
    '/api/themes',
    '/api/data-maid',
    '/api/sd',
    '/api/translate',
    '/api/extra/classify',
    '/api/extra/caption',
    '/savemovingui',
    '/savetheme',
]) {
    assert.doesNotMatch(startup, new RegExp(removedRoute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

assert.doesNotMatch(extensions, /['"](?:caption|expressions|stable-diffusion|translate)['"]/);
assert.equal(packageJson.dependencies['sillytavern-transformers'], undefined);
assert.equal(packageJson.dependencies['bing-translate-api'], undefined);
assert.doesNotMatch(defaultConfig, /extensions:\s*[\s\S]*?\n\s+models:/);
assert.doesNotMatch(defaultConfig, /^deepl:/m);

for (const preservedRoute of [
    '/api/characters',
    '/api/chats',
    '/api/worldinfo',
    '/api/nora-worlds',
    '/api/nora-worlds-v2',
    '/api/nora-mvu-model',
    '/api/tokenizers',
    '/api/presets',
    '/api/secrets',
    '/api/extensions',
    '/api/search',
    '/api/backends/chat-completions',
    '/api/backends/text-completions',
    '/api/backups',
]) {
    assert.match(startup, new RegExp(preservedRoute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${preservedRoute} must remain registered`);
}

assert.doesNotMatch(startup, /\/api\/nora-imports/, 'the legacy import journal route must be removed');

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
    assert.match(startup, new RegExp(`\\b${providerRouter}\\b`), `${providerRouter} must remain registered`);
}

console.log('nora-backend-surface-contract=PASS');
