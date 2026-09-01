import { translate as tr } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
import { createComposerFormatController } from './composer-format-controller.js';

export function createShellController({ select, selectAll, icons, messageView, exposeMessageApi }) {
    let resizeObserver;
    const composerFormats = createComposerFormatController();

    function removeNestedLayoutCopies() {
        selectAll('#nora-layout').filter(layout => layout.parentElement !== document.body).forEach(layout => layout.remove());
    }

    function createLayout() {
        const layout = document.createElement('div');
        layout.id = 'nora-layout';
        layout.innerHTML = `
            <aside id="nora-rail" class="nora-pane" aria-label="${tr("世界")}">
                <div class="nora-pane-head">${tr("世界")}</div>
                <div id="nora-world-list" class="nora-world-list"></div>
                <div class="nora-rail-actions"><button id="nora-new-world" class="nora-outline-button" type="button">${icons.plus}<span>${tr("开启新世界")}</span></button></div>
            </aside>
            <main id="nora-stage">
                <header id="nora-topbar">
                    <button id="nora-rail-toggle" class="nora-icon-button" type="button" aria-label="${tr("世界")}">${icons.menu}</button>
                    <div class="nora-title-wrap"><div class="nora-title"><span class="nora-mark">✦</span><span id="nora-title">${tr("酒馆")}</span></div><div id="nora-subtitle" class="nora-subtitle"></div></div>
                    <button id="nora-panel-toggle" class="nora-icon-button" type="button" aria-label="${tr("角色与设定")}">${icons.info}</button>
                </header>
                <div id="nora-story-pane"><div id="nora-world-backdrop"></div><div id="nora-chat" aria-live="polite"></div><div id="nora-empty" class="nora-empty"><span>✦</span><p>${tr("选一个世界，故事会从这里开始。")}</p><small>${tr("也可以导入角色卡开启新世界")}</small></div></div>
                <div id="nora-composer-notice" class="nora-composer-notice" role="alert" aria-live="assertive" hidden></div>
                <form id="nora-composer" autocomplete="off">
                    <div class="nora-format-control"><button id="nora-action" class="nora-format-trigger" type="button" aria-label="${tr("对白、动作与强调")}" title="${tr("对白、动作与强调")}" aria-haspopup="menu" aria-controls="nora-format-menu" aria-expanded="false" disabled><svg class="nora-format-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 7V4h12v3M9 4v15M6 19h6M16 13h5M16 18h5"/></svg></button></div>
                    <textarea id="nora-input" rows="1" placeholder="${tr("续写这一场…")}" aria-label="${tr("消息")}"></textarea>
                    <button id="nora-send" class="nora-send empty" type="submit" aria-label="${tr("发送")}">${icons.send}</button>
                </form>
            </main>
            <aside id="nora-panel" class="nora-pane" aria-label="${tr("角色与设定")}"><div id="nora-panel-body" class="nora-panel-body panelBody"></div></aside>
            <button id="nora-scrim" type="button" aria-label="${tr("关闭面板")}"></button>
            <div id="nora-modal" class="nora-modal" aria-hidden="true"></div>
            <div id="nora-toast" class="nora-toast" role="status" aria-live="polite" hidden></div>
            <input id="nora-character-import" type="file" accept=".json,image/png,.yaml,.yml,.charx,.byaf" multiple hidden>
            <div id="nora-runtime" aria-hidden="true"></div>`;
        return layout;
    }

    function ensureLayoutContract(layout) {
        const requiredIds = [
            'nora-rail-toggle', 'nora-panel-toggle', 'nora-scrim', 'nora-new-world',
            'nora-composer', 'nora-input', 'nora-send', 'nora-action',
            'nora-composer-notice', 'nora-toast', 'nora-character-import', 'nora-chat', 'nora-world-list', 'nora-runtime',
        ];
        if (requiredIds.every(id => layout.querySelector(`#${id}`))) return layout;
        const replacement = createLayout();
        layout.replaceWith(replacement);
        return replacement;
    }

    function buildLayout() {
        removeNestedLayoutCopies();
        let layout = select('body > #nora-layout');
        if (!layout) {
            layout = createLayout();
            document.body.prepend(layout);
        } else {
            layout = ensureLayoutContract(layout);
        }
        composerFormats.mount(layout);
        messageView.mountRuntime({ chatHost: select('#nora-chat'), runtimeHost: select('#nora-runtime') });
        document.body.classList.add('nora-product');
        exposeMessageApi();
    }

    function bindLayoutEvents(handlers) {
        select('#nora-rail-toggle').addEventListener('click', () => openDrawer('rail'));
        select('#nora-panel-toggle').addEventListener('click', () => openDrawer('panel'));
        select('#nora-scrim').addEventListener('click', closeDrawers);
        select('#nora-new-world').addEventListener('click', handlers.openNewWorld);
        select('#nora-composer').addEventListener('submit', handlers.sendMessage);
        select('#nora-input').addEventListener('input', handlers.updateComposer);
        select('#nora-input').addEventListener('keydown', handlers.composerKeydown);
        select('#nora-character-import').addEventListener('change', handlers.importCharacter);
        select('#nora-chat').addEventListener('click', handlers.handleMessageAction, { capture: true });
        select('#nora-world-list').addEventListener('click', handlers.selectWorld);
        select('#nora-world-list').addEventListener('keydown', handlers.worldListKeydown);
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') { handlers.closeModal(); closeDrawers(); }
        });
        resizeObserver = new ResizeObserver(() => document.documentElement.style.setProperty('--nora-vh', `${window.innerHeight}px`));
        resizeObserver.observe(document.documentElement);
        document.body.classList.add('nora-ui-hydrated');
    }

    function openDrawer(which) {
        document.body.classList.toggle(`nora-${which}-open`);
        document.body.classList.remove(which === 'rail' ? 'nora-panel-open' : 'nora-rail-open');
    }

    function closeDrawers() {
        document.body.classList.remove('nora-rail-open', 'nora-panel-open');
    }

    function prepareShell() {
        try {
            buildLayout();
            document.body.classList.add('nora-shell-ready');
        } catch (error) {
            console.error('[Nora UI] Failed to build the early application shell', error);
            throw error;
        }
    }

    return Object.freeze({ removeNestedLayoutCopies, buildLayout, bindLayoutEvents, openDrawer, closeDrawers, prepareShell });
}
