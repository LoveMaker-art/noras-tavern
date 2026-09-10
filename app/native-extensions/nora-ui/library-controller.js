import { translate as tr } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
import { describePreset } from './preset-presentation.js';

export function createLibraryController({ presets, dialogs, operations, isGenerating,
    refresh, select: $, selectAll: $$, escapeHtml: html }) {
    const errorToast = error => dialogs.toast(dialogs.normalizeError(error), { tone: 'error', duration: 5000 });
    const busy = () => isGenerating() || operations.isBusy('world') || operations.isBusy('library');
    let presetQuery = '';
    let presetScroll = 0;

    async function openPresets() {
        try {
            const library = presets.listPresets();
            const modal = dialogs.open(tr('预设库'), `<div class="nora-preset-search"><input type="search" data-preset-search value="${html(presetQuery)}" placeholder="${tr('搜索预设')}" aria-label="${tr('搜索预设')}"><button class="nora-icon-button" type="button" data-import title="${tr('导入预设')}" aria-label="${tr('导入预设')}"><i class="fa-solid fa-file-import" aria-hidden="true"></i></button></div><div class="nora-preset-results" data-preset-results></div>`, 'nora-preset-modal nora-preset-list-modal nora-plain-sheet');
            const importButton = $('[data-import]', modal);
            $('.nora-sheet > header', modal)?.insertBefore(importButton, $('.nora-modal-close', modal));
            $('[data-import]', modal).addEventListener('click', () => openJsonImport());
            const results = $('[data-preset-results]', modal);
            const render = () => {
                const query = presetQuery.trim().toLocaleLowerCase();
                const items = library.items.map((item, index) => ({ item, index })).filter(({ item }) => item.name.toLocaleLowerCase().includes(query));
                results.innerHTML = items.map(({ item, index }) => `<button type="button" class="nora-preset-row${item.name === library.selected ? ' is-current' : ''}" data-preset="${index}" ${item.name === library.selected ? 'aria-current="true"' : ''}><strong>${html(item.name)}</strong><span>${item.name === library.selected ? `<i class="fa-solid fa-check" aria-hidden="true"></i><small>${tr('使用中')}</small>` : '<i class="fa-solid fa-chevron-right" aria-hidden="true"></i>'}</span></button>`).join('') || `<p class="nora-sheet-empty" role="status">${tr(query ? '没有匹配的预设' : '暂无预设')}</p>`;
                $$('[data-preset]', results).forEach(button => button.addEventListener('click', () => openPreset(library.items[Number(button.dataset.preset)])));
                results.scrollTop = presetScroll;
            };
            $('[data-preset-search]', modal).addEventListener('input', event => {
                presetQuery = event.currentTarget.value;
                presetScroll = 0;
                render();
            });
            results.addEventListener('scroll', () => { presetScroll = results.scrollTop; });
            render();
        } catch (error) { errorToast(error); }
    }

    function openPreset(item) {
        const view = describePreset(item.preset);
        const current = presets.listPresets().selected === item.name;
        const rows = view.rows.map(prompt => {
            const status = !view.configured ? tr('顺序未配置') : !prompt.listed ? tr('未加入顺序') : prompt.enabled ? tr('已启用') : tr('已禁用');
            return `<details class="nora-preset-prompt${prompt.enabled === false ? ' is-disabled' : ''}"><summary><span>${html(prompt.name || prompt.identifier)}</span><small>${status}</small></summary><p>${html(prompt.content || tr(prompt.marker ? '动态内容' : '暂无内容'))}</p></details>`;
        }).join('');
        const modal = dialogs.open(item.name, `<div class="nora-preset-detail-scroll"><button type="button" class="nora-sheet-back" data-back><i class="fa-solid fa-chevron-left" aria-hidden="true"></i> ${tr('预设库')}</button>
            <div class="nora-preset-meta"><span>${tr('全局预设')}</span>${current ? `<span><i class="fa-solid fa-check" aria-hidden="true"></i> ${tr('使用中')}</span>` : ''}</div>
            ${view.parameters.length ? `<dl class="nora-preset-parameters">${view.parameters.map(parameter => `<div><dt>${tr(parameter.label)}</dt><dd>${html(parameter.value)}</dd></div>`).join('')}</dl>` : ''}
            <details class="nora-preset-prompts"><summary>${tr('提示词条目')} <small>${view.rows.length}</small></summary>${rows || `<p class="nora-sheet-empty">${tr('暂无条目')}</p>`}</details></div>
            <footer class="nora-form-actions nora-editor-toolbar nora-preset-footer">${view.scripts ? `<label class="nora-library-check"><input type="checkbox" data-scripts>${tr('启用嵌入式脚本')} (${view.scripts})</label>` : ''}<button type="button" data-apply class="nora-primary">${tr(current ? '重新应用' : '应用预设')}</button></footer>`, 'nora-preset-modal nora-preset-detail-modal nora-plain-sheet');
        $('[data-back]', modal).addEventListener('click', openPresets);
        $('[data-apply]', modal).addEventListener('click', async event => {
            if (busy()) return dialogs.toast(tr('请等待当前生成或保存完成。'));
            const button = event.currentTarget;
            const accepted = await dialogs.confirm({ title: tr('应用此预设？'), body: tr('将更换全局提示词与生成参数，切换世界后仍使用此预设。模型地址和密钥保持不变。'), confirmLabel: tr('应用'), restoreSheet: true });
            if (!accepted || busy()) return;
            button.disabled = true;
            try {
                await operations.run('library', () => presets.applyPreset(item.name, { enableScripts: Boolean($('[data-scripts]', modal)?.checked) }));
                await openPresets();
                refresh();
            } catch (error) { errorToast(error); }
            finally { button.disabled = false; }
        });
    }


    function openJsonImport() {
        const modal = dialogs.open(tr('导入预设'), `<form class="nora-form" data-import-form>
            <label>JSON<input type="file" accept=".json,application/json" name="file" required></label>
            <label>${tr('名称')}<input name="name" maxlength="150" required></label>
            <div class="nora-form-actions"><button type="button" data-back>${tr('取消')}</button><button type="submit" class="nora-primary">${tr('导入')}</button></div></form>`, 'nora-detail-modal');
        const form = $('[data-import-form]', modal);
        form.elements.file.addEventListener('change', () => { if (!form.elements.name.value) form.elements.name.value = (form.elements.file.files[0]?.name || '').replace(/\.json$/i, ''); });
        $('[data-back]', modal).addEventListener('click', openPresets);
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (busy()) return dialogs.toast(tr('请等待当前操作完成。'));
            const button = $('button[type="submit"]', form);
            button.disabled = true;
            try {
                const file = form.elements.file.files[0];
                if (!file || file.size > 10 * 1024 * 1024) throw new Error(tr('请选择不超过 10 MB 的 JSON 文件。'));
                const data = JSON.parse(await file.text());
                await operations.run('library', () => presets.importPreset(form.elements.name.value.trim(), data));
                presetQuery = '';
                presetScroll = 0;
                await openPresets();
                dialogs.toast(tr('已导入库。'));
            } catch (error) { errorToast(error); }
            finally { button.disabled = false; }
        });
    }
    return { openPresets };
}
