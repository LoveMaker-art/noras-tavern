import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { normalizeNoraReasoningMessage } from '../public/scripts/nora-compat/reasoning-policy.js';
import { createStMessageViewAdapter } from '../../../native-extensions/nora-ui/st-message-view-adapter.js';

const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const style = fs.readFileSync(new URL('../../../native-extensions/nora-ui/style.css', import.meta.url), 'utf8');
const lifecycle = fs.readFileSync(new URL('../../../native_lifecycle.py', import.meta.url), 'utf8');
const reasoning = fs.readFileSync(new URL('../public/scripts/reasoning.js', import.meta.url), 'utf8');
const chats = fs.readFileSync(new URL('../public/scripts/chats.js', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const messageViewSource = fs.readFileSync(new URL('../../../native-extensions/nora-ui/st-message-view-adapter.js', import.meta.url), 'utf8');
const reasoningViewSource = fs.readFileSync(new URL('../public/scripts/nora-compat/reasoning-view.js', import.meta.url), 'utf8');

test('the obsolete focus skin is removed from source and the lifecycle contract', () => {
    assert.equal(fs.existsSync(new URL('../public/css/nora-skin.css', import.meta.url)), false);
    assert.match(index, /<body class="no-blur nora-product nora-no-world nora-booting">/);
    assert.doesNotMatch(index, /css\/nora-skin\.css|\bnora-focus\b/);
    assert.match(lifecycle, /class=\"no-blur nora-product\"/);
    assert.doesNotMatch(lifecycle, /nora-skin\.css|nora-focus/);
});

test('Nora presents native reasoning as a localized, styled, collapsible surface', () => {
    assert.match(index, /class="mes_reasoning_header_title" data-i18n="思考">思考<\/span>/);
    assert.match(reasoning, /isReasoningAutoParseEnabled\(\)/);
    assert.match(reasoningViewSource, /WAITING_REASONING_TITLE = translate\('正在思考…'\)/);
    assert.match(reasoning, /element\.textContent = isNoraProduct \? WAITING_REASONING_TITLE/);
    assert.match(reasoning, /'已完成思考'/);
    assert.match(reasoning, /`已思考 \$\{durationLabel\} 秒`/);
    assert.match(style, /#nora-chat \.mes_reasoning_details \{[^}]*border:[^}]*border-radius:/s);
    assert.doesNotMatch(style, /#nora-chat \.mes_reasoning_details\s*\{[^}]*display:\s*none/s);
});

test('Nora message actions stay compact and reasoning actions have no native marker treatment', () => {
    assert.match(style, /\.nora-message-controls button \{[^}]*min-height:\s*14px;[^}]*font-size:\s*7px;/s);
    assert.match(style, /@media \(max-width: 760px\)[\s\S]*?\.nora-message-controls button \{[^}]*min-height:\s*16px;/s);
    assert.match(style, /\.mes_reasoning_summary::marker \{ content:\s*['"]{2}; \}/);
    assert.match(style, /\.mes_reasoning_summary::-webkit-details-marker \{ display:\s*none; \}/);
    assert.match(style, /\.mes_reasoning_actions \.mes_button \{[^}]*position:\s*static !important;[^}]*box-shadow:\s*none !important;/s);
    assert.doesNotMatch(index, /mes_reasoning_(?:edit_done|delete|edit_cancel|edit)\b/);
    assert.doesNotMatch(index, /mes_reasoning_close_all\b/);
    assert.match(reasoning, /initializeReasoningView\(this\.messageReasoningDetailsDom\)/);
});

test('Nora history reasoning has no streaming-status flash or duplicate arrow', () => {
    assert.doesNotMatch(index, /mes_reasoning_arrow/);
    assert.match(reasoning, /if \(waiting \|\| this\.state === ReasoningState\.Thinking\) \{/);
    assert.match(reasoning, /element\.textContent = isNoraProduct \? translate\('思考'\) : t`Thought for some time`;/);
});

test('Nora reasoning is visually stable without the legacy ST product stylesheet', () => {
    assert.match(index, /href="\{\{NORA_ASSET_BASE\}\}\/css\/nora-runtime-contract\.css"/);
    assert.doesNotMatch(index, /href="\{\{NORA_ASSET_BASE\}\}\/style\.css"/);
    assert.match(style, /#nora-chat \.mes:not\(\.reasoning\) \.mes_reasoning_details[^}]*\{[^}]*display:\s*none\s*!important;/s);
    assert.match(style, /#nora-chat \.mes:has\(\.mes_reasoning:empty\) \.mes_reasoning_details[^}]*\{[^}]*display:\s*none\s*!important;/s);
    assert.match(style, /#nora-chat \.mes_reasoning_header\s*>\s*\.icon-svg[^}]*\{[^}]*display:\s*none\s*!important;/s);
    assert.match(messageViewSource, /message\.dataset\.noraReasoningReady = 'true'/);
    assert.match(style, /#nora-chat \.mes:not\(\[data-nora-reasoning-ready="true"\]\) \.mes_reasoning_details[^}]*\{[^}]*display:\s*none\s*!important;/s);
    assert.match(script, /if \(!isNoraProductMode\(\)\) \{\s*insertIcon\('thinking-icon'/s);
});

test('composer errors use a compact card instead of a full-width bar', () => {
    assert.match(style, /\.nora-composer-notice \{[^}]*width:\s*min\(400px,[^}]*align-self:\s*center;[^}]*margin:\s*0 auto 10px;[^}]*border:\s*1px solid var\(--nora-line\);[^}]*border-radius:\s*12px;/s);
    assert.doesNotMatch(style, /\.nora-composer-notice \{[^}]*border-top:/s);
    assert.doesNotMatch(style, /\.nora-composer-notice\[data-placement="center"\]/);
    assert.match(style, /\.nora-notice-head \{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*18px minmax\(0,\s*1fr\) 20px;/s);
    assert.match(style, /\.nora-notice-message \{[^}]*margin:[^}]*line-height:/s);
    assert.match(style, /\.nora-notice-actions \{[^}]*justify-content:\s*flex-end;/s);
});

test('Nora collapses reasoning once when a message is first mounted', () => {
    const reasoningDetails = {
        open: true,
        dataset: {},
        removeAttribute(name) {
            if (name === 'open') this.open = false;
        },
    };
    const controls = { dataset: {}, innerHTML: '' };
    const messageBlock = { append: () => {} };
    const text = { querySelector: () => null };
    const message = {
        dataset: {},
        classList: { toggle: () => {} },
        getAttribute: name => ({ mesid: '0', is_system: 'false', is_user: 'false' })[name],
    };
    const select = (selector, root) => {
        if (selector === '.mes_text' && root === message) return text;
        if (selector === '.mes_reasoning_details' && root === message) return reasoningDetails;
        if (selector === '.nora-message-controls' && root === message) return controls;
        if (selector === '.mes_block' && root === message) return messageBlock;
        return null;
    };
    const adapter = createStMessageViewAdapter({
        select,
        selectAll: selector => selector === '#chat .mes' ? [message] : [],
        icons: { left: '', right: '', edit: '', suggest: '', repeat: '' },
        documentRef: { createElement: () => controls },
        MutationObserverImpl: class {},
    });

    adapter.decorate([{ swipe_id: 0 }]);
    assert.equal(reasoningDetails.open, false);
    reasoningDetails.open = true;
    adapter.decorate([{ swipe_id: 0 }]);
    assert.equal(reasoningDetails.open, true);
});

test('Nora exposes existing alternate replies as a visible pager above the message', () => {
    const controls = { dataset: {}, innerHTML: '' };
    const pager = {
        dataset: {},
        hidden: true,
        innerHTML: '',
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
    };
    const text = { querySelector: () => null };
    const message = {
        dataset: {},
        classList: { toggle: () => {} },
        getAttribute: name => ({ mesid: '0', is_system: 'false', is_user: 'false' })[name],
    };
    const select = (selector, root) => {
        if (selector === '.mes_text' && root === message) return text;
        if (selector === '.nora-message-controls' && root === message) return controls;
        if (selector === '.nora-message-pager' && root === message) return pager;
        return null;
    };
    const adapter = createStMessageViewAdapter({
        select,
        selectAll: selector => selector === '#chat .mes' ? [message] : [],
        icons: { left: '‹', right: '›', edit: '', suggest: '', repeat: '' },
        documentRef: { createElement: () => controls },
        MutationObserverImpl: class {},
    });

    adapter.decorate([{ swipe_id: 0, swipes: ['first', 'second'] }]);
    assert.equal(pager.hidden, false);
    assert.match(pager.innerHTML, /data-message-action="left"[^>]*disabled/);
    assert.match(pager.innerHTML, />(?:上一页|Previous page)<.*>1 \/ 2<.*>(?:下一页|Next page)</s);
    assert.doesNotMatch(controls.innerHTML, /data-message-action="(?:left|right)"/);

    adapter.decorate([{ swipe_id: 0, swipes: ['only'] }]);
    assert.equal(pager.hidden, true);
});

test('Nora reasoning policy separates think content and preserves Swipe metadata', () => {
    const message = {
        mes: '<think>private plan</think>Visible reply',
        swipe_id: 0,
        swipes: ['<think>private plan</think>Visible reply'],
        swipe_info: [{ extra: {} }],
        extra: {},
    };
    const changed = normalizeNoraReasoningMessage(message, value => {
        const match = value.match(/^<think>([\s\S]*?)<\/think>([\s\S]*)$/);
        return match ? { reasoning: match[1], content: match[2] } : null;
    });

    assert.equal(changed, true);
    assert.equal(message.mes, 'Visible reply');
    assert.equal(message.extra.reasoning, 'private plan');
    assert.equal(message.extra.reasoning_type, 'parsed');
    assert.equal(message.swipes[0], 'Visible reply');
    assert.equal(message.swipe_info[0].extra.reasoning, 'private plan');
});

test('Nora reasoning policy never rewrites user messages or already parsed messages', () => {
    const parse = () => ({ reasoning: 'private', content: 'visible' });
    const user = { is_user: true, mes: '<think>private</think>visible', extra: {} };
    const parsed = { mes: 'visible', extra: { reasoning: 'private' } };
    assert.equal(normalizeNoraReasoningMessage(user, parse), false);
    assert.equal(normalizeNoraReasoningMessage(parsed, parse), false);
    assert.match(user.mes, /<think>/);
});

test('Nora explicit edit action opens and closes the native editor lifecycle', () => {
    let editor = null;
    let cancellations = 0;
    const message = {
        dataset: {},
        getAttribute: name => name === 'mesid' ? '7' : 'false',
    };
    const nativeEditButton = { click: () => { editor = { value: 'editable text' }; } };
    const nativeCancelButton = { click: () => { cancellations += 1; editor = null; } };
    const select = (selector, root) => {
        if (selector === '.mes_edit' && root === message) return nativeEditButton;
        if (selector === '.mes_edit_cancel' && root === message) return nativeCancelButton;
        if (selector === '#curEditTextarea' && root === message) return editor;
        return null;
    };
    const adapter = createStMessageViewAdapter({
        select,
        selectAll: selector => selector === '#chat .mes' ? [message] : [],
        icons: {},
        documentRef: {},
        MutationObserverImpl: class {},
    });

    assert.equal(adapter.beginEdit(7), true);
    assert.equal(adapter.editorValue(7), 'editable text');
    assert.equal(message.dataset.noraEditing, 'true');
    adapter.finishEdit(7);
    assert.equal(cancellations, 1);
    assert.equal(message.dataset.noraEditing, undefined);
});

test('Nora does not cancel a native editor after its message node was replaced by a committed edit', () => {
    let cancellations = 0;
    const message = {
        dataset: {},
        getAttribute: name => name === 'mesid' ? '7' : 'false',
    };
    const adapter = createStMessageViewAdapter({
        select: (selector, root) => selector === '.mes_edit_cancel' && root === message
            ? { click: () => { cancellations += 1; } }
            : null,
        selectAll: selector => selector === '#chat .mes' ? [message] : [],
        icons: {},
        documentRef: {},
        MutationObserverImpl: class {},
    });

    adapter.finishEdit(7);
    assert.equal(cancellations, 0);
});

test('product mode disables native click-to-edit and does not create a second editor', () => {
    assert.match(chats, /classList\.contains\('nora-product'\)\) return;/);
    assert.doesNotMatch(messageViewSource, /nora-custom-editor|createElement\('textarea'\)|stripThinkingMarkup|guardNativeMessageEdit/);
    assert.match(style, /#nora-chat #curEditTextarea \{ display: block !important;/);
});

test('the ST message Adapter authorizes only card frames mounted in the active story', () => {
    const trustedSource = {};
    const adapter = createStMessageViewAdapter({
        select: () => null,
        selectAll: selector => selector === '#chat .mes_text iframe'
            ? [{ contentWindow: trustedSource }]
            : [],
        icons: {},
        documentRef: {},
        MutationObserverImpl: class {},
    });

    assert.equal(adapter.ownsEmbeddedSource(trustedSource), true);
    assert.equal(adapter.ownsEmbeddedSource({}), false);
    assert.equal(adapter.ownsEmbeddedSource(null), false);
});

test('the ST message Adapter consumes hidden composer input only from an active card frame', () => {
    class CardFrameEvent {
        constructor(target) { this.target = target; }
    }
    const adapter = createStMessageViewAdapter({
        select: () => null,
        selectAll: selector => selector === '#chat .mes_text iframe'
            ? [{ contentWindow: { Event: CardFrameEvent } }]
            : [],
        icons: {},
        documentRef: {},
        MutationObserverImpl: class {},
    });
    const input = { id: 'send_textarea', value: '  开启轮回  ' };

    assert.equal(adapter.consumeLegacyInput({ target: input }), null);
    assert.equal(input.value, '  开启轮回  ');
    assert.equal(adapter.consumeLegacyInput(new CardFrameEvent(input)), '开启轮回');
    assert.equal(input.value, '');
});
