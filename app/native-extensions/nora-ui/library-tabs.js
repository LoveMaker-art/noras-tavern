import { translate as tr } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';

const pendingViews = new WeakMap();

// Both library controllers share one request order and the dialog lifecycle.
export function beginLibraryView(dialogs, target = null) {
    const request = {};
    let version = dialogs.version;
    pendingViews.set(dialogs, request);
    const isCurrent = () => pendingViews.get(dialogs) === request && dialogs.version === version;
    return {
        isCurrent,
        open(title, content, className) {
            if (!isCurrent()) return null;
            const modal = dialogs.open(title, content, className, target ? {} : {
                reuseKey: 'world-library', preserveSelector: '.nora-library-tabs',
            });
            version = dialogs.version;
            return modal;
        },
    };
}

export function libraryTabs(current) {
    const isRole = current === 'persona' || current === 'character';
    const roleTarget = isRole ? current : 'persona';
    const button = ([key, label]) => `<button type="button" data-library-tab="${key}" ${key === current ? 'aria-current="page"' : ''}>${tr(label)}</button>`;
    const main = `<nav class="nora-library-tabs" aria-label="${tr('世界卡库')}">${[
        ['cards', '世界卡'], [roleTarget, '角色'], ['worldbooks', '世界书'],
    ].map(button).join('')}</nav>`;
    const roles = isRole ? `<nav class="nora-library-subtabs" aria-label="${tr('角色分类')}">${[
        ['persona', '我的角色'], ['character', '其他角色'],
    ].map(button).join('')}</nav>` : '';
    return main + roles;
}
