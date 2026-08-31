import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getExtensionStyleResources } from '../public/scripts/nora-compat/style-resources.js';

const indexHtml = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const startupController = fs.readFileSync(new URL('../../../native-extensions/nora-ui/startup-controller.js', import.meta.url), 'utf8');
const extensionLoader = fs.readFileSync(new URL('../public/scripts/extensions.js', import.meta.url), 'utf8');
const optionalResources = fs.readFileSync(new URL('../public/scripts/nora-compat/optional-ui-resources.js', import.meta.url), 'utf8');

test('the Nora shell does not globally deliver the legacy ST visual stack', () => {
    assert.match(indexHtml, /css\/nora-runtime-contract\.css/);
    assert.match(indexHtml, /third-party\/nora-ui\/style\.css/);
    const linkedStyles = [...indexHtml.matchAll(/<link[^>]+(?:href|data-nora-deferred-href)=["']([^"']+)["'][^>]*>/g)]
        .map(match => match[1]);
    for (const legacyPath of [
        '/style.css',
        '/css/st-tailwind.css',
        '/css/toggle-dependent.css',
        '/css/world-info.css',
        '/css/select2-overrides.css',
        '/css/mobile-styles.css',
        '/css/macros.css',
        '/css/user.css',
    ]) {
        assert.equal(
            linkedStyles.some(path => path.endsWith(legacyPath) && !path.includes('/third-party/nora-ui/')),
            false,
            `${legacyPath} must not be linked by the product shell`,
        );
    }
    assert.doesNotMatch(indexHtml, /data-nora-deferred-href|__NORA_LOAD_DEFERRED_STYLES__/);
    assert.doesNotMatch(startupController, /__NORA_LOAD_DEFERRED_STYLES__|deferredStyles/);
});

test('capability UI styles load through one explicit resource seam', () => {
    assert.deepEqual(getExtensionStyleResources('regex'), [
        '/css/animations.css',
        '/css/popup.css',
        '/css/jquery-ui.min.css',
    ]);
    assert.ok(getExtensionStyleResources('third-party/JS-Slash-Runner').includes('/css/bright.min.css'));
    assert.deepEqual(getExtensionStyleResources('third-party/nora-mvu'), []);
    assert.match(extensionLoader, /ensureExtensionStyleResources\(name\)/);
    assert.match(optionalResources, /ensureStylePaths\(resource\.styles\)/);
});
