import { translate as tr } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
const FORMATS = Object.freeze({
    dialogue: ['“', '”'],
    action: ['*', '*'],
    emphasis: ['**', '**'],
});

/** A text edit only: sending, prompt construction and ST rendering stay native. */
export function getFormatEdit(value, start, end, format) {
    const markers = FORMATS[format];
    if (!markers) throw new TypeError('Unknown composer format: ' + format);
    const [open, close] = markers;
    start = Math.max(0, Math.min(value.length, start));
    end = Math.max(start, Math.min(value.length, end));
    const selected = value.slice(start, end);
    const exactStarBoundary = (left, right) => format === 'dialogue'
        || (value[left - 1] !== '*' && value[right] !== '*');

    if (start >= open.length && value.slice(start - open.length, start) === open
        && value.slice(end, end + close.length) === close
        && exactStarBoundary(start - open.length, end + close.length)) {
        return { start: start - open.length, end: end + close.length, text: selected,
            selectionStart: start - open.length, selectionEnd: end - open.length };
    }
    if (selected.length >= open.length + close.length && selected.startsWith(open) && selected.endsWith(close)
        && (format === 'dialogue' || (selected[open.length] !== '*' && selected[selected.length - close.length - 1] !== '*'))
        && exactStarBoundary(start, end)) {
        const text = selected.slice(open.length, -close.length);
        return { start, end, text, selectionStart: start, selectionEnd: start + text.length };
    }
    // Keep spaces outside Markdown delimiters so ST can parse the emphasis.
    const leading = selected.match(/^\s*/)[0];
    const trailing = selected.slice(leading.length).match(/\s*$/)[0];
    const content = selected.slice(leading.length, selected.length - trailing.length);
    const text = leading + open + content + close + trailing;
    const selectionStart = start + leading.length + open.length;
    return { start, end, text, selectionStart, selectionEnd: selectionStart + content.length };
}

export function createComposerFormatController({ document: doc = document } = {}) {
    let binding;

    function mount(root = doc) {
        const trigger = root.querySelector('#nora-action');
        const input = root.querySelector('#nora-input');
        if (!trigger || !input) return;
        if (binding?.trigger === trigger && binding?.input === input) return;
        binding?.dispose();

        const control = trigger.parentElement;
        const menu = doc.createElement('div');
        menu.id = 'nora-format-menu';
        menu.className = 'nora-format-menu';
        menu.hidden = true;
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', tr("文字格式"));
        menu.innerHTML = `<div class="nora-format-title" role="presentation">${tr("文字格式")}</div>`
            + `<button type="button" role="menuitem" tabindex="-1" data-nora-format="dialogue"><span>${tr("对白")}</span><q>${tr("你来了。")}</q></button>`
            + `<button type="button" role="menuitem" tabindex="-1" data-nora-format="action"><span>${tr("动作")}</span><em>${tr("轻轻推开门。")}</em></button>`
            + `<button type="button" role="menuitem" tabindex="-1" data-nora-format="emphasis"><span>${tr("强调")}</span><strong>${tr("别走。")}</strong></button>`
            + `<div class="nora-format-hint" role="presentation">${tr("选中文字可设置格式")}</div>`;
        control.append(menu);
        trigger.disabled = false;
        const items = Array.from(menu.querySelectorAll('[data-nora-format]'));
        const listeners = [];
        const on = (target, name, handler, options) => {
            target.addEventListener(name, handler, options);
            listeners.push(() => target.removeEventListener(name, handler, options));
        };
        let selection;
        let composing = false;
        const remember = () => {
            selection = { value: input.value, start: input.selectionStart, end: input.selectionEnd };
        };
        const close = (focusTrigger = false) => {
            menu.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
            if (focusTrigger) trigger.focus({ preventScroll: true });
        };
        const open = (keyboard = false, last = false) => {
            if (input.disabled || input.readOnly || composing) return;
            remember();
            menu.hidden = false;
            trigger.setAttribute('aria-expanded', 'true');
            if (keyboard) items[last ? items.length - 1 : 0].focus({ preventScroll: true });
        };
        on(trigger, 'pointerdown', event => {
            if (event.button !== 0) return;
            remember();
            // Preserve the textarea selection and the mobile keyboard.
            event.preventDefault();
        });
        on(trigger, 'click', event => {
            if (menu.hidden) open(event.detail === 0);
            else close();
        });
        on(trigger, 'keydown', event => {
            if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
            event.preventDefault();
            open(true, event.key === 'ArrowUp');
        });
        on(menu, 'pointerdown', event => {
            if (event.button === 0) event.preventDefault();
        });
        on(menu, 'click', event => {
            const item = event.target.closest('[data-nora-format]');
            if (!item || !menu.contains(item) || menu.hidden) return;
            if (!selection || input.value !== selection.value || input.disabled || input.readOnly || composing) {
                close();
                return;
            }
            const edit = getFormatEdit(input.value, selection.start, selection.end, item.dataset.noraFormat);
            input.setRangeText(edit.text, edit.start, edit.end, 'end');
            input.setSelectionRange(edit.selectionStart, edit.selectionEnd);
            close();
            input.focus({ preventScroll: true });
            input.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
        });
        on(menu, 'keydown', event => {
            const index = items.indexOf(doc.activeElement);
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
                    : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
                items[next].focus({ preventScroll: true });
            } else if (event.key === 'Tab') {
                event.preventDefault();
                close();
                (event.shiftKey ? trigger : input).focus({ preventScroll: true });
            }
        });
        on(doc, 'keydown', event => {
            if (event.key === 'Escape' && !menu.hidden) {
                event.preventDefault();
                event.stopPropagation();
                close(true);
            }
        }, true);
        on(doc, 'pointerdown', event => {
            if (!menu.hidden && !control.contains(event.target)) close();
        }, true);
        on(doc, 'focusin', event => {
            if (!menu.hidden && !control.contains(event.target)) close();
        });
        on(input, 'input', () => close());
        on(input, 'keydown', event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) close();
        });
        on(input, 'compositionstart', () => { composing = true; close(); });
        on(input, 'compositionend', () => { composing = false; });
        binding = { trigger, input, dispose() {
            close();
            listeners.forEach(remove => remove());
            menu.remove();
        } };
    }

    return Object.freeze({ mount });
}
