// Original World Visuals schema, consumed by the current World Core and Nora UI.
export const THEME_COLORS = Object.freeze({ accent: '--nora-brand', background: '--nora-bg', surface: '--nora-surface', text: '--nora-ink', secondary_text: '--nora-ink-2', muted: '--nora-muted', border: '--nora-line', user_message: '--nora-user-bg', overlay: '--world-overlay' });
export const THEME_FONTS = Object.freeze({ default: '-apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif', literary: '"Songti SC", "Noto Serif SC", Georgia, serif', modern: '"PingFang SC", "Microsoft YaHei", Arial, sans-serif', classic: '"Noto Serif SC", "Songti SC", "Times New Roman", serif', typewriter: 'ui-monospace, "SFMono-Regular", Consolas, monospace' });
const positions = ['center', 'top', 'bottom', 'left', 'right', 'left top', 'left bottom', 'right top', 'right bottom'];
const enums = { font: Object.keys(THEME_FONTS), narration_font: Object.keys(THEME_FONTS), background_position: positions, background_position_mobile: positions, background_fit: ['cover', 'contain'], background_fit_mobile: ['cover', 'contain'], reading_surface: ['plain', 'glass', 'solid'] };
const assets = ['background', 'background_desktop', 'background_mobile'];
const fail = message => { throw Object.assign(new Error(message), { code: 'NORA_WORLD_THEME_INVALID' }); };
function object(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('Unsupported World theme fields.');
}
export function normalizeWorldTheme(value = {}) {
    object(value, ['version', 'theme', 'assets']);
    if (value.version !== undefined && value.version !== 1) fail('Only World theme version 1 is supported.');
    const theme = value.theme ?? {}; const images = value.assets ?? {};
    object(theme, [...Object.keys(THEME_COLORS), ...Object.keys(enums), 'content_width']);
    object(images, assets);
    const result = { version: 1, theme: {}, assets: {} };
    for (const [key, field] of Object.entries(theme)) {
        if (Object.hasOwn(THEME_COLORS, key)) {
            if (typeof field !== 'string' || !/^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(field)) fail(`Invalid color: ${key}`);
        } else if (key === 'content_width') {
            if (!Number.isInteger(field) || field < 360 || field > 760) fail('content_width must be 360–760 pixels.');
        } else if (!enums[key].includes(field)) fail(`Invalid theme value: ${key}`);
        result.theme[key] = field;
    }
    for (const [key, field] of Object.entries(images)) {
        if (typeof field !== 'string' || field.length > 2048) fail('Invalid background URL.');
        // Local paths are one encoded ST background filename. Remote URLs are displayed by the browser, never fetched by this validator.
        if (field.startsWith('/backgrounds/')) {
            let name; try { name = decodeURIComponent(field.slice(13)); } catch { fail('Invalid background filename.'); }
            if (!name || /[/\\\x00-\x1f?#]/.test(name) || !/\.(png|jpe?g|webp|gif|avif)$/i.test(name)) fail('Invalid background filename.');
            result.assets[key] = `/backgrounds/${encodeURIComponent(name)}`;
        } else {
            let url; try { url = new URL(field); } catch { fail('Use an imported /backgrounds/ URL or HTTPS image URL.'); }
            if (url.protocol !== 'https:' || url.username || url.password) fail('Use a credential-free HTTPS background URL.');
            result.assets[key] = url.href;
        }
    }
    return result;
}
export function worldThemeCatalog() {
    return { version: 1, scope: 'world', colors: Object.keys(THEME_COLORS), enums, content_width: { min: 360, max: 760 }, assets,
        replacement: 'apply replaces the full ui object; inspect and preserve omitted fields when making a partial user change; clear restores default styling',
        boundaries: 'Existing story stage and right panel only; world rail, controls, prompts, cards and iframe internals are unchanged.' };
}
export function projectWorldTheme(value) {
    const { theme, assets } = normalizeWorldTheme(value);
    const properties = {};
    for (const [key, css] of Object.entries(THEME_COLORS)) if (theme[key]) properties[css] = theme[key];
    if (theme.accent) { properties['--nora-brand-ink'] = theme.accent; properties['--nora-brand-tint'] = `color-mix(in srgb, ${theme.accent} 12%, transparent)`; }
    if (theme.border) properties['--nora-line-2'] = theme.border;
    if (theme.font) { properties['--nora-sans'] = THEME_FONTS[theme.font]; properties['--world-font'] = THEME_FONTS[theme.font]; }
    if (theme.narration_font) properties['--world-narration-font'] = THEME_FONTS[theme.narration_font];
    if (theme.content_width) properties['--nora-content'] = `${theme.content_width}px`;
    const desktop = assets.background_desktop || assets.background || assets.background_mobile;
    const mobile = assets.background_mobile || desktop;
    if (desktop) properties['--world-image'] = `url(${JSON.stringify(desktop)})`;
    if (mobile) properties['--world-image-mobile'] = `url(${JSON.stringify(mobile)})`;
    if (theme.background_position) properties['--world-position'] = theme.background_position;
    if (theme.background_fit) properties['--world-fit'] = theme.background_fit;
    if (theme.background_position_mobile) properties['--world-position-mobile'] = theme.background_position_mobile;
    if (theme.background_fit_mobile) properties['--world-fit-mobile'] = theme.background_fit_mobile;
    return { properties, readingSurface: theme.reading_surface || 'plain' };
}
