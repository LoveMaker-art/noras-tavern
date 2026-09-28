import assert from 'node:assert/strict';
import test from 'node:test';
import { libraryTabs } from '../../../native-extensions/nora-ui/library-tabs.js';
import { createLibraryController } from '../../../native-extensions/nora-ui/library-controller.js';
import { translate as tr } from '../public/scripts/nora-i18n/core.js';

function buttons(markup) {
    return [...markup.matchAll(/<button[^>]*data-library-tab="([^"]+)"([^>]*)>([^<]+)<\/button>/g)]
        .map(([, key, attrs, label]) => ({ key, label, current: attrs.includes('aria-current="page"') }));
}

for (const current of ['cards', 'persona', 'character', 'worldbooks']) {
    test(`library navigation has three main categories and contextual role subcategories: ${current}`, () => {
        const markup = libraryTabs(current);
        const main = buttons(markup.match(/<nav class="nora-library-tabs"[^>]*>(.*?)<\/nav>/s)[1]);
        assert.deepEqual(main.map(item => item.label), ['世界卡', '角色', '世界书'].map(label => tr(label)));
        assert.equal(main.filter(item => item.current).length, 1);
        const role = current === 'persona' || current === 'character';
        assert.equal(main[1].current, role);
        const sub = markup.match(/<nav class="nora-library-subtabs"[^>]*>(.*?)<\/nav>/s);
        assert.equal(Boolean(sub), role);
        if (sub) {
            const children = buttons(sub[1]);
            assert.deepEqual(children.map(item => item.label), ['我的角色', '其他角色'].map(label => tr(label)));
            assert.deepEqual(children.filter(item => item.current).map(item => item.key), [current]);
            assert.equal(main[1].key, current, 'Clicking the active parent preserves the selected role category');
        } else assert.equal(main[1].key, 'persona', 'Entering roles starts with My persona');
    });
}

test('real library handlers switch profile kinds without writes and leave contextual pickers restricted', async () => {
    let modal;
    const kinds = [], cards = [], errors = [];
    const controller = createLibraryController({
        worlds: {
            listLibraryProfiles: async kind => { kinds.push(kind); return { items: [], warnings: [] }; },
            listLibraryWorldbooks: async () => ({ items: [], warnings: [] }),
        },
        dialogs: {
            open: (_title, markup) => {
                modal = { markup, tabs: buttons(markup).map(item => ({ ...item, dataset: { libraryTab: item.key }, addEventListener(_type, fn) { this.click = fn; } })) };
                return modal;
            },
            toast: error => errors.push(error), normalizeError: error => error.message,
        },
        operations: { isBusy: () => false }, isGenerating: () => false, activeWorldModel: () => null,
        openCards: () => cards.push(true), refresh() {}, escapeHtml: String,
        select: () => ({ addEventListener() {}, remove() {} }),
        selectAll: (selector, root) => selector === '[data-library-tab]' ? root.tabs : [],
    });
    await controller.openProfiles('persona');
    assert.deepEqual(kinds, ['persona']);
    await modal.tabs.find(button => button.key === 'character').click();
    assert.deepEqual(kinds, ['persona', 'character']);
    await modal.tabs[1].click();
    assert.equal(kinds.at(-1), 'character');
    await modal.tabs.find(button => button.key === 'worldbooks').click();
    assert.doesNotMatch(modal.markup, /nora-library-subtabs/);
    await modal.tabs.find(button => button.key === 'persona').click();
    assert.equal(kinds.at(-1), 'persona');
    await modal.tabs.find(button => button.key === 'cards').click();
    assert.equal(cards.length, 1);
    await controller.openProfiles('character', { id: 'world:a', name: 'Target' });
    assert.equal(kinds.at(-1), 'character');
    assert.equal(modal.tabs.length, 0, 'A role picker cannot switch to persona or full-card imports');
    assert.doesNotMatch(modal.markup, /data-profile-new|data-profile-import/);
    assert.deepEqual(errors, []);
});
