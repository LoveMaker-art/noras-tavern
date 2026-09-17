import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { normalizeClientMetricPayload } from '../src/nora-performance-telemetry.js';

test('page image placeholders omit src until a real image URL is assigned', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const images = html.match(/<img\b[^>]*>/gi) ?? [];
    assert.ok(images.length > 0);
    // Hidden div templates still participate in image loading. Empty src is
    // an invalid image request, not a harmless placeholder (including clones).
    const emptySources = images.filter(tag => /\ssrc\s*=\s*(["'])\s*\1/i.test(tag));
    assert.deepEqual(emptySources, [], 'Image placeholders must not issue empty-source requests');
});

function fixture() {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const start = html.indexOf('        (() => {\n            const metrics = globalThis.__NORA_BOOT_METRICS__;');
    const end = html.indexOf('        })();', start) + '        })();'.length;
    assert.ok(start >= 0 && end > start);
    const handlers = {};
    const reports = [];
    const context = {
        URL, structuredClone, console, Promise, Set, Map,
        performance: { now: () => 334 }, location: { href: 'https://fixture.invalid/' },
        document: { body: { classList: { contains: () => false } } },
        setTimeout: () => 0, PerformanceObserver: class { observe() {} },
        addEventListener: (name, handler) => { handlers[name] = handler; },
        __NORA_BOOT_METRICS__: { sessionId: 'diagnostic-fixture', startedAt: 0, milestones: [], resources: [], resourceEvents: [] },
        __NORA_CSRF_PROMISE__: Promise.resolve('fixture-only'),
        fetch: async (_url, options) => { reports.push(normalizeClientMetricPayload(JSON.parse(options.body))); return { ok: true }; },
    };
    vm.createContext(context);
    vm.runInContext(html.slice(start, end), context);
    return { handlers, reports, context, flush: () => context.__NORA_EARLY_REPORT_QUEUE__ };
}

function image(templateId, src = '') {
    return {
        tagName: 'IMG', id: '', className: 'avatar-image', src: new URL(src, 'https://fixture.invalid/').href,
        currentSrc: '', complete: true, naturalWidth: 0, naturalHeight: 0,
        getAttribute: name => name === 'src' ? src : null,
        closest: () => ({ id: templateId }),
    };
}

test('different empty image templates remain distinguishable after server normalization', async () => {
    const f = fixture();
    for (const id of ['zoomed_avatar_template', 'user_avatar_template', 'character_template', 'message_template', 'inline_avatar_template', 'message_image_template']) {
        f.handlers.error({ target: image(id) });
    }
    await f.flush();
    assert.equal(f.reports.length, 6);
    const entries = f.reports.at(-1).metrics.milestones;
    assert.equal(new Set(entries.map(entry => entry.templateId)).size, 6);
    assert.ok(entries.every(entry => entry.resource === '' && entry.srcEmpty && entry.elementTag === 'IMG'));
    assert.ok(entries.every(entry => entry.diagnosticVersion === 'resource-error-v1'));
});

test('reports remain bounded and repeated errors from the same element are deduplicated', async () => {
    const f = fixture();
    for (let i = 0; i < 30; i++) {
        f.handlers.error({ target: image(`template${i}_template`) });
        f.handlers.error({ target: image(`template${i}_template`) });
    }
    await f.flush();
    assert.equal(f.reports.length, 12);
});

test('resource URLs lose credentials, query, fragments and inline payloads', async () => {
    const f = fixture();
    f.handlers.error({ target: image('avatar_template', 'https://user:secret@cdn.example.test/a.png?key=secret#secret') });
    f.handlers.error({ target: image('inline_template', 'data:image/png;base64,secret') });
    await f.flush();
    const entries = f.reports.at(-1).metrics.milestones;
    assert.equal(entries[0].resource, '/a.png');
    assert.equal(entries[0].resourceOrigin, 'https://cdn.example.test');
    assert.equal(entries[1].resource, '[inline-resource]');
    assert.doesNotMatch(JSON.stringify(entries), /secret/);
});

test('script exceptions retain location while resource errors retain element identity', async () => {
    const f = fixture();
    f.handlers.error({ message: 'example failure', filename: 'https://example.test/app.js?q=private', lineno: 10, colno: 12, error: { name: 'TypeError' } });
    await f.flush();
    const entry = f.reports[0].metrics.milestones[0];
    assert.equal(entry.errorKind, 'javascript');
    assert.equal(entry.resource, '/app.js');
    assert.equal(entry.line, 10);
    assert.equal(entry.column, 12);
});
