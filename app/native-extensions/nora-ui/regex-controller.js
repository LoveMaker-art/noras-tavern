import { translate as tr } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
import { beginLibraryView } from './library-tabs.js';

// This is an editor for the card's native regex data, not a second regex engine.
export function createRegexController({ cards, dialogs, operations, select: $, selectAll: $$,
    escapeHtml: html, isGenerating, activeWorldModel, refresh }) {
    const placements = [[1, '用户输入'], [2, '模型回复'], [3, '斜杠命令'], [5, '世界书'], [6, '思考内容']];
    const flags = [['disabled', '停用本条规则'], ['markdownOnly', '仅格式化显示'],
        ['promptOnly', '仅格式化提示词'], ['runOnEdit', '编辑消息时执行']];
    const busy = () => isGenerating() || operations.isBusy('world') || operations.isBusy('regex');
    const report = error => dialogs.toast(dialogs.normalizeError(error), { tone: 'error', duration: 5000 });

    async function open(avatar, onBack = null, { backLabel = tr('‹ 返回世界卡') } = {}) {
        const worldId = activeWorldModel()?.id;
        const view = beginLibraryView(dialogs, { avatar });
        let snapshot;
        try { snapshot = await cards.readCharacterRegex(avatar); }
        catch (error) { if (view.isCurrent()) report(error); return; }
        if (!view.isCurrent() || activeWorldModel()?.id !== worldId) return;
        if (!Array.isArray(snapshot.scripts)) {
            report(new Error(tr('这张卡的正则规则格式无效。')));
            return;
        }
        const back = () => open(avatar, onBack, { backLabel });
        const modal = view.open(tr('正则规则'), `${onBack ? `<button type="button" class="nora-sheet-back" data-regex-back>${html(backLabel)}</button>` : ''}
            <div class="nora-regex-list-intro"><strong>${html(snapshot.name || '')}</strong><p class="nora-model-note">${tr('按列表顺序执行。这里仅管理卡内规则，不包含全局或预设规则。')}</p></div>
            <div class="nora-library-list nora-regex-list">${snapshot.scripts.map((rule, index) => `<div class="nora-regex-list-row${rule?.disabled ? ' is-disabled' : ''}"><button type="button" class="nora-library-row" data-regex-rule="${index}">
                <strong><span class="nora-regex-order" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>${html(rule?.scriptName || `${tr('规则')} ${index + 1}`)}</strong><small>${tr(rule?.disabled ? '已停用' : '已开启')} · ${html((Array.isArray(rule?.placement) ? rule.placement : []).map(value => tr(placements.find(([id]) => id === value)?.[1] || `${tr('位置')} ${value}`)).join('、'))}</small>
            </button><div class="nora-regex-list-actions"><button type="button" data-regex-edit="${index}">${tr('编辑')}</button><button type="button" data-regex-toggle="${index}" aria-pressed="${!rule?.disabled}">${tr(rule?.disabled ? '启用规则' : '停用规则')}</button></div></div>`).join('') || `<p class="nora-sheet-empty">${tr('这张卡没有内置正则规则。')}</p>`}</div>
            <p class="nora-model-note nora-regex-list-note">${tr('规则开启不代表卡片已获授权；仍受原有扩展授权控制。')}</p>`, 'nora-detail-modal nora-regex-list-modal nora-plain-sheet');
        $('[data-regex-back]', modal)?.addEventListener('click', onBack);
        $$('[data-regex-rule]', modal).forEach(button => button.addEventListener('click', () => {
            const index = Number(button.dataset.regexRule);
            if (activeWorldModel()?.id !== worldId) return report(new Error(tr('世界已切换，请重新打开。')));
            detail(snapshot.scripts[index], back);
        }));
        $$('[data-regex-edit]', modal).forEach(button => button.addEventListener('click', () => {
            if (activeWorldModel()?.id !== worldId) return report(new Error(tr('世界已切换，请重新打开。')));
            edit(snapshot, Number(button.dataset.regexEdit), worldId, back);
        }));
        $$('[data-regex-toggle]', modal).forEach(button => button.addEventListener('click', async () => {
            if (activeWorldModel()?.id !== worldId) return report(new Error(tr('世界已切换，请重新打开。')));
            const index = Number(button.dataset.regexToggle);
            const saved = await toggle(avatar, index, snapshot.scripts[index], button);
            if (saved && view.isCurrent() && activeWorldModel()?.id === worldId) await back();
        }));
    }

    function detail(rule, back) {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return report(new Error(tr('这条规则格式无效。')));
        const modal = dialogs.open(tr('正则规则'), `<div class="nora-form nora-editor-form"><div class="nora-editor-fields">
            <h3>${html(rule.scriptName || tr('规则'))}</h3><p class="nora-model-note">${tr(rule.disabled ? '已停用' : '已开启')} · ${tr('只读查看；如需修改，请返回列表点击编辑。')}</p>
            <label>${tr('匹配表达式')}<textarea class="nora-regex-code" rows="3" readonly spellcheck="false">\n${html(rule.findRegex || '')}</textarea></label>
            <label>${tr('替换内容')}<textarea class="nora-regex-code" rows="12" readonly spellcheck="false">\n${html(rule.replaceString || '')}</textarea></label>
            <details><summary>${tr('查看完整原始规则（只读）')}</summary><textarea class="nora-regex-code" rows="12" readonly aria-label="${tr('查看完整原始规则（只读）')}">${html(JSON.stringify(rule, null, 2))}</textarea></details>
            </div><footer class="nora-form-actions nora-editor-toolbar"><button type="button" class="nora-secondary" data-regex-close>${tr('返回列表')}</button></footer></div>`, 'nora-detail-modal nora-fixed-editor nora-regex-editor-modal nora-plain-sheet');
        $('[data-regex-close]', modal).addEventListener('click', back);
    }

    async function toggle(avatar, index, expectedRule, control) {
        if (busy()) return report(new Error(tr('请等待当前操作完成后再保存。')));
        const worldId = activeWorldModel()?.id;
        control.disabled = true;
        try {
            await operations.run('regex', async () => {
                const snapshot = await cards.readCharacterRegex(avatar);
                if (isGenerating() || activeWorldModel()?.id !== worldId) throw new Error(tr('当前操作状态已变化，请稍后重试。'));
                if (!Number.isInteger(index) || !Array.isArray(snapshot.scripts) || !snapshot.scripts[index]
                    || JSON.stringify(snapshot.scripts[index]) !== JSON.stringify(expectedRule)) {
                    throw new Error(tr('正则规则已发生变化，请重新打开后编辑。'));
                }
                await cards.saveCharacterRegex({ avatar, index, expectedScripts: snapshot.scripts, patch: { disabled: !snapshot.scripts[index].disabled }, worldId });
            });
            refresh();
            return true;
        } catch (error) { if (error.saved) refresh(); report(error); }
        finally { control.disabled = false; }
    }

    function edit(snapshot, index, worldId, back) {
        const rule = snapshot.scripts[index];
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return report(new Error(tr('这条规则格式无效。')));
        const initial = {
            scriptName: String(rule.scriptName ?? ''), findRegex: String(rule.findRegex ?? ''), replaceString: String(rule.replaceString ?? ''),
            ...Object.fromEntries(flags.map(([key]) => [key, Boolean(rule[key])])),
            placement: Array.isArray(rule.placement) ? rule.placement : [],
        };
        const modal = dialogs.open(tr('编辑正则规则'), `<form class="nora-form nora-editor-form" data-regex-form autocomplete="off">
            <div class="nora-editor-fields">
                <p class="nora-model-note">${tr('保存到当前卡文件。引用同一卡文件的世界会受影响，不会修改其他卡或聊天原文。')}</p>
                <label>${tr('规则名称')}<input name="scriptName" required value="${html(initial.scriptName)}"></label>
                <label>${tr('匹配表达式')}<textarea class="nora-regex-code" name="findRegex" rows="3" required spellcheck="false">\n${html(initial.findRegex)}</textarea></label>
                <label>${tr('替换内容')}<textarea class="nora-regex-code" name="replaceString" rows="12" spellcheck="false">\n${html(initial.replaceString)}</textarea></label>
                <p class="nora-model-note">${tr('替换内容按代码原样保存；空内容表示删除匹配文本。此处不执行或预览 HTML、脚本。外部页面的代码仍需在对应资源中修改。')}</p>
                <fieldset class="nora-regex-placements"><legend>${tr('作用位置')}</legend>${placements.map(([value, label]) => `<label class="nora-library-check"><input type="checkbox" name="placement" value="${value}" ${initial.placement.includes(value) ? 'checked' : ''}>${tr(label)}</label>`).join('')}</fieldset>
                <fieldset class="nora-regex-placements"><legend>${tr('执行选项')}</legend>${flags.map(([key, label]) => `<label class="nora-library-check"><input type="checkbox" name="${key}" ${initial[key] ? 'checked' : ''}>${tr(label)}</label>`).join('')}</fieldset>
                <p class="nora-model-note">${tr('“仅格式化显示”和“仅格式化提示词”保持 ST 原有语义；世界书规则需开启“仅格式化提示词”。')}</p>
                <details><summary>${tr('查看完整原始规则（只读）')}</summary><textarea class="nora-regex-code" aria-label="${tr('查看完整原始规则（只读）')}" rows="12" readonly spellcheck="false">${html(JSON.stringify(rule, null, 2))}</textarea><p class="nora-model-note">${tr('规则 ID、宏替换、深度、裁剪文本及其他未编辑字段均保留原值。')}</p></details>
            </div><footer class="nora-form-actions nora-editor-toolbar"><button type="button" class="nora-secondary" data-regex-cancel>${tr('返回列表')}</button><span class="nora-editor-toolbar-spacer"></span><button type="submit" class="nora-primary">${tr('保存')}</button></footer>
            </form>`, 'nora-detail-modal nora-fixed-editor nora-regex-editor-modal nora-plain-sheet');
        const form = $('[data-regex-form]', modal);
        const draft = dialogs.protectForm(form, { isBusy: () => operations.isBusy('regex') });
        $('[data-regex-cancel]', modal).addEventListener('click', () => draft.leave(back));
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (busy()) return report(new Error(tr('请等待当前操作完成后再保存。')));
            if (activeWorldModel()?.id !== worldId) return report(new Error(tr('世界已切换，请重新打开。')));
            const patch = {};
            for (const key of ['scriptName', 'findRegex', 'replaceString']) {
                const value = form.elements.namedItem(key).value;
                if (value !== initial[key]) patch[key] = value;
            }
            for (const [key] of flags) {
                const value = form.elements.namedItem(key).checked;
                if (value !== initial[key]) patch[key] = value;
            }
            // Retain legacy/unknown positions. Opening and saving must not normalize a card.
            const selected = $$('[name="placement"]', form).filter(input => input.checked).map(input => Number(input.value));
            if (placements.some(([value]) => selected.includes(value) !== initial.placement.includes(value))) {
                patch.placement = [...initial.placement.filter(value => !placements.some(([id]) => id === value)), ...selected];
            }
            if (!Object.keys(patch).length) { draft.release(); return back(); }
            const button = $('button[type="submit"]', form);
            button.disabled = true;
            button.textContent = tr('正在保存');
            try {
                await operations.run('regex', () => cards.saveCharacterRegex({ avatar: snapshot.avatar, index, expectedScripts: snapshot.scripts, patch, worldId }));
                draft.release();
                dialogs.toast(tr('正则规则已保存。'));
                refresh();
                if (activeWorldModel()?.id === worldId) await back();
                else dialogs.close();
            } catch (error) {
                if (error.saved) { draft.release(); dialogs.close(); }
                report(error);
            } finally { button.disabled = false; button.textContent = tr('保存'); }
        });
    }

    return Object.freeze({ open, toggle });
}
