"use strict";
const $ = (s) => document.querySelector(s);
const t = I18N.t;  // 文案一律走 i18n.js 的 STRINGS(locale contract,liveware-frontend §i18n)
const state = { cards: [], libraryCards: [], cardMap: {}, worldbooks: {}, libraryWorldbooks: [], productions: [], activeId: null, active: null,
  agentUserId: "", models: null, tts: null, busy: false, pendingSend: null, stick: true, _anchor: null,
  persona: {}, _foldChar: true, _foldLore: true, _editPersona: false, _editCast: false, _editLore: false };
const { escapeHtml: esc, element: el } = TavernUI;

function fmt(s) {
  const codes = [];
  let html = esc(s).replace(/`([^`]+)`/g, (_, code) => {
    const i = codes.push(`<code>${code}</code>`) - 1;
    return `@@CODE${i}@@`;
  });
  html = html.replace(/\*([^*]+)\*/g, '<span class="nar">$1</span>');
  return html.replace(/@@CODE(\d+)@@/g, (_, i) => codes[Number(i)] || "");
}
function loc(obj, field) {
  if (!obj || typeof obj !== "object") return obj && obj[field];
  const lang = I18N.lang === "zh" ? "zh" : "en";
  const pack = obj.i18n && obj.i18n[lang];
  let value = null;
  if (pack && pack[field] !== undefined && pack[field] !== null && String(pack[field]).trim() !== "") value = pack[field];
  else {
    const zh = obj.i18n && obj.i18n.zh;
    if (I18N.lang === "zh" && zh && zh[field]) value = zh[field];
    else value = obj[field];
  }
  return I18N.renderName ? I18N.renderName(value) : value;
}

const WORLD_THEME_PROPERTIES = [
  "--world-accent", "--world-bg", "--world-surface", "--world-ink",
  "--world-ink2", "--world-muted", "--world-line", "--world-userbg",
  "--world-overlay", "--world-body-font", "--world-narration-font",
  "--world-content-width", "--world-background-image-desktop", "--world-background-image-mobile",
  "--world-background-position", "--world-background-position-mobile",
  "--world-background-fit", "--world-background-fit-mobile",
];
const WORLD_THEME_COLORS = {
  accent: "--world-accent", background: "--world-bg", surface: "--world-surface",
  text: "--world-ink", secondary_text: "--world-ink2", muted: "--world-muted",
  border: "--world-line", user_message: "--world-userbg", overlay: "--world-overlay",
};
const WORLD_FONT_PRESETS = {
  default: "var(--sans)",
  literary: "var(--serif)",
  modern: "var(--sans)",
  classic: '"Songti SC","Noto Serif SC",Georgia,"Times New Roman",serif',
  typewriter: '"SFMono-Regular",Consolas,"Liberation Mono",monospace',
};
const WORLD_COLOR_RE = /^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8})$/;
const WORLD_POSITIONS = new Set(["center", "top", "bottom", "left", "right", "left top", "left bottom", "right top", "right bottom"]);
const WORLD_FITS = new Set(["cover", "contain"]);
const WORLD_READING_SURFACES = new Set(["plain", "glass", "solid"]);

function safeWorldAsset(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 2048 || raw.startsWith("//")) return "";
  try {
    const url = new URL(raw, location.origin);
    if (raw.startsWith("/world-assets/") || raw.startsWith("/assets/")) {
      return `${url.pathname}${url.search}`;
    }
    return url.protocol === "https:" ? url.href : "";
  } catch (_) { return ""; }
}

function applyWorldTheme(production) {
  const stage = $("#stage");
  if (!stage) return;
  const panel = $("#panel");
  const targets = [stage, panel].filter(Boolean);
  const root = document.documentElement;
  root.style.removeProperty("--app-safe-bg");
  targets.forEach((target) => {
    WORLD_THEME_PROPERTIES.forEach((property) => target.style.removeProperty(property));
  });

  const ui = production && production.ui;
  const theme = ui && ui.version === 1 && ui.theme && typeof ui.theme === "object" ? ui.theme : {};
  const assets = ui && ui.version === 1 && ui.assets && typeof ui.assets === "object" ? ui.assets : {};

  Object.entries(WORLD_THEME_COLORS).forEach(([field, property]) => {
    const color = String(theme[field] || "").trim();
    if (WORLD_COLOR_RE.test(color)) targets.forEach((target) => target.style.setProperty(property, color));
  });
  const themeBackground = String(theme.background || "").trim();
  const safeBackground = WORLD_COLOR_RE.test(themeBackground)
    ? themeBackground
    : getComputedStyle(document.body).backgroundColor;
  root.style.setProperty("--app-safe-bg", safeBackground);
  let themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (!themeColorMeta) {
    themeColorMeta = document.createElement("meta");
    themeColorMeta.name = "theme-color";
    document.head.appendChild(themeColorMeta);
  }
  themeColorMeta.content = safeBackground;
  if (WORLD_FONT_PRESETS[theme.font]) {
    targets.forEach((target) => target.style.setProperty("--world-body-font", WORLD_FONT_PRESETS[theme.font]));
  }
  if (WORLD_FONT_PRESETS[theme.narration_font]) {
    targets.forEach((target) => target.style.setProperty("--world-narration-font", WORLD_FONT_PRESETS[theme.narration_font]));
  }

  const width = Number(theme.content_width);
  if (Number.isInteger(width) && width >= 360 && width <= 760) {
    stage.style.setProperty("--world-content-width", `${width}px`);
  }
  const position = String(theme.background_position || "").trim().toLowerCase();
  if (WORLD_POSITIONS.has(position)) stage.style.setProperty("--world-background-position", position);
  const fit = String(theme.background_fit || "").trim().toLowerCase();
  if (WORLD_FITS.has(fit)) stage.style.setProperty("--world-background-fit", fit);
  const mobilePosition = String(theme.background_position_mobile || "").trim().toLowerCase();
  if (WORLD_POSITIONS.has(mobilePosition)) stage.style.setProperty("--world-background-position-mobile", mobilePosition);
  const mobileFit = String(theme.background_fit_mobile || "").trim().toLowerCase();
  if (WORLD_FITS.has(mobileFit)) stage.style.setProperty("--world-background-fit-mobile", mobileFit);

  const fallbackBackground = safeWorldAsset(assets.background);
  const desktopBackground = safeWorldAsset(assets.background_desktop) || fallbackBackground || safeWorldAsset(assets.background_mobile);
  const mobileBackground = safeWorldAsset(assets.background_mobile) || fallbackBackground || desktopBackground;
  if (desktopBackground) stage.style.setProperty("--world-background-image-desktop", `url(${JSON.stringify(desktopBackground)})`);
  if (mobileBackground) stage.style.setProperty("--world-background-image-mobile", `url(${JSON.stringify(mobileBackground)})`);
  const hasBackground = Boolean(desktopBackground || mobileBackground);
  const themed = Boolean(Object.keys(theme).length || hasBackground);
  targets.forEach((target) => target.classList.toggle("worldThemed", themed));
  const readingSurface = WORLD_READING_SURFACES.has(theme.reading_surface) ? theme.reading_surface : "plain";
  stage.classList.toggle("worldReadingGlass", hasBackground && readingSurface === "glass");
  stage.classList.toggle("worldReadingSolid", hasBackground && readingSurface === "solid");
}

function toast(msg) { const box = $("#toast"); box.textContent = msg; box.classList.remove("hidden"); clearTimeout(box._h); box._h = setTimeout(() => box.classList.add("hidden"), 2600); }
// 内联图标(reader 不挂图标字体)——细描边,克制。
const TRASH_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';
const PENCIL_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>';
const PLUS_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const CHAT_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H4l2.5-2.5A8 8 0 1 1 21 12z"/></svg>';
const CARD_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="11" r="2"/><path d="M6.5 16c.5-1.6 1.5-2.4 2.5-2.4s2 .8 2.5 2.4M15 10h3.5M15 13.5h3.5"/></svg>';
const WORLD_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg>';
const SEND_SVG = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V5M6 11l6-6 6 6"/></svg>';
const STOP_SVG = '<svg viewBox="0 0 24 24" width="15" height="15"><rect x="6.5" y="6.5" width="11" height="11" rx="2.6" fill="currentColor"/></svg>';
const SLIDERS_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8h9M20 8h0M4 16h1M12 16h8"/><circle cx="16" cy="8" r="2.2"/><circle cx="8" cy="16" r="2.2"/></svg>';
const SPEAKER_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12"/></svg>';
const USER_PLUS_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 19a6 6 0 0 0-12 0"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M16 11h6"/></svg>';
const CLAWCHAT_OFFICIAL_DEVELOPER_ID = "usr_01KQE596Y0FSMVTPQKW48SKXRF";
const PAUSE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const speechState = { audio: null, button: null, url: "", controller: null };

async function loadIdentity() {
  try {
    const identity = await bridge.get("/api/identity");
    I18N.setIdentity(identity);
    state.agentUserId = identity.agent_user_id || "";
  }
  catch (_) {}
}

// 对话轮数 = 用户出手数(first_mes 是 char 开场,不算)。最近活跃 = story 末条时间。
function countTurns(story) { return (story || []).filter((m) => m.role === "user").length; }
function productionTurns(p) {
  const projected = Number(p && p.turn_count);
  return Number.isFinite(projected) ? projected : countTurns(p && p.story);
}
// 剧组的「最近动静」时间戳 = max(创建, 最新一条消息)——既是「最近活跃」文案的数据源,
// 也是 rail 排序键(聊天列表式:最近的在最上,反馈 2026-07-02)。
function lastTs(p) {
  const projected = Number(p && p.last_ts);
  if (Number.isFinite(projected) && projected > 0) return projected;
  let last = p.created_at || 0;
  (p.story || []).forEach((m) => { if (m.ts && m.ts > last) last = m.ts; });
  return last;
}
function productionCardIds(p) {
  const ids = (p && Array.isArray(p.card_ids) && p.card_ids.length) ? p.card_ids : (p && p.card_id ? [p.card_id] : []);
  return [...new Set(ids.filter(Boolean))];
}
function productionCards(p) {
  if (p && Array.isArray(p.cards)) return p.cards.filter(Boolean);
  return productionCardIds(p).map((id) => state.cardMap[id]).filter(Boolean);
}
function lastActivity(p) {
  const last = lastTs(p);
  return last ? relTime(last) : "";
}
function relTime(ts) {
  const d = Math.max(0, Date.now() / 1000 - ts);
  if (d < 60) return t("justNow");
  if (d < 3600) return t("minAgo", { n: Math.floor(d / 60) });
  if (d < 86400) return t("hourAgo", { n: Math.floor(d / 3600) });
  if (d < 172800) return t("yesterday");
  if (d < 86400 * 8) return t("dayAgo", { n: Math.floor(d / 86400) });
  const dt = new Date(ts * 1000);
  return t("monthDay", { m: dt.getMonth() + 1, d: dt.getDate() });
}
function fmtDuration(ms) {
  const sec = Math.max(0, ms || 0) / 1000;
  return sec < 60 ? sec.toFixed(sec < 10 ? 1 : 0) + "s" : Math.floor(sec / 60) + "m " + Math.round(sec % 60) + "s";
}
function attachGenMs(msg, startedAt) {
  if (msg && startedAt) msg.gen_ms = Math.max(0, Date.now() - startedAt);
  return msg;
}

const stateSyncWatchers = new Map();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function applyStateProjection(result) {
  const production = state.productions.find((item) => item.id === result.production_id);
  if (!production) return;
  production.runtime_cast = result.runtime_cast || production.runtime_cast;
  production.cards = Array.isArray(result.cards) ? result.cards : production.cards;
  production.persona = result.persona || production.persona;
  // 同步更新全局 cardMap，确保编辑/详情面板也能拿到最新卡片
  if (Array.isArray(result.cards)) {
    result.cards.forEach((c) => { if (c && c.id) state.cardMap[c.id] = c; });
  }
  if (state.activeId !== production.id) return;
  state.active = production;
  state.persona = production.persona || {};
  if (!state._editPersona && !state._editCast && !state._editLore) renderPanel();
}

function watchStateSync(meta, productionId) {
  if (!meta || !meta.watch || !productionId) return;
  const token = Symbol(productionId);
  const since = Number(meta.revision || 0);
  stateSyncWatchers.set(productionId, token);
  void (async () => {
    const deadline = Date.now() + 300000;
    let failures = 0;
    let idle = 0;
    let delayMs = 1000;
    while (Date.now() < deadline && stateSyncWatchers.get(productionId) === token) {
      await wait(delayMs);
      try {
        const result = await bridge.get(`/api/production/state-sync?production_id=${encodeURIComponent(productionId)}&since=${since}`);
        failures = 0;
        delayMs = Math.min(delayMs * 2, 10000);
        if (result.ready) {
          applyStateProjection(result);
          break;
        }
        if (result.error) break;
        if (result.pending) {
          idle = 0;
          continue;
        }
        if (result.due && ++idle < 5) continue;
        break;
      } catch (_) {
        delayMs = Math.min(delayMs * 2, 10000);
        if (++failures >= 5) break;
      }
    }
  })().finally(() => {
    if (stateSyncWatchers.get(productionId) === token) stateSyncWatchers.delete(productionId);
  });
}

async function loadAll() {
  const [pr, cr, wr, lwr, mr, tr] = await Promise.all([
    bridge.get("/api/productions?summary=1"), bridge.get("/api/cards"), bridge.get("/api/worldbooks"),
    bridge.get("/api/library/worldbooks"),
    bridge.get("/api/models"),
    bridge.get("/api/tts/config"),
  ]);
  state.productions = pr.productions || [];
  state.cards = cr.cards || [];
  state.libraryCards = state.cards;
  state.cardMap = {}; state.cards.forEach((c) => (state.cardMap[c.id] = c));
  state.worldbooks = {}; (wr.worldbooks || []).forEach((w) => (state.worldbooks[w.id] = w));
  state.libraryWorldbooks = lwr.worldbooks || [];
  // 大模型配置(脱敏列表);旧 server 没这端点 → 兜一个只有内置模型的默认,面板不裸奔
  state.models = (mr && mr.configs) ? mr
    : { configs: [{ id: "builtin", builtin: true }], active: "builtin" };
  state.tts = (tr && Array.isArray(tr.voices)) ? tr
    : { model: "clawling/qwen-tts", model_name: "Qwen TTS", active_voice: "vivian", active_clone_id: "", mode: "preset", voices: [], preset_settings: {}, clones: [], clone: {} };
  state.activeId = pr.active || (state.productions[0] && state.productions[0].id) || null;
  state.active = null;
  if (state.activeId) {
    try {
      const detail = await bridge.get(`/api/production?production_id=${encodeURIComponent(state.activeId)}`);
      state.active = detail.production || null;
    } catch (_) {
      const fallbackId = state.productions[0]?.id || null;
      if (fallbackId && fallbackId !== state.activeId) {
        state.activeId = fallbackId;
        try {
          const detail = await bridge.get(`/api/production?production_id=${encodeURIComponent(fallbackId)}`);
          state.active = detail.production || null;
        } catch (_) { state.active = null; }
      }
    }
    const activeIndex = state.productions.findIndex((p) => p.id === state.activeId);
    if (activeIndex >= 0 && state.active) state.productions[activeIndex] = state.active;
  }
  state.persona = (state.active && state.active.persona) || {};
  applyWorldTheme(state.active);
  renderRail(); renderStage(); renderPanel();
}

function renderRail() {
  const ul = $("#prodList");
  // 最近动静倒序(新建/刚演过的浮顶)——每次渲染现排,发送/导入后重渲即自动上浮
  const prods = [...state.productions].sort((a, b) => lastTs(b) - lastTs(a));
  ul.innerHTML = prods.map((p) => {
    const turns = productionTurns(p);
    const meta = [turns > 0 ? t("turnsShort", { n: turns }) : t("newPlay"), lastActivity(p)].filter(Boolean).join(" · ");
    return `<li class="prodItem ${p.id === state.activeId ? "active" : ""}" data-id="${p.id}">
      <div class="prodName2">${esc(loc(p, "name") || p.name)}</div>
      <div class="prodMeta">${esc(meta)}</div>
      <button class="prodDel" data-del="${p.id}" aria-label="${esc(t("deleteProd"))}" title="${esc(t("deleteProd"))}">${TRASH_SVG}</button>
    </li>`;
  }).join("");
  ul.querySelectorAll(".prodItem").forEach((li) =>
    li.onclick = () => switchProd(li.dataset.id));
  // 删除 = 看得见可点的 trash(桌面 hover 浮出 / 触屏常驻),tap → 二次确认。无原生长按手势。
  ul.querySelectorAll(".prodDel").forEach((b) =>
    b.onclick = (e) => { e.stopPropagation(); askDeleteProduction(b.dataset.del); });
}

function renderStage() {
  stopSpeech();
  const p = state.active;
  const prodNameEl = $("#prodName");
  if (prodNameEl) prodNameEl.textContent = p ? (loc(p, "name") || p.name) : t("appTitle");
  const prodSubEl = $("#prodSub");
  if (prodSubEl) prodSubEl.textContent = "";
  $("#composer").classList.toggle("hidden", !p);  // 没开戏没处发:空态收掉输入框,导入引导是唯一动作
  const c = $("#convo");
  if (!p) {
    c.innerHTML = `<div class="empty"><div class="emptyMark">✦</div><p>${esc(t("emptyLead"))}</p><p class="hint">${esc(t("emptyHint"))}</p></div>`;
    requestAnimationFrame(() => historyNavigator.sync());
    return;
  }
  const visible = p.story || [];
  const lastUserIdx = lastUserIndex(visible);
  const turns = visible.map((m, i) => turnHtml(m, i === visible.length - 1, i >= lastUserIdx)).join("");
  c.innerHTML = `<div class="thread">${turns}</div>`;
  bindCtls();
  scrollDown();
  requestAnimationFrame(() => historyNavigator.sync());
}

function lastUserIndex(story) {
  if (!Array.isArray(story) || !story.length) return 0;
  for (let i = story.length - 1; i >= 0; i--) {
    if (story[i]?.role === "user") return i;
  }
  return Math.max(0, story.length - 1);
}

function turnHtml(m, isLast, canEdit) {
  if (m.role === "user") {
    const edit = canEdit ? `<div class="ctl"><button data-act="edit">${esc(t("edit"))}</button></div>` : "";
    return `<div class="turn user" data-id="${m.id}">
      <div class="body">${fmt(loc(m, "text") || m.text)}</div>
      ${edit}</div>`;
  }
  // swipe 备选回复:char 消息持有 alts[]/active_alt(非破坏性,conversation-surface §3.1)
  const alts = Array.isArray(m.alts) ? m.alts.length : 0;
  const active = m.active_alt || 0;
  const swipe = alts > 1
    ? `<span class="swipe">
         <button data-act="swl" aria-label="${esc(t("ariaPrev"))}" ${active === 0 ? "disabled" : ""}>‹</button>
         <span class="idx">${active + 1}/${alts}</span>
         <button data-act="swr" aria-label="${esc(t("ariaNext"))}" ${active === alts - 1 ? "disabled" : ""}>›</button>
       </span>` : "";
  // 重生成只挂最后一条 char(服务端只重演 story 末条;挂别处会重生成错的那条)
  const regen = isLast ? `<button data-act="regen">${esc(t("regen"))}</button>` : "";
  const cont = isLast ? `<button data-act="cont">${esc(t("cont"))}</button>` : "";
  const sugg = isLast ? `<button data-act="suggest">${esc(t("suggest"))}</button>` : "";
  const meta = m.gen_ms ? `<span class="genTime">${esc(t("genTime", { s: fmtDuration(m.gen_ms) }))}</span>` : "";
  const speak = m._temp ? "" : `<button class="speakBtn" data-act="speak" aria-label="${esc(t("voicePlay"))}" title="${esc(t("voicePlay"))}">${SPEAKER_SVG}</button>`;
  return `<div class="turn char ${m._temp ? "temp" : ""}" data-id="${m.id || ""}">
    <div class="body">${fmt(loc(m, "text") || m.text)}</div>
    <div class="ctl">${meta}${speak}${swipe}${regen}${cont}${sugg}${canEdit ? `<button data-act="edit">${esc(t("edit"))}</button>` : ""}</div></div>`;
}

function bindCtls() {
  document.querySelectorAll('.ctl [data-act="regen"]').forEach((b) =>
    b.onclick = (e) => regenerate(e.currentTarget));
  document.querySelectorAll('.ctl [data-act="edit"]').forEach((b) =>
    b.onclick = (e) => editMsg(e.target.closest(".turn").dataset.id));
  document.querySelectorAll('.ctl [data-act="cont"]').forEach((b) =>
    b.onclick = (e) => doContinue(e.currentTarget));
  document.querySelectorAll('.ctl [data-act="suggest"]').forEach((b) =>
    b.onclick = (e) => doSuggest(e.currentTarget));
  document.querySelectorAll('.ctl [data-act="speak"]').forEach((b) =>
    b.onclick = (e) => toggleSpeech(e.currentTarget));
  document.querySelectorAll('.ctl [data-act="swl"]').forEach((b) =>
    b.onclick = (e) => swipe(e.target.closest(".turn").dataset.id, -1));
  document.querySelectorAll('.ctl [data-act="swr"]').forEach((b) =>
    b.onclick = (e) => swipe(e.target.closest(".turn").dataset.id, 1));
}

function stopSpeech() {
  speechState.controller?.abort();
  speechState.controller = null;
  if (speechState.audio) {
    speechState.audio.onended = null;
    speechState.audio.onerror = null;
    speechState.audio.pause();
    speechState.audio.src = "";
  }
  if (speechState.url) URL.revokeObjectURL(speechState.url);
  if (speechState.button?.isConnected) {
    speechState.button.innerHTML = SPEAKER_SVG;
    speechState.button.classList.remove("playing", "busy");
    speechState.button.disabled = false;
    speechState.button.setAttribute("aria-label", t("voicePlay"));
    speechState.button.title = t("voicePlay");
  }
  speechState.audio = null;
  speechState.button = null;
  speechState.url = "";
}

async function toggleSpeech(btn) {
  if (speechState.button === btn && speechState.audio) {
    if (speechState.audio.paused) {
      await speechState.audio.play();
      btn.innerHTML = PAUSE_SVG;
      btn.classList.add("playing");
      btn.setAttribute("aria-label", t("voicePause"));
      btn.title = t("voicePause");
    } else {
      speechState.audio.pause();
      btn.innerHTML = SPEAKER_SVG;
      btn.classList.remove("playing");
      btn.setAttribute("aria-label", t("voicePlay"));
      btn.title = t("voicePlay");
    }
    return;
  }

  const id = btn.closest(".turn")?.dataset.id;
  const message = state.active?.story?.find((item) => String(item.id || "") === String(id || ""));
  const text = loc(message, "text") || message?.text || "";
  if (!text.trim()) return;

  stopSpeech();
  const controller = new AbortController();
  speechState.button = btn;
  speechState.controller = controller;
  btn.disabled = true;
  btn.classList.add("busy");
  btn.setAttribute("aria-label", t("voiceLoading"));
  btn.title = t("voiceLoading");
  try {
    const blob = await bridge.speech(text, controller.signal);
    if (speechState.controller !== controller) return;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    speechState.audio = audio;
    speechState.url = url;
    speechState.controller = null;
    btn.disabled = false;
    btn.classList.remove("busy");
    btn.innerHTML = PAUSE_SVG;
    btn.classList.add("playing");
    btn.setAttribute("aria-label", t("voicePause"));
    btn.title = t("voicePause");
    audio.onended = stopSpeech;
    audio.onerror = () => { stopSpeech(); toast(t("voiceFailed", { err: "audio playback" })); };
    try {
      await audio.play();
    } catch (playError) {
      // Some mobile WebViews expire the original click activation while TTS is
      // being generated. Keep the prepared audio so the next tap plays it.
      if (playError.name === "NotAllowedError") {
        btn.innerHTML = SPEAKER_SVG;
        btn.classList.remove("playing");
        btn.setAttribute("aria-label", t("voicePlay"));
        btn.title = t("voicePlay");
        return;
      }
      throw playError;
    }
  } catch (e) {
    if (e.name !== "AbortError") toast(t("voiceFailed", { err: e.message }));
    stopSpeech();
  }
}

// 角色卡来源/出处(Task 2):有 creator(卡作者)显作者;Agent 原创(import_card_json)显「Agent 创作」。
function provenanceHtml(card) {
  const creator = (card.creator || "").trim();
  const src = card.source || "";
  if (creator) return `<div class="prov">${WORLD_SVG}${esc(t("provSource", { name: creator }))}</div>`;
  if (src === "agent") return `<div class="prov"><span style="color:var(--brand)">✦</span>${esc(t("provAgent"))}</div>`;
  if (src === "chub") return `<div class="prov">${WORLD_SVG}${esc(t("provSource", { name: "Chub" }))}</div>`;
  return "";
}

function castProfile(card) {
  const p = (card && card.profile) || {};
  return {
    identity: p.identity || { name: card?.name || "", description: card?.description || "" },
    appearance: p.appearance || {},
    personality: p.personality || { summary: card?.personality || "" },
    expression: p.expression || {},
    capabilities: p.capabilities || {},
    background: p.background || {},
  };
}

function castSummary(card) {
  const p = castProfile(card);
  const brief = (value, limit = 72) => {
    const text = String(value || "").split(/\n+/).map((line) => line.replace(/^\s*[-*•·]\s*/, "").trim()).find(Boolean) || "";
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  };
  const identity = brief([p.identity.occupation, p.identity.story_role].filter(Boolean).join(" · ")
    || p.identity.description || "");
  const traits = Array.isArray(p.personality.traits) && p.personality.traits.length
    ? p.personality.traits.slice(0, 3).join(" · ") : brief(p.personality.summary || "");
  const relations = Array.isArray(card.relationships) ? card.relationships.filter(Boolean) : [];
  return { identity, traits, relations: relations.join("；") };
}

function profileRows(card, includeSource = false) {
  const p = castProfile(card);
  const status = card.persistent_status || {};
  const rows = [];
  const list = (value) => Array.isArray(value) ? value.filter(Boolean).join("；") : (value || "");
  const add = (label, value) => { const text = list(value); if (String(text).trim()) rows.push([label, String(text).trim()]); };
  add(t("castFieldName"), p.identity.name || card.name);
  add(t("castFieldAliases"), p.identity.aliases);
  add(t("castFieldDescription"), p.identity.description || card.description);
  add(t("castFieldGender"), p.identity.gender);
  add(t("castFieldAge"), p.identity.age);
  add(t("castFieldSpecies"), p.identity.species);
  add(t("castFieldOccupation"), p.identity.occupation);
  add(t("castFieldAffiliations"), p.identity.affiliations);
  add(t("castFieldStoryRole"), p.identity.story_role);
  add(t("castFieldAppearance"), p.appearance.summary);
  add(t("castFieldFeatures"), p.appearance.features);
  add(t("castFieldAttire"), p.appearance.attire);
  add(t("castFieldTraits"), (Array.isArray(p.personality.traits) && p.personality.traits.length)
    ? p.personality.traits : (p.personality.summary || card.personality));
  add(t("castFieldValues"), p.personality.values);
  add(t("castFieldMotivation"), p.personality.motivation);
  add(t("castFieldFears"), p.personality.fears);
  add(t("castFieldBoundaries"), p.personality.boundaries);
  add(t("castFieldSpeech"), p.expression.speech_style);
  add(t("castFieldHabits"), p.expression.habits);
  add(t("castFieldMannerisms"), p.expression.mannerisms);
  add(t("castFieldSkills"), p.capabilities.skills);
  add(t("castFieldPowers"), p.capabilities.powers);
  add(t("castFieldLimitations"), p.capabilities.limitations);
  add(t("castFieldBackground"), p.background.summary);
  add(t("castFieldHistory"), p.background.key_history);
  add(t("castFieldLifeStatus"), status.life_status);
  add(t("castFieldPhysicalCondition"), status.physical_condition);
  add(t("castFieldRelationships"), card.relationships);
  const entry = card.entry || {};
  if (includeSource) {
    add(t("cardFieldFirstMes"), entry.first_message || card.first_mes);
    add(t("cardFieldCreator"), card.creator);
    add(t("cardFieldSource"), card.source);
    add(t("cardFieldTags"), card.tags);
  }
  return rows;
}

// 故事主理人小节收敛为两个入口：复盘深链与故事档案。
// 深链打开 ClawChat 中当前主理人的会话，故事档案在酒馆同源页内打开。
// 容器拦非同源导航 → openLinkExternally → in-app deep link;老版本 app 降级开资料页);
// &draft= 带「整理「世界名」这一场」预填进输入框(反馈 2026-07-02:给主理人定位关键字;
// 只填不发,发送权在用户)。必须是真 <a target="_blank"> 链接——移动容器只放行带手势的外部 LINK_ACTIVATED,
// JS 跳转/当前 WebView 内导航会被静默拦。② 主理人的故事档案 = 当前酒馆同源 /actor 页内直达。
function actorSectionHtml() {
  const draft = state.active
    ? t("reflectDraft", { name: state.active.name }) : t("reflectDraftNoPlay");
  const reflectHref = `clawchat://u/${encodeURIComponent(state.agentUserId || "")}?chat=1&draft=${encodeURIComponent(draft)}`;
  const reflectLink = state.agentUserId
    ? `<a class="pLink" href="${esc(reflectHref)}" target="_blank" rel="noopener external">${CHAT_SVG}${esc(t("reflectWithCurator"))}</a>`
    : "";  // 拿不到主理人的身份(本地 dev 无容器 config)→ 隐入口
  const actorHref = `/actor?from=console&return=${encodeURIComponent(location.origin + "/")}`;
  return `<div class="pSection actorSec">
    <div class="pHead">${esc(t("pActor"))}</div>
    ${reflectLink}
    <a class="pLink" href="${esc(actorHref)}">${CARD_SVG}${esc(t("curatorActorCard"))}</a>
  </div>`;
}

// 大模型小节(panel):只报当前在用的配置;管理(切/删)+教育(怎么加)走 sheet。model-config.md。
// 配置显示名:builtin 用本地化「内置模型」(server 的 name 字段是中文 canonical,给 CLI 用)
function modelDisplayName(c) { return c.name || c.model || t("modelBuiltin"); }

function officialDeveloperSectionHtml() {
  const href = `clawchat://u/${encodeURIComponent(CLAWCHAT_OFFICIAL_DEVELOPER_ID)}`;
  return `<div class="officialDeveloper">
    <a class="officialDeveloperLink" href="${esc(href)}" target="_blank" rel="noopener external">
      ${USER_PLUS_SVG}<span>${esc(t("officialDeveloper"))}</span>
    </a>
  </div>`;
}

function modelsSectionHtml() {
  const ms = state.models || { configs: [], active: "builtin" };
  const cur = ms.configs.find((c) => c.id === ms.active) || ms.configs[0]
    || { builtin: true, model: "" };
  const cfg = state.tts || {};
  const selectedVoice = (cfg.voices || []).find((voice) => voice.id === cfg.active_voice);
  const voiceName = cfg.mode === "clone"
    ? (cfg.clone?.name || t("voiceCloneDefaultName"))
    : (selectedVoice?.name || voiceDisplayName(cfg.active_voice));
  return `<div class="pSection modelSection">
    <div class="pHead">${esc(t("pModel"))}</div>
    <div class="modelGroup">
      <div class="modelUnit">
        <div class="modelUnitHead">${esc(t("pTextModel"))}</div>
        <p class="mdlCur">${esc(modelDisplayName(cur))}<span class="mdlModel">${esc(cur.model || "")}</span></p>
        <button class="actorMore" id="modelManage">${SLIDERS_SVG}${esc(t("modelManage"))}</button>
      </div>
      <div class="modelUnit">
        <div class="modelUnitHead">${esc(t("pVoiceModel"))}</div>
        <p class="mdlCur">${esc(cfg.model_name || "Qwen TTS")}<span class="mdlModel">${esc(voiceName)}</span></p>
        <button class="actorMore" id="voiceManage">${SLIDERS_SVG}${esc(t("voiceManage"))}</button>
      </div>
    </div>
  </div>`;
}

function voiceDisplayName(voice) {
  const id = typeof voice === "string" ? voice : voice?.id;
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : "";
}

function loreTriggerText(e) {
  const keys = Array.isArray(e.keys) ? e.keys.filter(Boolean) : [];
  if (e.constant || !keys.length) return t("pAlwaysOn");
  return t("loreTrigger", { keys: keys.join("、") });
}

async function deleteLoreEntry(ref) {
  if (!state.active || !ref) return;
  const ok = await confirmDialog({ title: t("loreDeleteTitle"), body: t("loreDeleteBody"), confirmLabel: t("delete") });
  if (!ok) return;
  try {
    await bridge.event({ type: "delete_lore", production_id: state.active.id,
      worldbook_id: ref.worldbookId, entry_id: ref.entryId, entry_index: ref.entryIndex });
    await loadAll();
    toast(t("loreDeleted"));
  } catch (e) { toast(t("loreDeleteFailed", { err: e.message })); }
}

function librarySectionHtml(actorSec, modelsSec) {
  return `<div class="pSection librarySec">
    <div class="pHead">${esc(t("pLibrary"))}</div>
    <div class="libraryLinks">
      <button class="actorMore" id="openCardLibrary">${CARD_SVG}${esc(t("openCardLibrary"))}</button>
      <button class="actorMore" id="openWorldbookLibrary">${WORLD_SVG}${esc(t("openWorldbookLibrary"))}</button>
    </div>
    <div class="librarySupport">
      ${actorSec}
      ${modelsSec}
    </div>
  </div>`;
}

function loreLabel(e) {
  const keys = Array.isArray(e.keys) ? e.keys.filter(Boolean) : [];
  if (e.constant || !keys.length) return t("pAlwaysOn");
  return keys.join("、");
}

function sectionHead(title, editKey) {
  const editing = !!state[editKey];
  return `<div class="pHead pHeadAction"><span>${esc(title)}</span><button class="sectionEdit" data-edit-section="${esc(editKey)}">${esc(t(editing ? "done" : "edit"))}</button></div>`;
}

function renderPanel() {
  const body = $("#panelBody");
  const p = state.active;
  const actorSec = actorSectionHtml();
  const modelsSec = modelsSectionHtml();
  const persona = state.persona || {};
  const personaSummary = castSummary(persona);
  const hasPersona = persona.name || persona.description || persona.profile;
  const persSec = `<div class="pSection">
    ${sectionHead(t("pPersona"), "_editPersona")}
    ${hasPersona
      ? `<div class="personaProfileCard" data-persona-detail="1" role="button" tabindex="0" aria-label="${esc(t("pPersona"))}">
        <p class="pname">${esc(persona.name || "")}</p>
        ${personaSummary.identity ? `<p class="pdesc">${esc(personaSummary.identity)}</p>` : ""}
        ${personaSummary.traits ? `<p class="castTraits">${esc(personaSummary.traits)}</p>` : ""}
      </div>`
      : `<p class="pmuted">${esc(t("pPersonaNone"))}</p>`}
    ${state._editPersona ? `<div class="persLinks"><button data-act="persCustom">${esc(t("personaCustom"))}</button><span class="dot">·</span><button data-act="persImport">${esc(t("personaImport"))}</button></div>` : ""}
  </div>`;
  let sections;
  if (!p) {
    sections = `<div class="pSection"><div class="pHead">${esc(t("pCast"))}</div><p class="pmuted">${esc(t("pNoPlay"))}</p></div>`;
  } else {
    const cards = productionCards(p);
    const charFold = state._foldChar ? " folded" : "";
    const castHtml = cards.length ? cards.map((card) => {
      const summary = castSummary(card);
      return `<div class="castCard castProfileCard" data-cast-detail="${esc(card.id)}" role="button" tabindex="0">
        <div class="castTop"><p class="cname">${esc(card.name || "")}</p>${state._editCast ? `<span class="itemActions"><button class="itemEdit" data-cast-edit="${esc(card.id)}" aria-label="${esc(t("editCast"))}" title="${esc(t("editCast"))}">${PENCIL_SVG}</button><button class="loreDel" data-cast-del="${esc(card.id)}" aria-label="${esc(t("removeCast"))}" title="${esc(t("removeCast"))}">${TRASH_SVG}</button></span>` : ""}</div>
        ${summary.identity ? `<p class="castIdentity">${esc(summary.identity)}</p>` : ""}
        ${summary.traits ? `<p class="castTraits">${esc(summary.traits)}</p>` : ""}
        ${summary.relations ? `<p class="castRelations"><span>${esc(t("castFieldRelationships"))}</span>${esc(summary.relations)}</p>` : ""}
      </div>`;
    }).join("") : `<p class="pmuted">${esc(t("pNone"))}</p>`;
    const charSec = `<div class="pSection pFold">
      <div class="pHead pHeadFold${charFold}" data-fold="char">
        <span>${esc(t("pCast"))}</span><span class="headRight"><button class="sectionEdit" data-edit-section="_editCast">${esc(t(state._editCast ? "done" : "edit"))}</button><span class="arr">▼</span></span>
      </div>
      <div class="pFoldBody${charFold}" id="charBody">
        ${castHtml}
        ${state._editCast ? `<button class="actorMore" id="addCast">${CARD_SVG}${esc(t("addCast"))}</button>` : ""}
      </div></div>`;
    const lore = [];
    const currentWorldbooks = Array.isArray(p.worldbooks)
      ? p.worldbooks
      : (p.worldbook_ids || []).map((wid) => state.worldbooks[wid]).filter(Boolean);
    currentWorldbooks.forEach((wb) => (wb.entries || []).forEach((e, index) =>
      lore.push({ ...e, _worldbookId: wb.id, _entryIndex: index })));
    const alwaysLore = lore.filter((e) => e.constant || !(Array.isArray(e.keys) && e.keys.filter(Boolean).length));
    const namedLore = lore.filter((e) => !e.constant && Array.isArray(e.keys) && e.keys.filter(Boolean).length);
    const renderLoreItems = (items, showLabel) => items.length ? items.map((e) => `<div class="loreItem">
          ${showLabel || state._editLore ? `<div class="loreTop">${showLabel ? `<span class="lk">${esc(loreLabel(e))}</span>` : `<span></span>`}${state._editLore ? `<span class="itemActions"><button class="itemEdit" data-lore-edit="1" data-wid="${esc(e._worldbookId || "")}" data-entry-id="${esc(e.id || "")}" data-entry-index="${e._entryIndex}" aria-label="${esc(t("editLore"))}" title="${esc(t("editLore"))}">${PENCIL_SVG}</button><button class="loreDel" data-lore-del="1" data-wid="${esc(e._worldbookId || "")}" data-entry-id="${esc(e.id || "")}" data-entry-index="${e._entryIndex}" aria-label="${esc(t("delete"))}" title="${esc(t("delete"))}">${TRASH_SVG}</button></span>` : ""}</div>` : ""}
          <div class="loreText2">${esc(loc(e, "content") || e.content || "")}</div>
        </div>`).join("") : `<p class="pmuted">${esc(t("pNone"))}</p>`;
    const loreFold = state._foldLore ? " folded" : "";
    const loreSec = `<div class="pSection pFold">
      <div class="pHead pHeadFold${loreFold}" data-fold="lore">
        <span>${esc(t("pLorebook"))}</span><span class="headRight"><button class="sectionEdit" data-edit-section="_editLore">${esc(t(state._editLore ? "done" : "edit"))}</button><span class="arr">▼</span></span>
      </div>
      <div class="pFoldBody${loreFold}" id="loreBody">
        <div class="loreGroupTitle">${esc(t("pAlwaysOn"))}</div>${renderLoreItems(alwaysLore, false)}
        <div class="loreGroupTitle">${esc(t("loreTriggers"))}</div>${renderLoreItems(namedLore, true)}
        ${state._editLore ? `<button class="actorMore" id="addLore">${CARD_SVG}${esc(t("addLore"))}</button>` : ""}
      </div></div>`;
    sections = persSec + charSec + loreSec + librarySectionHtml(actorSec, modelsSec);
  }
  body.innerHTML = sections + officialDeveloperSectionHtml();
  body.querySelectorAll(".pHeadFold").forEach((h) => {
    h.onclick = () => { toggleFold(h.dataset.fold); };
  });
  body.querySelectorAll("[data-edit-section]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const key = b.dataset.editSection;
      state[key] = !state[key];
      if (state[key] && key === "_editCast") state._foldChar = false;
      if (state[key] && key === "_editLore") state._foldLore = false;
      renderPanel();
    };
  });
  bindPersonaActions();
  const personaDetail = body.querySelector("[data-persona-detail]");
  if (personaDetail) {
    const open = () => openPersonaDetailSheet();
    personaDetail.onclick = open;
    personaDetail.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    };
  }
  const mm = $("#modelManage");
  if (mm) mm.onclick = openModelSheet;
  const vm = $("#voiceManage");
  if (vm) vm.onclick = openVoiceSheet;
  const libBtn = $("#openCardLibrary");
  if (libBtn) libBtn.onclick = openCardLibraryManageSheet;
  const wbBtn = $("#openWorldbookLibrary");
  if (wbBtn) wbBtn.onclick = openWorldbookLibraryManageSheet;
  const addCast = $("#addCast");
  if (addCast) addCast.onclick = openAddCastSheet;
  const addLore = $("#addLore");
  if (addLore) addLore.onclick = openAddLoreSheet;
  body.querySelectorAll("[data-lore-del]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); deleteLoreEntry({ worldbookId: b.dataset.wid,
      entryId: b.dataset.entryId, entryIndex: Number(b.dataset.entryIndex) }); };
  });
  body.querySelectorAll("[data-lore-edit]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); openEditLoreSheet({ worldbookId: b.dataset.wid,
      entryId: b.dataset.entryId, entryIndex: Number(b.dataset.entryIndex) }); };
  });
  body.querySelectorAll("[data-cast-del]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); detachCardFromActive(b.dataset.castDel); };
  });
  body.querySelectorAll("[data-cast-edit]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); openEditCastSheet(b.dataset.castEdit); };
  });
  body.querySelectorAll("[data-cast-detail]").forEach((item) => {
    const open = () => openCastDetailSheet(item.dataset.castDetail);
    item.onclick = open;
    item.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
  });
}

function toggleFold(key) {
  if (key === "char") state._foldChar = !state._foldChar;
  else if (key === "lore") state._foldLore = !state._foldLore;
  renderPanel();
}

function bindPersonaActions() {
  const customBtn = document.querySelector("[data-act='persCustom']");
  const importBtn = document.querySelector("[data-act='persImport']");
  if (customBtn) customBtn.onclick = openPersonaCustomSheet;
  if (importBtn) importBtn.onclick = openPersonaCardSheet;
}

function openPersonaCustomSheet() {
  const persona = state.persona || {};
  const profile = castProfile(persona);
  const status = persona.persistent_status || {};
  const lines = (value) => Array.isArray(value) ? value.join("\n") : (value || "");
  const personalityLines = (Array.isArray(profile.personality.traits) && profile.personality.traits.length)
    ? profile.personality.traits : [profile.personality.summary || ""].filter(Boolean);
  const card = el("div", "modalCard editEntitySheet");
  card.innerHTML = `<div class="newWorldHd">
      <div><p class="modalTitle">${esc(t("personaCustom"))}</p><p class="newWorldSub">${esc(t("personaCustomSub"))}</p></div>
      <button class="sheetClose" aria-label="${esc(t("ariaClose"))}">×</button>
    </div>
    <div class="editEntityTabs" role="tablist">
      <button class="active" data-edit-tab="basic" role="tab">${esc(t("editTabBasic"))}</button>
      <button data-edit-tab="character" role="tab">${esc(t("editTabCharacter"))}</button>
      <button data-edit-tab="progress" role="tab">${esc(t("editTabProgress"))}</button>
    </div>
    <div class="editEntityBody">
      <section class="editEntityPane active" data-edit-pane="basic">
        <div class="formSectionTitle">${esc(t("castGroupIdentity"))}</div>
        <label class="fieldLabel">${esc(t("castFieldName"))}<input id="persName" class="formControl" value="${esc(persona.name || "")}" /></label>
        <div class="stateEditorGrid">
          <label class="fieldLabel">${esc(t("castFieldOccupation"))}<input id="persOccupation" class="formControl" value="${esc(profile.identity.occupation || "")}" /></label>
          <label class="fieldLabel">${esc(t("castFieldStoryRole"))}<input id="persStoryRole" class="formControl" value="${esc(profile.identity.story_role || "")}" /></label>
        </div>
        <label class="fieldLabel">${esc(t("castFieldDescription"))}<textarea id="persDesc" class="formControl">${esc(profile.identity.description || persona.description || "")}</textarea></label>
        <div class="formSectionTitle">${esc(t("castGroupAppearance"))}</div>
        <label class="fieldLabel">${esc(t("castFieldAppearance"))}<textarea id="persAppearance" class="formControl">${esc(profile.appearance.summary || "")}</textarea></label>
        <div class="formSectionTitle">${esc(t("castGroupBackground"))}</div>
        <label class="fieldLabel">${esc(t("castFieldBackground"))}<textarea id="persBackground" class="formControl">${esc(profile.background.summary || "")}</textarea></label>
      </section>
      <section class="editEntityPane" data-edit-pane="character">
        <div class="formSectionTitle">${esc(t("castGroupPersonality"))}</div>
        <label class="fieldLabel">${esc(t("castFieldTraits"))}<textarea id="persTraits" class="formControl" placeholder="${esc(t("castLinesHint"))}">${esc(lines(personalityLines))}</textarea></label>
        <label class="fieldLabel">${esc(t("castFieldMotivation"))}<textarea id="persMotivation" class="formControl">${esc(profile.personality.motivation || "")}</textarea></label>
        <div class="formSectionTitle">${esc(t("castGroupCapabilities"))}</div>
        <label class="fieldLabel">${esc(t("castFieldSkills"))}<textarea id="persSkills" class="formControl" placeholder="${esc(t("castLinesHint"))}">${esc(lines(profile.capabilities.skills))}</textarea></label>
        <label class="fieldLabel">${esc(t("castFieldLimitations"))}<textarea id="persLimitations" class="formControl" placeholder="${esc(t("castLinesHint"))}">${esc(lines(profile.capabilities.limitations))}</textarea></label>
      </section>
      <section class="editEntityPane" data-edit-pane="progress">
        <div class="formSectionTitle">${esc(t("castGroupStatus"))}</div>
        <label class="fieldLabel">${esc(t("castFieldLifeStatus"))}<input id="persLifeStatus" class="formControl" value="${esc(status.life_status || "")}" /></label>
        <label class="fieldLabel">${esc(t("castFieldPhysicalCondition"))}<textarea id="persPhysicalCondition" class="formControl">${esc(status.physical_condition || "")}</textarea></label>
      </section>
    </div>
    <div class="editEntityFooter loreSheetActs"><button class="ghost">${esc(t("cancel"))}</button><button class="primary">${esc(t("personaSave"))}</button></div>`;
  openModal(card);
  card.querySelector(".sheetClose").onclick = closeModal;
  card.querySelector(".ghost").onclick = closeModal;
  card.querySelectorAll("[data-edit-tab]").forEach((button) => {
    button.onclick = () => {
      card.querySelectorAll("[data-edit-tab]").forEach((item) => item.classList.toggle("active", item === button));
      card.querySelectorAll("[data-edit-pane]").forEach((pane) => pane.classList.toggle("active", pane.dataset.editPane === button.dataset.editTab));
      card.querySelector(".editEntityBody").scrollTop = 0;
    };
  });
  card.querySelector(".primary").onclick = async () => {
    const name = (card.querySelector("#persName").value || "").trim();
    if (!name) { toast(t("castNameRequired")); return; }
    try {
      card.classList.add("saving");
      const r = await bridge.event({ type: "set_persona", production_id: state.active?.id,
        profile: {
          identity: { name, description: card.querySelector("#persDesc").value.trim(),
            occupation: card.querySelector("#persOccupation").value.trim(), story_role: card.querySelector("#persStoryRole").value.trim() },
          appearance: { summary: card.querySelector("#persAppearance").value.trim() },
          personality: { summary: "", traits: card.querySelector("#persTraits").value.split(/\n+/).map((x) => x.trim()).filter(Boolean),
            motivation: card.querySelector("#persMotivation").value.trim() },
          capabilities: { skills: card.querySelector("#persSkills").value.split(/\n+/).map((x) => x.trim()).filter(Boolean),
            limitations: card.querySelector("#persLimitations").value.split(/\n+/).map((x) => x.trim()).filter(Boolean) },
          background: { summary: card.querySelector("#persBackground").value.trim() },
        },
        persistent_status: { life_status: card.querySelector("#persLifeStatus").value.trim(),
          physical_condition: card.querySelector("#persPhysicalCondition").value.trim() } });
      state.active = r.production; state.persona = r.persona;
      const i = state.productions.findIndex((p) => p.id === r.production.id);
      if (i >= 0) state.productions[i] = r.production;
      closeModal(); renderPanel(); toast(t("personaSave"));
    } catch (e) { card.classList.remove("saving"); toast(t("genFailed", { err: e.message })); }
  };
  card.querySelector("#persName").focus();
}

function openPersonaCardSheet() {
  if (!state.cards.length) { toast(t("noCastToAdd")); return; }
  const card = el("div", "modalCard sheetCard");
  card.innerHTML = `<div class="sheetHd"><div class="t">${CARD_SVG}${esc(t("personaImport"))}</div><button class="sheetClose" aria-label="${esc(t("ariaClose"))}">×</button></div>
    <div class="sheetBody cardPicker open">${state.cards.map((c) => `<div class="cardPick" data-id="${esc(c.id)}">${esc(c.name || t("unnamedCard"))}</div>`).join("")}</div>`;
  openModal(card);
  card.querySelector(".sheetClose").onclick = closeModal;
  card.querySelectorAll(".cardPick").forEach((d) => d.onclick = () => setPersonaFromCard(d.dataset.id));
}

async function setPersonaFromCard(cardId) {
  const c = state.cardMap[cardId];
  if (!c) return;
  try {
    const r = await bridge.event({ type: "set_persona", production_id: state.active?.id, card_id: cardId });
    state.active = r.production; state.persona = r.persona;
    const i = state.productions.findIndex((p) => p.id === r.production.id);
    if (i >= 0) state.productions[i] = r.production;
    closeModal(); renderPanel(); toast(t("personaSave"));
  } catch (e) { toast(t("personaImportFailed", { err: e.message })); }
}

async function detachCardFromActive(cardId) {
  if (!state.active || !cardId) return;
  const card = productionCards(state.active).find((c) => c.id === cardId) || {};
  const ok = await confirmDialog({
    title: t("castRemoveTitle", { name: card.name || t("unnamedCard") }),
    body: t("castRemoveBody"),
    confirmLabel: t("removeCast"),
  });
  if (!ok) return;
  try {
    const r = await bridge.event({ type: "detach_card", production_id: state.active.id, card_id: cardId });
    state.active = r.production; state.activeId = r.production.id;
    const i = state.productions.findIndex((p) => p.id === r.production.id);
    if (i >= 0) state.productions[i] = r.production;
    await loadAll();
    toast(t("castRemoved"));
  } catch (e) { toast(t("castRemoveFailed", { err: e.message })); }
}

function profileDetailGroups(entity) {
  const rows = profileRows(entity);
  const groups = [
    [t("castGroupIdentity"), ["castFieldName", "castFieldAliases", "castFieldDescription", "castFieldGender", "castFieldAge", "castFieldSpecies", "castFieldOccupation", "castFieldAffiliations", "castFieldStoryRole"]],
    [t("castGroupAppearance"), ["castFieldAppearance", "castFieldFeatures", "castFieldAttire"]],
    [t("castGroupPersonality"), ["castFieldTraits", "castFieldValues", "castFieldMotivation", "castFieldFears", "castFieldBoundaries"]],
    [t("castGroupExpression"), ["castFieldSpeech", "castFieldHabits", "castFieldMannerisms"]],
    [t("castGroupCapabilities"), ["castFieldSkills", "castFieldPowers", "castFieldLimitations"]],
    [t("castGroupBackground"), ["castFieldBackground", "castFieldHistory"]],
    [t("castGroupStatus"), ["castFieldLifeStatus", "castFieldPhysicalCondition"]],
    [t("castGroupRelationships"), ["castFieldRelationships"]],
  ].map(([title, keys]) => {
    const labels = new Set(keys.map((key) => t(key)));
    return [title, rows.filter(([label]) => labels.has(label))];
  }).filter(([, items]) => items.length);
  return groups;
}

function openProfileDetailSheet(entity, title) {
  const groups = profileDetailGroups(entity);
  const body = groups.map(([groupTitle, items]) => `<section class="castDetailGroup"><h3>${esc(groupTitle)}</h3>${items.map(([label, value]) => `<div class="castDetailRow"><span>${esc(label)}</span><p>${esc(value)}</p></div>`).join("")}</section>`).join("");
  const card = el("div", "modalCard castDetailSheet");
  card.innerHTML = `<div class="sheetHd"><div class="t">${CARD_SVG}${esc(title)}</div><button class="sheetClose" aria-label="${esc(t("ariaClose"))}">×</button></div>
    <div class="sheetBody castDetailBody">${body || `<p class="pmuted">${esc(t("cardNoDetail"))}</p>`}</div>`;
  openModal(card);
  card.querySelector(".sheetClose").onclick = closeModal;
}

function openPersonaDetailSheet() {
  const persona = state.persona || {};
  if (!(persona.name || persona.description || persona.profile)) return;
  const runtimeCast = (state.active && state.active.runtime_cast) || {};
  const entity = {
    ...persona,
    persistent_status: persona.persistent_status || runtimeCast.user_status || {},
  };
  openProfileDetailSheet(entity, persona.name || t("pPersona"));
}

function openCastDetailSheet(cardId) {
  const character = productionCards(state.active).find((c) => c.id === cardId);
  if (!character) return;
  openProfileDetailSheet(character, character.name || t("unnamedCard"));
}

function openEditCastSheet(cardId) {
  const character = productionCards(state.active).find((c) => c.id === cardId);
  if (!character) return;
  let baseRevision = Number(((state.active || {}).runtime_cast || {}).revision || 0);
  const profile = castProfile(character);
  const status = character.persistent_status || {};
  const lines = (value) => Array.isArray(value) ? value.join("\n") : (value || "");
  const personalityLines = (Array.isArray(profile.personality.traits) && profile.personality.traits.length)
    ? profile.personality.traits : [profile.personality.summary || character.personality || ""].filter(Boolean);
  const relationshipDetails = Array.isArray(character.relationship_details) ? character.relationship_details : [];
  const relationshipTargets = [
    { id: "__user__", name: (state.persona && state.persona.name) || t("pPersona") },
    ...productionCards(state.active).filter((item) => item.id !== cardId).map((item) => ({ id: item.id, name: item.name || t("unnamedCard") })),
  ];
  const relationshipOptions = (selected) => relationshipTargets.map((target) =>
    `<option value="${esc(target.id)}"${target.id === selected ? " selected" : ""}>${esc(target.name)}</option>`).join("");
  const relationshipDescription = (relation) => {
    const description = String(relation.description || relation.type || "").trim();
    const attitude = String(relation.attitude || "").trim();
    return attitude && !description.includes(attitude) ? `${description}${description ? "，" : ""}${attitude}` : description;
  };
  const relationshipRow = (relation = {}) => `<div class="relationEditRow">
    <label class="fieldLabel">${esc(t("relationTarget"))}<select class="formControl relationTarget">${relationshipOptions(relation.target_id || "__user__")}</select></label>
    <button type="button" class="relationRemove" aria-label="${esc(t("relationRemove"))}" title="${esc(t("relationRemove"))}">${TRASH_SVG}</button>
    <label class="fieldLabel relationDescription">${esc(t("relationDescription"))}<textarea class="formControl" placeholder="${esc(t("relationDescriptionHint"))}">${esc(relationshipDescription(relation))}</textarea></label>
  </div>`;
  const card = el("div", "modalCard editEntitySheet");
  card.innerHTML = `<div class="newWorldHd">
      <div><p class="modalTitle">${esc(t("editCastTitle", { name: character.name || t("unnamedCard") }))}</p><p class="newWorldSub">${esc(t("editCastSub"))}</p></div>
      <button class="sheetClose" aria-label="${esc(t("ariaClose"))}">×</button>
    </div>
    <div class="editEntityTabs" role="tablist">
      <button class="active" data-edit-tab="basic" role="tab">${esc(t("editTabBasic"))}</button>
      <button data-edit-tab="character" role="tab">${esc(t("editTabCharacter"))}</button>
      <button data-edit-tab="progress" role="tab">${esc(t("editTabProgress"))}</button>
    </div>
    <div class="editEntityBody">
      <section class="editEntityPane active" data-edit-pane="basic">
      <div class="formSectionTitle">${esc(t("castGroupIdentity"))}</div>
      <label class="fieldLabel">${esc(t("castFieldName"))}<input id="castEditName" class="formControl" value="${esc(character.name || "")}" /></label>
      <div class="stateEditorGrid">
        <label class="fieldLabel">${esc(t("castFieldOccupation"))}<input id="castEditOccupation" class="formControl" value="${esc(profile.identity.occupation || "")}" /></label>
        <label class="fieldLabel">${esc(t("castFieldStoryRole"))}<input id="castEditStoryRole" class="formControl" value="${esc(profile.identity.story_role || "")}" /></label>
      </div>
      <label class="fieldLabel">${esc(t("castFieldDescription"))}<textarea id="castEditDescription" class="formControl">${esc(profile.identity.description || character.description || "")}</textarea></label>
      <div class="formSectionTitle">${esc(t("castGroupAppearance"))}</div>
      <label class="fieldLabel">${esc(t("castFieldAppearance"))}<textarea id="castEditAppearance" class="formControl">${esc(profile.appearance.summary || "")}</textarea></label>
      <div class="formSectionTitle">${esc(t("castGroupBackground"))}</div>
      <label class="fieldLabel">${esc(t("castFieldBackground"))}<textarea id="castEditBackground" class="formControl">${esc(profile.background.summary || "")}</textarea></label>
      </section>
      <section class="editEntityPane" data-edit-pane="character">
      <div class="formSectionTitle">${esc(t("castGroupPersonality"))}</div>
      <label class="fieldLabel">${esc(t("castFieldTraits"))}<textarea id="castEditTraits" class="formControl" placeholder="${esc(t("castLinesHint"))}">${esc(lines(personalityLines))}</textarea></label>
      <label class="fieldLabel">${esc(t("castFieldMotivation"))}<textarea id="castEditMotivation" class="formControl">${esc(profile.personality.motivation || "")}</textarea></label>
      <div class="formSectionTitle">${esc(t("castGroupExpression"))}</div>
      <label class="fieldLabel">${esc(t("castFieldSpeech"))}<textarea id="castEditSpeech" class="formControl">${esc(profile.expression.speech_style || "")}</textarea></label>
      <div class="formSectionTitle">${esc(t("castGroupCapabilities"))}</div>
      <label class="fieldLabel">${esc(t("castFieldSkills"))}<textarea id="castEditSkills" class="formControl" placeholder="${esc(t("castLinesHint"))}">${esc(lines(profile.capabilities.skills))}</textarea></label>
      <label class="fieldLabel">${esc(t("castFieldLimitations"))}<textarea id="castEditLimitations" class="formControl" placeholder="${esc(t("castLinesHint"))}">${esc(lines(profile.capabilities.limitations))}</textarea></label>
      </section>
      <section class="editEntityPane" data-edit-pane="progress">
      <div class="formSectionTitle">${esc(t("castGroupStatus"))}</div>
      <label class="fieldLabel">${esc(t("castFieldLifeStatus"))}<input id="castEditLifeStatus" class="formControl" value="${esc(status.life_status || "")}" /></label>
      <label class="fieldLabel">${esc(t("castFieldPhysicalCondition"))}<textarea id="castEditPhysicalCondition" class="formControl">${esc(status.physical_condition || "")}</textarea></label>
      <div class="formSectionTitle">${esc(t("castGroupRelationships"))}</div>
      <div id="castEditRelationships" class="relationEditor">${relationshipDetails.map(relationshipRow).join("")}</div>
      <button type="button" id="addCastRelationship" class="actorMore relationAdd">＋ ${esc(t("relationAdd"))}</button>
      </section>
    </div>
    <div class="editEntityFooter loreSheetActs"><button class="ghost">${esc(t("cancel"))}</button><button class="primary">${esc(t("save"))}</button></div>`;
  openModal(card);
  card.querySelector(".sheetClose").onclick = closeModal;
  card.querySelector(".ghost").onclick = closeModal;
  const relationEditor = card.querySelector("#castEditRelationships");
  const wireRelationRow = (row) => {
    const remove = row.querySelector(".relationRemove");
    if (remove) remove.onclick = () => row.remove();
  };
  relationEditor.querySelectorAll(".relationEditRow").forEach(wireRelationRow);
  card.querySelector("#addCastRelationship").onclick = () => {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = relationshipRow();
    const row = wrapper.firstElementChild;
    relationEditor.appendChild(row);
    wireRelationRow(row);
  };
  card.querySelectorAll("[data-edit-tab]").forEach((button) => {
    button.onclick = () => {
      card.querySelectorAll("[data-edit-tab]").forEach((item) => item.classList.toggle("active", item === button));
      card.querySelectorAll("[data-edit-pane]").forEach((pane) => pane.classList.toggle("active", pane.dataset.editPane === button.dataset.editTab));
      card.querySelector(".editEntityBody").scrollTop = 0;
    };
  });
  const saveButton = card.querySelector(".primary");
  saveButton.onclick = async () => {
    const name = card.querySelector("#castEditName").value.trim();
    if (!name) { toast(t("castNameRequired")); return; }
    try {
      card.classList.add("saving");
      saveButton.disabled = true;
      saveButton.textContent = t("saving");
      await bridge.event({ type: "update_cast", production_id: state.active.id, card_id: cardId,
        expected_revision: baseRevision,
        profile: {
          identity: { name, description: card.querySelector("#castEditDescription").value.trim(),
            occupation: card.querySelector("#castEditOccupation").value.trim(), story_role: card.querySelector("#castEditStoryRole").value.trim() },
          appearance: { summary: card.querySelector("#castEditAppearance").value.trim() },
          personality: { summary: "",
            traits: card.querySelector("#castEditTraits").value.split(/\n+/).map((x) => x.trim()).filter(Boolean),
            motivation: card.querySelector("#castEditMotivation").value.trim() },
          expression: { speech_style: card.querySelector("#castEditSpeech").value.trim() },
          capabilities: { skills: card.querySelector("#castEditSkills").value.split(/\n+/).map((x) => x.trim()).filter(Boolean),
            limitations: card.querySelector("#castEditLimitations").value.split(/\n+/).map((x) => x.trim()).filter(Boolean) },
          background: { summary: card.querySelector("#castEditBackground").value.trim() },
        },
        persistent_status: {
          life_status: card.querySelector("#castEditLifeStatus").value.trim(),
          physical_condition: card.querySelector("#castEditPhysicalCondition").value.trim(),
        },
        relationships: [...relationEditor.querySelectorAll(".relationEditRow")].map((row) => ({
          target_id: row.querySelector(".relationTarget").value,
          description: row.querySelector(".relationDescription textarea").value.trim(),
        })).filter((relation) => relation.target_id && relation.description) });
      closeModal(); await loadAll(); toast(t("castUpdated"));
    } catch (e) {
      card.classList.remove("saving");
      saveButton.disabled = false;
      saveButton.textContent = t("save");
      if (e.code === "state_conflict") {
        const latestRevision = Number(e.data && e.data.current_revision);
        if (Number.isFinite(latestRevision)) baseRevision = latestRevision;
        toast(t("castStateChanged"));
        return;
      }
      toast(t("castUpdateFailed", { err: e.message }));
    }
  };
  card.querySelector("#castEditName").focus();
}

async function switchProd(id) {
  closeDrawers();
  try {
    const result = await bridge.event({ type: "switch_loadout", production_id: id, locale: I18N.lang });
    state.active = result.production;
    state.activeId = result.production.id;
    state.persona = result.production.persona || {};
    const index = state.productions.findIndex((production) => production.id === result.production.id);
    if (index >= 0) state.productions[index] = result.production;
    applyWorldTheme(result.production);
    renderRail(); renderStage(); renderPanel();
  } catch (e) { toast(t("switchFailed", { err: e.message })); }
}

function submitOrStop() {
  if (state.pendingSend) interruptSend();
  else if (!state.busy) send();
}
function setComposerSending(sending, interruptible = false) {
  const b = $("#sendBtn");
  b.disabled = sending && !interruptible;
  b.classList.toggle("stop", interruptible);
  b.innerHTML = interruptible ? STOP_SVG : SEND_SVG;
  b.setAttribute("aria-label", interruptible ? t("ariaStop") : t("ariaSend"));
  if (sending) b.classList.remove("empty");
  else updateSendEmpty();
}

function generationRequestId() {
  return (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : `gen-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function interruptSend() {
  const op = state.pendingSend;
  if (!op) return;
  op.cancelled = true;
  state.pendingSend = null;
  state.busy = false;
  op.rollback();
  const input = $("#input");
  input.value = op.text + (input.value.trim() ? `\n${input.value}` : "");
  autoGrow(input); updateSendEmpty();
  renderStage(); renderRail();
  setComposerSending(false);
  bridge.event({ type: "cancel_generation", request_id: op.requestId }).catch(() => {});
  op.controller.abort();
  input.focus();
}
// 没东西可发时发送键走静默灰态(发送中=停止键,恒亮)。
function updateSendEmpty() {
  if (state.busy) return;
  $("#sendBtn").classList.toggle("empty", !$("#input").value.trim());
}

async function send() {
  const input = $("#input"); const text = input.value.trim();
  if (!text || state.busy || !state.active) return;
  const productionId = state.active.id;
  const startedAt = Date.now();
  const storyBefore = state.active.story.slice();
  const op = {
    requestId: generationRequestId(),
    controller: new AbortController(),
    text,
    cancelled: false,
    rollback: () => { state.active.story = storyBefore.slice(); },
  };
  state.pendingSend = op;
  state.busy = true; setComposerSending(true, true);
  input.value = ""; autoGrow(input);
  if (isTouch()) input.blur();
  const tempUser = { role: "user", text };
  const tempChar = { role: "char", text: t("thinking"), _temp: true };
  state.active.story.push(tempUser, tempChar);
  renderStage(); anchorTurn(lastUserTurn(), true);
  try {
    const msg = await bridge.generate({ type: "send_message", production_id: productionId, text,
      locale: I18N.lang, request_id: op.requestId }, op.controller.signal);
    if (op.cancelled) return;
    const meta = msg._event || {};
    state.active.story = storyBefore.concat([meta.user_message || tempUser, attachGenMs(msg, startedAt)]);
    renderStage(); renderRail(); anchorTurn(lastUserTurn());
    watchStateSync(meta.state_sync, productionId);
  } catch (e) {
    if (!op.cancelled) {
      op.rollback(); renderStage();
      input.value = text + (input.value.trim() ? `\n${input.value}` : ""); autoGrow(input);
      if (e.name !== "AbortError") toast(t("genFailed", { err: e.message }));
    }
  } finally {
    if (state.pendingSend === op) {
      state.pendingSend = null;
      state.busy = false; setComposerSending(false); updateSendEmpty();
    }
  }
}

function setCtlBusy(btn, label) {
  document.querySelectorAll(".ctl button").forEach((b) => { b.disabled = true; });
  if (btn) { btn.dataset.oldText = btn.textContent; btn.textContent = label; btn.classList.add("busy"); }
}
function clearCtlBusy() {
  document.querySelectorAll(".ctl button").forEach((b) => { b.disabled = false; if (b.dataset.oldText) { b.textContent = b.dataset.oldText; delete b.dataset.oldText; } b.classList.remove("busy"); });
}

async function regenerate(btn) {
  if (state.busy || !state.active) return;
  const productionId = state.active.id;
  const startedAt = Date.now();
  state.busy = true; setCtlBusy(btn, t("regenBusy")); setComposerSending(true);
  const lastIdx = state.active.story.length - 1;
  const oldMsg = state.active.story[lastIdx];
  if (oldMsg && oldMsg.role === "char") {
    state.active.story[lastIdx] = { ...oldMsg, text: t("thinking") };
    renderStage(); anchorTurn(lastUserTurn(), true);
  }
  try {
    const msg = await bridge.generate({ type: "regenerate", production_id: productionId, locale: I18N.lang });
    const meta = msg._event || {};
    state.active.story[lastIdx] = attachGenMs(msg, startedAt);
    renderStage(); anchorTurn(lastUserTurn(), true);
    watchStateSync(meta.state_sync, productionId);
  } catch (e) {
    if (oldMsg) state.active.story[lastIdx] = oldMsg;
    renderStage();
    toast(t("regenFailed", { err: e.message }));
  }
  finally { state.busy = false; clearCtlBusy(); setComposerSending(false); updateSendEmpty(); }
}

async function doContinue(btn) {
  if (state.busy || !state.active) return;
  const productionId = state.active.id;
  const startedAt = Date.now();
  state.busy = true; setCtlBusy(btn, t("contBusy")); setComposerSending(true);
  const text = I18N.lang === "zh" ? "*剧情继续*" : "*Continue the story.*";
  const tempUser = { role: "user", text };
  const tempChar = { role: "char", text: t("thinking"), _temp: true };
  state.active.story.push(tempUser, tempChar);
  renderStage(); anchorTurn(lastUserTurn(), true);
  try {
    const msg = await bridge.generate({ type: "continue", production_id: productionId, text, locale: I18N.lang });
    const meta = msg._event || {};
    const base = state.active.story.slice(0, -2);
    state.active.story = base.concat([meta.user_message || tempUser, attachGenMs(msg, startedAt)]);
    renderStage(); renderRail(); anchorTurn(lastUserTurn(), true);
    watchStateSync(meta.state_sync, productionId);
  } catch (e) {
    state.active.story = state.active.story.slice(0, -2); renderStage();
    toast(t("genFailed", { err: e.message }));
  } finally { state.busy = false; clearCtlBusy(); setComposerSending(false); updateSendEmpty(); }
}

async function doSuggest(btn) {
  if (state.busy || !state.active) return;
  state.busy = true; setCtlBusy(btn, t("suggestBusy"));
  try {
    const r = await bridge.event({ type: "suggest", production_id: state.active.id, locale: I18N.lang });
    const items = (r.suggestions || []).map((x) => (x || "").trim()).filter(Boolean);
    if (!items.length) { toast(t("suggestEmpty")); return; }
    showSuggestions(items);
  } catch (e) { toast(t("suggestFailed", { err: e.message })); }
  finally { state.busy = false; clearCtlBusy(); }
}

function showSuggestions(items) {
  const card = el("div", "modalCard suggestCard");
  card.innerHTML = `<div class="suggestHd"><span class="t">${esc(t("suggestTitle"))}</span>
      <button class="sheetClose" aria-label="${esc(t("ariaClose"))}">✕</button></div>
    <div class="suggestBody">${items.map((s, i) =>
      `<button class="suggestItem" data-idx="${i}">${fmt(s)}</button>`).join("")}</div>`;
  openModal(card);
  card.querySelector(".sheetClose").onclick = closeModal;
  card.querySelectorAll(".suggestItem").forEach((b) => {
    b.onclick = () => {
      const input = $("#input");
      const idx = Number(b.dataset.idx || 0);
      input.value = items[idx] || b.textContent || "";
      autoGrow(input); updateSendEmpty();
      closeModal();
      input.focus();
    };
  });
}

async function swipe(id, dir) {
  const m = state.active && state.active.story.find((x) => x.id === id);
  if (!m || !Array.isArray(m.alts)) return;
  const cur = m.active_alt || 0;
  const next = cur + dir;
  if (next < 0 || next >= m.alts.length) return;
  m.active_alt = next; m.text = m.alts[next]; renderStage(); // 乐观切换
  anchorTurn(lastUserTurn(), true); // 切备选:锚到我的话,新版本在下方
  try {
    await bridge.event({ type: "swipe", production_id: state.active.id, message_id: id, dir });
  } catch (e) {
    m.active_alt = cur; m.text = m.alts[cur]; renderStage(); toast(t("switchFailed", { err: e.message }));
  }
}

// 行内编辑器:替代 window.prompt()——macOS 容器 WKWebView 里 prompt 是死的(未实现
// runJavaScriptTextInputPanel),且单行对多段 RP 文本是灾难(conversation-surface §3.2)。
function editMsg(id) {
  const turn = document.querySelector(`.turn[data-id="${id}"]`);
  const m = state.active && state.active.story.find((x) => x.id === id);
  if (!turn || !m || turn.querySelector(".editbox")) return;
  const productionId = state.active.id;
  const body = turn.querySelector(".body");
  const ctl = turn.querySelector(".ctl");
  const ta = document.createElement("textarea");
  ta.className = "editbox"; ta.value = m.text;
  const acts = document.createElement("div");
  acts.className = "editacts";
  acts.innerHTML = `<button class="save">${esc(t("send"))}</button><button class="cancel">${esc(t("cancel"))}</button>`;
  body.style.display = "none"; if (ctl) ctl.style.display = "none";
  turn.appendChild(ta); turn.appendChild(acts);
  growEdit(ta); ta.focus();
  const close = () => { ta.remove(); acts.remove(); body.style.display = ""; if (ctl) ctl.style.display = ""; };
  const save = async () => {
    const v = ta.value;
    const btn = acts.querySelector(".save");
    const isUserEdit = m.role === "user";
    const prevStory = state.active.story.slice();
    const startedAt = Date.now();
    if (btn) { btn.disabled = true; btn.textContent = isUserEdit ? t("thinking") : t("send"); }
    if (isUserEdit) {
      const idx = state.active.story.findIndex((x) => x.id === id);
      if (idx >= 0) {
        const edited = { ...state.active.story[idx], text: v };
        if (Array.isArray(edited.alts)) edited.alts = edited.alts.slice();
        if (Array.isArray(edited.alts) && edited.alts.length) edited.alts[edited.active_alt || 0] = v;
        state.active.story = state.active.story.slice(0, idx).concat([edited, { role: "char", text: t("thinking"), _temp: true }]);
        renderStage(); renderRail();
        anchorTurn(document.querySelector(`.turn[data-id="${id}"]`), true);
      }
    }
    try {
      let r;
      if (isUserEdit) {
        const msg = await bridge.generate({ type: "edit_message", production_id: productionId, message_id: id, text: v, continue_after: true, locale: I18N.lang });
        r = msg._event || { message: msg };
      } else {
        r = await bridge.event({ type: "edit_message", production_id: productionId, message_id: id, text: v, continue_after: false, locale: I18N.lang });
      }
      $("#think")?.remove();
      if (Array.isArray(r.story)) {
        state.active.story = r.story;
        if (isUserEdit && state.active.story.length) attachGenMs(state.active.story[state.active.story.length - 1], startedAt);
      } else if (r.message && isUserEdit) {
        const idx = state.active.story.findIndex((x) => x._temp);
        if (idx >= 0) state.active.story[idx] = attachGenMs(r.message, startedAt);
      } else {
        m.text = v; if (Array.isArray(m.alts)) m.alts[m.active_alt || 0] = v;
      }
      renderStage(); renderRail();
      anchorTurn(document.querySelector(`.turn[data-id="${id}"]`), true);
      watchStateSync(r.state_sync, productionId);
    } catch (e) {
      $("#think")?.remove();
      if (isUserEdit) { state.active.story = prevStory; renderStage(); renderRail(); }
      toast(t("editFailed", { err: e.message }));
      if (btn) { btn.disabled = false; btn.textContent = t("send"); }
    }
  };
  ta.oninput = () => growEdit(ta);
  ta.onkeydown = (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME 合成中不抢键
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
  };
  acts.querySelector(".cancel").onclick = close;
  acts.querySelector(".save").onclick = save;
}

// 编辑框自撑高;到 50vh 上限才开滚(未到顶保持 hidden,防 1px 误差冒滚动条,反馈 2026-07-02)
function growEdit(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
  el.style.overflowY = el.scrollHeight > window.innerHeight * 0.5 ? "auto" : "hidden";  // 与 CSS max-height:50vh 同步
}

function fileToB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = rej; r.readAsDataURL(file);
  });
}

async function importCard(file) {
  if (!file) return;
  toast(t("parsingCard"));
  try {
    const b64 = await fileToB64(file);
    const r = await bridge.event({ type: "import_card", png_base64: b64 });
    await loadAll();
    toast(t("imported", { name: r.card.name }));
    await newProductionFrom(r.card.id);
  } catch (e) { toast(t("importFailed", { err: e.message })); }
}

// 粘贴卡 JSON 导入(import_card_json):macOS 容器文件选择器是死的,这是纯 web 旁路。
async function importCardJson(raw) {
  let card;
  try { card = JSON.parse(raw); }
  catch (_) { toast(t("badCardJson")); return; }
  toast(t("parsingCard"));
  try {
    const r = await bridge.event({ type: "import_card_json", card });
    await loadAll();
    toast(t("imported", { name: r.card.name }));
    await newProductionFrom(r.card.id);
  } catch (e) { toast(t("importFailed", { err: e.message })); }
}

// 拖入 PNG(import_card)/JSON(import_card_json)——另一条不依赖文件选择器的入口。
function wireDropImport() {
  const stage = $("#stage");
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ["dragenter", "dragover"].forEach((t) =>
    stage.addEventListener(t, (e) => { stop(e); stage.classList.add("dragging"); }));
  stage.addEventListener("dragleave", (e) => {
    stop(e);
    if (e.relatedTarget && stage.contains(e.relatedTarget)) return; // 仍在 stage 内,别闪
    stage.classList.remove("dragging");
  });
  stage.addEventListener("drop", async (e) => {
    stop(e); stage.classList.remove("dragging");
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (/\.png$/i.test(file.name) || file.type === "image/png") importCard(file);
    else if (/\.json$/i.test(file.name) || file.type === "application/json") importCardJson(await file.text());
    else toast(t("dropWrongType"));
  });
}

function cardUsedInNames(cardId) {
  return state.productions.filter((p) => productionCardIds(p).includes(cardId)).map((p) => p.name || t("blankWorldName"));
}

function cardLibraryGroups() {
  const groups = [];
  const byName = new Map();
  function group(name) {
    if (!byName.has(name)) {
      const g = { name, cards: [] };
      byName.set(name, g);
      groups.push(g);
    }
    return byName.get(name);
  }
  const used = new Set();
  state.productions.forEach((p) => {
    const ids = productionCardIds(p);
    if (!ids.length) return;
    const g = group(p.name || t("blankWorldName"));
    ids.forEach((id) => {
      const c = state.cardMap[id];
      if (c) { g.cards.push(c); used.add(id); }
    });
  });
  const custom = state.libraryCards.filter((c) => !used.has(c.id));
  if (custom.length) group(t("customCardFolder")).cards.push(...custom);
  return groups.filter((g) => g.cards.length);
}

function cardDetailText(c) {
  const rows = profileRows(c, true);
  if (c.character_book && Array.isArray(c.character_book.entries)) {
    const content = c.character_book.entries.map((e) => {
      const keys = (e.keys || e.key || []).join ? (e.keys || e.key || []).join("、") : String(e.keys || e.key || "");
      return `${keys ? keys + "：" : ""}${e.content || ""}`;
    }).filter(Boolean).join("\n\n");
    if (content) rows.push([t("cardFieldWorldbook"), content]);
  }
  return rows;
}

function renderCardLibraryList(card, groups) {
  const rows = groups.length ? groups.map((g, idx) => `<section class="cardFolder" data-folder="${idx}">
    <button class="cardFolderHead" type="button" data-folder-toggle="${idx}">
      <span class="cardFolderTitle">${esc(g.name)}</span>
      <span class="cardFolderMeta">${esc(t("cardFolderCount", { n: g.cards.length }))}</span>
      <span class="cardFolderArrow">▼</span>
    </button>
    <div class="cardFolderRows">${g.cards.map((c) => {
      const used = cardUsedInNames(c.id);
      const meta = [c.description || "", used.length ? t("cardUsedBy", { names: used.join("、") }) : t("cardUnused")]
        .filter(Boolean).join(" · ");
      return `<div class="cardManageRow" data-id="${esc(c.id)}">
        <button class="cardOpen" type="button" data-open="${esc(c.id)}">
          <span>${esc(c.name || t("unnamedCard"))}</span>${meta ? `<small>${esc(meta)}</small>` : ""}
        </button>
      </div>`;
    }).join("")}</div>
  </section>`).join("") : `<p class="pmuted">${esc(t("cardLibraryEmpty"))}</p>`;
  card.innerHTML = `<div class="sheetHd"><div class="t">${CARD_SVG}${esc(t("cardLibrary"))}</div><button class="sheetClose" aria-label="${esc(t("ariaClose"))}">×</button></div>
    <div class="sheetBody cardPicker open cardLibraryBody">${rows}</div>`;
  card.querySelector(".sheetClose").onclick = closeModal;
  card.querySelectorAll("[data-folder-toggle]").forEach((btn) => {
    btn.onclick = () => btn.closest(".cardFolder")?.classList.toggle("collapsed");
  });
  card.querySelectorAll("[data-open]").forEach((btn) => {
    btn.onclick = () => renderCardDetail(card, groups, btn.dataset.open);
  });
}

function renderCardDetail(card, groups, cardId) {
  const c = state.cardMap[cardId];
  if (!c) return renderCardLibraryList(card, groups);
  const rows = cardDetailText(c).map(([label, value]) => `<section class="cardDetailBlock"><h4>${esc(label)}</h4><p>${esc(value)}</p></section>`).join("");
  card.classList.add("cardDetailSheet");
  card.innerHTML = `<div class="sheetHd"><button class="sheetBack" type="button">‹ ${esc(t("backToCardLibrary"))}</button><button class="sheetClose" aria-label="${esc(t("ariaClose"))}">×</button></div>
    <div class="cardDetailTitle">${CARD_SVG}${esc(c.name || t("unnamedCard"))}</div>
    <div class="sheetBody cardDetailBody">${rows || `<p class="pmuted">${esc(t("cardNoDetail"))}</p>`}</div>`;
  card.querySelector(".sheetBack").onclick = () => { card.classList.remove("cardDetailSheet"); renderCardLibraryList(card, groups); };
  card.querySelector(".sheetClose").onclick = closeModal;
}

function worldbookDetailText(w) {
  const rows = [];
  const nl = String.fromCharCode(10);
  const add = (label, value) => { if (value) rows.push([label, String(value)]); };
  add(t("worldbookFieldName"), loc(w, "name") || w.name || t("unnamedWorldbook"));
  add(t("worldbookFieldDesc"), loc(w, "description") || w.description);
  if (Array.isArray(w.entries) && w.entries.length) {
    add(t("worldbookFieldEntries"), w.entries.map((e) => {
      const rawKeys = e.keys || e.key || [];
      const keys = Array.isArray(rawKeys) ? rawKeys.join("、") : String(rawKeys || "");
      const title = e.name || e.comment || keys || t("unnamedLoreEntry");
      const content = loc(e, "content") || e.content || "";
      return `${title}${keys && title !== keys ? `（${keys}）` : ""}${nl}${content}`.trim();
    }).filter(Boolean).join(nl + nl));
  }
  return rows;
}

function renderWorldbookLibraryList(card) {
  const books = state.libraryWorldbooks || [];
  const rows = books.length ? books.map((w) => {
    const count = Array.isArray(w.entries) ? w.entries.length : 0;
    const meta = [t("worldbookEntryCount", { n: count }), w.description || ""].filter(Boolean).join(" · ");
    return `<div class="cardManageRow" data-id="${esc(w.id)}">
      <button class="cardOpen" type="button" data-open="${esc(w.id)}">
        <span>${esc(w.name || t("unnamedWorldbook"))}</span><small>${esc(meta)}</small>
      </button>
    </div>`;
  }).join("") : `<p class="pmuted">${esc(t("worldbookLibraryEmpty"))}</p>`;
  card.innerHTML = `<div class="sheetHd"><div class="t">${WORLD_SVG}${esc(t("worldbookLibrary"))}</div><button class="sheetClose" aria-label="${esc(t("ariaClose"))}">×</button></div>
    <div class="sheetBody cardPicker open cardLibraryBody">${rows}</div>`;
  card.querySelector(".sheetClose").onclick = closeModal;
  card.querySelectorAll("[data-open]").forEach((btn) => {
    btn.onclick = () => renderWorldbookDetail(card, btn.dataset.open);
  });
}

function renderWorldbookDetail(card, worldbookId) {
  const w = (state.libraryWorldbooks || []).find((x) => x.id === worldbookId);
  if (!w) return renderWorldbookLibraryList(card);
  const rows = worldbookDetailText(w).map(([label, value]) => `<section class="cardDetailBlock"><h4>${esc(label)}</h4><p>${esc(value)}</p></section>`).join("");
  card.classList.add("cardDetailSheet");
  card.innerHTML = `<div class="sheetHd"><button class="sheetBack" type="button">‹ ${esc(t("backToWorldbookLibrary"))}</button><button class="sheetClose" aria-label="${esc(t("ariaClose"))}">×</button></div>
    <div class="cardDetailTitle">${WORLD_SVG}${esc(w.name || t("unnamedWorldbook"))}</div>
    <div class="sheetBody cardDetailBody">${rows || `<p class="pmuted">${esc(t("worldbookNoDetail"))}</p>`}</div>`;
  card.querySelector(".sheetBack").onclick = () => { card.classList.remove("cardDetailSheet"); renderWorldbookLibraryList(card); };
  card.querySelector(".sheetClose").onclick = closeModal;
}

function openWorldbookLibraryManageSheet() {
  const card = el("div", "modalCard sheetCard cardLibrarySheet");
  openModal(card);
  renderWorldbookLibraryList(card);
}

function openCardLibraryManageSheet() {
  const card = el("div", "modalCard sheetCard cardLibrarySheet");
  openModal(card);
  renderCardLibraryList(card, cardLibraryGroups());
}

function openPasteJsonSheet() {
  const card = el("div", "modalCard newWorldSheet pasteJsonSheet");
  card.innerHTML = `<div class="newWorldHd">
      <div><p class="modalTitle">${esc(t("startFromJson"))}</p><p class="newWorldSub">${esc(t("startFromJsonMeta"))}</p></div>
      <button class="sheetClose" aria-label="${esc(t("ariaClose"))}">×</button>
    </div>
    <textarea id="pasteBox" class="newWorldText" placeholder="${esc(t("pastePlaceholder"))}"></textarea>
    <div class="newWorldActs"><button class="ghost">${esc(t("cancel"))}</button><button class="primary">${esc(t("pasteImport"))}</button></div>`;
  openModal(card);
  const close = () => closeModal();
  const box = card.querySelector("#pasteBox");
  card.querySelector(".sheetClose").onclick = close;
  card.querySelector(".ghost").onclick = close;
  card.querySelector(".primary").onclick = () => { const v = box.value.trim(); if (v) { closeModal(); importCardJson(v); } };
  box.focus();
}

async function attachCardToActive(cardId) {
  if (!state.active) return;
  try {
    const r = await bridge.event({ type: "attach_card", production_id: state.active.id, card_id: cardId });
    state.active = r.production;
    state.activeId = r.production.id;
    const i = state.productions.findIndex((p) => p.id === r.production.id);
    if (i >= 0) state.productions[i] = r.production;
    closeModal();
    renderRail(); renderStage(); renderPanel();
    toast(t("castAdded"));
  } catch (e) { toast(t("castAddFailed", { err: e.message })); }
}

async function createCastForActive(form) {
  if (!state.active) return;
  const name = (form.querySelector("#newCastName").value || "").trim();
  const description = (form.querySelector("#newCastDesc").value || "").trim();
  const personality = (form.querySelector("#newCastPersona").value || "").trim();
  const scenario = (form.querySelector("#newCastScenario").value || "").trim();
  if (!name) { toast(t("createCastNeedName")); return; }
  try {
    const r = await bridge.event({ type: "create_card", name, description, personality, scenario });
    state.cards.push(r.card);
    state.cardMap[r.card.id] = r.card;
    await attachCardToActive(r.card.id);
    toast(t("castCreated"));
  } catch (e) { toast(t("castCreateFailed", { err: e.message })); }
}

function openCastLibrarySheet() {
  if (!state.active) return;
  const used = new Set(productionCardIds(state.active));
  const choices = state.libraryCards.filter((c) => !used.has(c.id));
  if (!choices.length) { toast(t("noCastToAdd")); return; }
  const card = el("div", "modalCard sheetCard");
  card.innerHTML = `<div class="sheetHd"><div class="t">${CARD_SVG}${esc(t("castFromLibrary"))}</div><button class="sheetClose" aria-label="${esc(t("ariaClose"))}">×</button></div>
    <div class="sheetBody cardPicker open">${choices.map((c) => `<div class="cardPick" data-id="${esc(c.id)}">${esc(c.name)}</div>`).join("")}</div>`;
  openModal(card);
  card.querySelector(".sheetClose").onclick = closeModal;
  card.querySelectorAll(".cardPick").forEach((d) => d.onclick = () => attachCardToActive(d.dataset.id));
}

function openCreateCastSheet() {
  if (!state.active) return;
  const card = el("div", "modalCard newWorldSheet");
  card.innerHTML = `<div class="newWorldHd">
      <div><p class="modalTitle">${esc(t("createCastTitle"))}</p><p class="newWorldSub">${esc(t("createCastSub"))}</p></div>
      <button class="sheetClose" aria-label="${esc(t("ariaClose"))}">×</button>
    </div>
    <input id="newCastName" class="newWorldInput" placeholder="${esc(t("createCastName"))}" />
    <textarea id="newCastDesc" class="newWorldText" placeholder="${esc(t("createCastDesc"))}"></textarea>
    <textarea id="newCastPersona" class="newWorldText" placeholder="${esc(t("createCastPersona"))}"></textarea>
    <textarea id="newCastScenario" class="newWorldText" placeholder="${esc(t("createCastScenario"))}"></textarea>
    <div class="newWorldActs"><button class="ghost">${esc(t("cancel"))}</button><button class="primary">${esc(t("createCastSave"))}</button></div>`;
  openModal(card);
  card.querySelector(".sheetClose").onclick = closeModal;
  card.querySelector(".ghost").onclick = closeModal;
  card.querySelector(".primary").onclick = () => createCastForActive(card);
  card.querySelector("#newCastName").focus();
}

function openAddCastSheet() {
  if (!state.active) return;
  const card = el("div", "modalCard newWorldSheet");
  card.innerHTML = `<div class="newWorldHd">
      <div><p class="modalTitle">${esc(t("addCastTitle"))}</p><p class="newWorldSub">${esc(t("addCastSub"))}</p></div>
      <button class="sheetClose" aria-label="${esc(t("ariaClose"))}">×</button>
    </div>
    <div class="newWorldChoices">
      <button class="newWorldChoice" data-id="create"><span>${esc(t("createCast"))}</span><small>${esc(t("createCastMeta"))}</small></button>
      <button class="newWorldChoice" data-id="library"><span>${esc(t("castFromLibrary"))}</span><small>${esc(t("castFromLibraryMeta"))}</small></button>
    </div>`;
  openModal(card);
  card.querySelector(".sheetClose").onclick = closeModal;
  card.querySelector('[data-id="create"]').onclick = () => { closeModal(); openCreateCastSheet(); };
  card.querySelector('[data-id="library"]').onclick = () => { closeModal(); openCastLibrarySheet(); };
}

function loreEntryFromRef(ref) {
  if (!state.active || !ref) return null;
  const wb = (state.active.worldbooks || []).find((w) => String(w.id) === String(ref.worldbookId));
  if (!wb) return null;
  const entries = wb.entries || [];
  return entries.find((e) => ref.entryId && String(e.id) === String(ref.entryId))
    || entries[Number(ref.entryIndex)] || null;
}

function splitLoreKeys(value) {
  return String(value || "").split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
}

function openAddLoreSheet() { openLoreSheet(null); }
function openEditLoreSheet(ref) { openLoreSheet(ref); }

function openLoreSheet(ref) {
  if (!state.active) return;
  const entry = loreEntryFromRef(ref);
  if (ref && !entry) { toast(t("loreNotFound")); return; }
  let mode = entry && !entry.constant && Array.isArray(entry.keys) && entry.keys.length ? "trigger" : "constant";
  const card = el("div", "modalCard loreSheet");
  card.innerHTML = `<div class="loreSheetHd">
      <div><p class="loreSheetTitle">${esc(entry ? t("editLoreTitle") : t("addLoreTitle"))}</p><p class="loreSheetSub">${esc(t("loreEditorSub"))}</p></div>
      <button id="loreCancel" class="sheetClose" aria-label="${esc(t("ariaClose"))}">×</button>
    </div>
    <div class="loreSheetBody">
      <div class="fieldLabel">${esc(t("loreModeLabel"))}<div class="modeSwitch" role="group" aria-label="${esc(t("loreModeLabel"))}">
        <button type="button" data-mode="constant">${esc(t("pAlwaysOn"))}</button>
        <button type="button" data-mode="trigger">${esc(t("loreTriggerMode"))}</button>
      </div></div>
      <label id="loreKeysWrap" class="fieldLabel">${esc(t("loreKeysLabel"))}<input id="loreKeys" class="formControl" placeholder="${esc(t("loreKeysPlaceholder"))}" value="${esc(entry && Array.isArray(entry.keys) ? entry.keys.join("、") : "")}" /></label>
      <label class="fieldLabel">${esc(t("loreContentLabel"))}<textarea id="loreText" class="loreText" placeholder="${esc(t("addLorePlaceholder"))}">${esc(entry ? (loc(entry, "content") || entry.content || "") : "")}</textarea></label>
      <div class="loreSheetActs">
        <button id="loreCancel2">${esc(t("cancel"))}</button>
        <button id="loreSave" class="primary">${esc(t("save"))}</button>
      </div>
    </div>`;
  openModal(card);
  const box = card.querySelector("#loreText");
  const keyWrap = card.querySelector("#loreKeysWrap");
  const syncMode = () => {
    card.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    keyWrap.classList.toggle("hidden", mode !== "trigger");
  };
  card.querySelectorAll("[data-mode]").forEach((b) => b.onclick = () => { mode = b.dataset.mode; syncMode(); });
  syncMode(); box.focus();
  card.querySelector("#loreCancel").onclick = closeModal;
  card.querySelector("#loreCancel2").onclick = closeModal;
  card.querySelector("#loreSave").onclick = async () => {
    const content = box.value.trim();
    const keys = splitLoreKeys(card.querySelector("#loreKeys").value);
    if (!content) { toast(t("addLoreEmpty")); return; }
    if (mode === "trigger" && !keys.length) { toast(t("loreKeysRequired")); return; }
    try {
      card.classList.add("saving");
      const payload = { type: entry ? "update_lore" : "add_lore", production_id: state.active.id,
        content, constant: mode === "constant", keys };
      if (entry) Object.assign(payload, { worldbook_id: ref.worldbookId,
        entry_id: ref.entryId, entry_index: ref.entryIndex });
      await bridge.event(payload);
      closeModal(); await loadAll(); toast(t(entry ? "loreUpdated" : "loreAdded"));
    } catch (e) {
      card.classList.remove("saving");
      toast(t(entry ? "loreUpdateFailed" : "loreAddFailed", { err: e.message }));
    }
  };
}

async function newProductionFrom(cardId) {
  const card = state.cardMap[cardId]; if (!card) return;
  const wbId = "wb_" + cardId;
  const wbs = state.worldbooks[wbId] ? [wbId] : [];
  try {
    const r = await bridge.event({ type: "create_production", card_id: cardId, worldbook_ids: wbs, name: card.name, locale: I18N.lang });
    await loadAll(); switchProd(r.production.id);
  } catch (e) { toast(t("createProdFailed", { err: e.message })); }
}

function openCardLibrarySheet() {
  if (!state.cards.length) { toast(t("importFirst")); return; }
  const card = el("div", "modalCard sheetCard");
  card.innerHTML = `<div class="sheetHd"><div class="t">${CARD_SVG}${esc(t("startFromLibrary"))}</div><button class="sheetClose" aria-label="${esc(t("ariaClose"))}">×</button></div>
    <div class="sheetBody cardPicker open">${state.cards.map((c) => `<div class="cardPick" data-id="${esc(c.id)}">${esc(c.name)}</div>`).join("")}</div>`;
  openModal(card);
  card.querySelector(".sheetClose").onclick = closeModal;
  card.querySelectorAll(".cardPick").forEach((d) => d.onclick = () => { closeModal(); newProductionFrom(d.dataset.id); });
}

async function createWorldFromWorldbook(wid) {
  const wb = state.worldbooks[wid];
  if (!wb) return;
  try {
    const r = await bridge.event({ type: "create_blank_production", name: loc(wb, "name") || wb.name || t("blankWorldName"), worldbook_ids: [wid], locale: I18N.lang });
    closeModal();
    await loadAll();
    switchProd(r.production.id);
    toast(t("blankWorldCreated"));
  } catch (e) { toast(t("blankWorldFailed", { err: e.message })); }
}

function importableWorldbooks() {
  return (state.libraryWorldbooks || []).filter((w) => Array.isArray(w.entries) && w.entries.length > 0);
}

function openImportWorldSheet() {
  const wbs = importableWorldbooks();
  if (!wbs.length) { toast(t("worldbookLibraryEmpty")); return; }
  const card = el("div", "modalCard sheetCard");
  const rows = wbs.map((w) => {
    const count = Array.isArray(w.entries) ? w.entries.length : 0;
    return `<div class="cardPick cardManageRow" data-id="${esc(w.id)}">
      <button class="cardOpen" type="button" data-open="${esc(w.id)}">
        <span>${esc(loc(w, "name") || w.name || t("unnamedWorldbook"))}</span><small>${esc(t("worldbookEntryCount", { n: count }))}</small>
      </button>
    </div>`;
  }).join("");
  card.innerHTML = `<div class="sheetHd"><div class="t">${CARD_SVG}${esc(t("importWorld"))}</div><button class="sheetClose" aria-label="${esc(t("ariaClose"))}">×</button></div>
    <div class="sheetBody cardPicker open">${rows}</div>`;
  openModal(card);
  card.querySelector(".sheetClose").onclick = closeModal;
  card.querySelectorAll("[data-open]").forEach((b) => b.onclick = () => createWorldFromWorldbook(b.dataset.open));
}

function openBlankWorldSheet() {
  const card = el("div", "modalCard newWorldSheet");
  card.innerHTML = `<div class="newWorldHd">
      <div><p class="modalTitle">${esc(t("startBlankWorld"))}</p><p class="newWorldSub">${esc(t("startBlankWorldMeta"))}</p></div>
      <button class="sheetClose" aria-label="${esc(t("ariaClose"))}">×</button>
    </div>
    <input id="blankWorldName" class="newWorldInput" placeholder="${esc(t("blankWorldPrompt"))}" />
    <div class="newWorldActs"><button class="ghost">${esc(t("cancel"))}</button><button class="primary">${esc(t("createWorld"))}</button></div>`;
  openModal(card);
  const close = () => closeModal();
  const input = card.querySelector("#blankWorldName");
  const save = async () => {
    const name = input.value.trim() || t("blankWorldName");
    try {
      const r = await bridge.event({ type: "create_blank_production", name, locale: I18N.lang });
      closeModal();
      await loadAll();
      switchProd(r.production.id);
      toast(t("blankWorldCreated"));
    } catch (e) { toast(t("blankWorldFailed", { err: e.message })); }
  };
  card.querySelector(".sheetClose").onclick = close;
  card.querySelector(".ghost").onclick = close;
  card.querySelector(".primary").onclick = save;
  input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } };
  input.focus();
}

function openNewWorldSheet() {
  const card = el("div", "modalCard newWorldSheet");
  const rows = [
    ["blank", t("selfBuildWorld"), t("selfBuildWorldMeta")],
    ["import", t("importWorld"), t("importWorldMeta")],
  ];
  card.innerHTML = `<div class="newWorldHd">
      <div><p class="modalTitle">${esc(t("newWorldTitle"))}</p><p class="newWorldSub">${esc(t("newWorldSub"))}</p></div>
      <button class="sheetClose" aria-label="${esc(t("ariaClose"))}">×</button>
    </div>
    <p class="newWorldHint">${esc(t("newWorldHint"))}</p>
    <div class="newWorldChoices">${rows.map(([id, title, meta]) => `<button class="newWorldChoice" data-id="${id}"><span>${esc(title)}</span><small>${esc(meta)}</small></button>`).join("")}</div>`;
  openModal(card);
  card.querySelector(".sheetClose").onclick = closeModal;
  card.querySelectorAll(".newWorldChoice").forEach((b) => b.onclick = () => {
    const id = b.dataset.id;
    if (id === "blank") openBlankWorldSheet();
    else if (id === "import") openImportWorldSheet();
  });
}

// composer 自撑高;只有内容真超过 max(140px)才开滚——否则保持 hidden,
// 防「输入过一次后 scrollHeight 与设定高差 1px → macOS 冒常驻黑滚动条」(反馈 2026-07-02)
function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 140) + "px";
  el.style.overflowY = el.scrollHeight > 140 ? "auto" : "hidden";
}
function scrollDown() { const c = $("#convo"); c.scrollTop = c.scrollHeight; }
// 这一回合「我说的那条」(末条用户消息)——滚动锚定的基准。
function lastUserTurn() { const us = document.querySelectorAll(".turn.user"); return us[us.length - 1] || null; }
// 发送后的滚动定位(双端,反馈 2026-06-30 修正):把「我刚输入的那条」摆到接近视口顶(留 20px),
// 再夹进自然滚动范围。→ 回复短:夹到自然底(IM 式,我的话+回复都在视口、几乎不滚);
//   回复长:我的话钉在顶、回复在下方铺开(从我说的话往下读)。两种情况都始终看得到自己输入的那条。
// force=true:新回合,重置 stick 并锚定;否则尊重用户生成中途的上滚(不跟用户抢)。
function anchorTurn(el, force) {
  const c = $("#convo");
  if (!c || !el) return;
  if (force) state.stick = true;
  if (!state.stick) return;
  const top = el.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop - 20;
  c.scrollTop = state._anchor = Math.max(0, Math.min(top, c.scrollHeight - c.clientHeight));
}
// 动作输入辅助(反馈 2026-07-02):把文字框成 *动作*——星号是 RP 动作/叙述惯例
// (fmt() 渲染成 .nar serif 斜体;中括号在 RP 圈是 OOC 戏外话,不用)。
// 编辑器式三态:选中→包裹;空光标→插入 ** 居中;紧贴右 * →跳出(连按自然收尾)。
function wrapAction() {
  const el = $("#input");
  const s = el.selectionStart, e = el.selectionEnd, v = el.value;
  if (s !== e) {
    el.value = v.slice(0, s) + "*" + v.slice(s, e) + "*" + v.slice(e);
    el.setSelectionRange(e + 2, e + 2);
  } else if (v[s] === "*") {
    el.setSelectionRange(s + 1, s + 1);
  } else {
    el.value = v.slice(0, s) + "**" + v.slice(s);
    el.setSelectionRange(s + 1, s + 1);
  }
  el.focus();
  autoGrow(el); updateSendEmpty();
}

// 触屏(移动)= 无 hover。用于「发送后不自动弹键盘」等只在移动端做的事(反馈 2026-06-30)。
const isTouch = () => window.matchMedia("(hover: none)").matches;

const historyNavigator = (() => {
  const compactQuery = window.matchMedia("(max-width:640px) and (min-aspect-ratio:1/2)");
  let anchor = null;
  let resizePending = false;
  let restoring = false;
  let dragging = false;
  let pointerOffset = 0;
  let observer = null;

  const elements = () => ({
    convo: $("#convo"),
    bar: $("#historyScrollbar"),
    thumb: $("#historyScrollThumb"),
  });

  function sync() {
    const { convo, bar, thumb } = elements();
    if (!convo || !bar || !thumb) return;
    const maxScroll = Math.max(0, convo.scrollHeight - convo.clientHeight);
    const hasHistory = maxScroll > 24;
    document.body.classList.toggle("has-history-scroll", hasHistory);
    if (!hasHistory || !compactQuery.matches || bar.clientHeight <= 0) return;
    const thumbHeight = Math.max(44, Math.round(bar.clientHeight * convo.clientHeight / convo.scrollHeight));
    const travel = Math.max(0, bar.clientHeight - thumbHeight);
    const top = maxScroll ? Math.round(travel * convo.scrollTop / maxScroll) : 0;
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${top}px)`;
  }

  function capture() {
    if (restoring) return;
    const { convo } = elements();
    if (!convo) return;
    const turns = Array.from(convo.querySelectorAll(".turn"));
    if (!turns.length) { anchor = null; return; }
    const convoTop = convo.getBoundingClientRect().top;
    const found = turns.findIndex((turn) => turn.getBoundingClientRect().bottom > convoTop + 8);
    const index = found < 0 ? turns.length - 1 : found;
    anchor = { index, offset: turns[index].getBoundingClientRect().top - convoTop };
  }

  function restore() {
    const { convo } = elements();
    if (!anchor || !convo) return;
    const turn = convo.querySelectorAll(".turn")[anchor.index];
    if (!turn) return;
    const currentOffset = turn.getBoundingClientRect().top - convo.getBoundingClientRect().top;
    convo.scrollTop += currentOffset - anchor.offset;
  }

  function layoutChanged() {
    if (resizePending) return;
    resizePending = true;
    restoring = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      restore();
      sync();
      restoring = false;
      resizePending = false;
      capture();
    }));
  }

  function init() {
    const { convo, bar, thumb } = elements();
    if (!convo || !bar || !thumb) return;
    const seek = (clientY) => {
      const track = bar.getBoundingClientRect();
      const travel = Math.max(1, track.height - thumb.offsetHeight);
      const ratio = Math.max(0, Math.min(1, (clientY - track.top - pointerOffset) / travel));
      convo.scrollTop = ratio * Math.max(0, convo.scrollHeight - convo.clientHeight);
    };
    bar.addEventListener("pointerdown", (event) => {
      if (!compactQuery.matches || !document.body.classList.contains("has-history-scroll")) return;
      pointerOffset = event.target === thumb
        ? event.clientY - thumb.getBoundingClientRect().top
        : thumb.offsetHeight / 2;
      dragging = true;
      bar.classList.add("dragging");
      bar.setPointerCapture?.(event.pointerId);
      seek(event.clientY);
      event.preventDefault();
    });
    bar.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      seek(event.clientY);
      event.preventDefault();
    });
    const stop = (event) => {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove("dragging");
      bar.releasePointerCapture?.(event.pointerId);
    };
    bar.addEventListener("pointerup", stop);
    bar.addEventListener("pointercancel", stop);
    if (compactQuery.addEventListener) compactQuery.addEventListener("change", layoutChanged);
    else compactQuery.addListener?.(layoutChanged);
    window.addEventListener("resize", layoutChanged);
    window.visualViewport?.addEventListener("resize", layoutChanged);
    if (window.ResizeObserver) {
      observer?.disconnect();
      observer = new ResizeObserver(layoutChanged);
      observer.observe(convo);
    }
    capture();
    sync();
  }

  return { init, sync, capture, layoutChanged };
})();
// scrim 用 .show(opacity 过渡)而非 .hidden(display 切换吃不了 transition)——抽屉开合背板渐显。
function openDrawer(id) { $(id).classList.add("open"); $("#scrim").classList.add("show"); }
function closeDrawers() { $("#rail").classList.remove("open"); $("#panel").classList.remove("open"); $("#scrim").classList.remove("show"); }

// ---- 弹层(二次确认 / 演员手记):点背板或 Esc 关闭 ----
let _modalClose = null;
function openModal(node, onClose) {
  const m = $("#modal");
  m.innerHTML = ""; m.appendChild(node);
  m.classList.remove("hidden");
  _modalClose = onClose || null;
  m.onclick = (e) => { if (e.target === m) closeModal(); };
  document.addEventListener("keydown", modalEsc);
}
function closeModal() {
  const m = $("#modal");
  if (m.classList.contains("hidden")) return;
  m.classList.add("hidden"); m.innerHTML = "";
  document.removeEventListener("keydown", modalEsc);
  const cb = _modalClose; _modalClose = null; if (cb) cb();
}

function modalEsc(e) { if (e.key === "Escape") closeModal(); }

// 二次确认(不可逆动作):返回 Promise<bool>。背板/Esc/取消 → false。
function confirmDialog({ title, body, confirmLabel }) {
  confirmLabel = confirmLabel || t("delete");
  return new Promise((resolve) => {
    let decided = false;
    const card = el("div", "modalCard");
    card.innerHTML = `<p class="modalTitle">${esc(title)}</p>
      <p class="modalBody">${esc(body)}</p>
      <div class="modalActs"><button class="mBtnCancel">${esc(t("cancel"))}</button>
      <button class="mBtnDanger">${esc(confirmLabel)}</button></div>`;
    openModal(card, () => { if (!decided) resolve(false); });
    const done = (v) => { decided = true; closeModal(); resolve(v); };
    card.querySelector(".mBtnCancel").onclick = () => done(false);
    card.querySelector(".mBtnDanger").onclick = () => done(true);
  });
}

async function askDeleteProduction(id) {
  const p = state.productions.find((x) => x.id === id);
  if (!p) return;
  const ok = await confirmDialog({
    title: t("prodDeleteTitle", { name: p.name }),
    body: t("prodDeleteBody"),
  });
  if (!ok) return;
  try {
    const prepared = await bridge.event({
      type: "prepare_delete_production",
      production_id: id,
    });
    await bridge.event({
      type: "delete_production",
      production_id: id,
      confirmation_token: prepared.confirmation_token,
    });
    await loadAll();   // server 已切好 active,loadAll 重渲染
    toast(t("prodDeleted"));
  } catch (e) { toast(t("prodDeleteFailed", { err: e.message })); }
}

// ---- 文本模型：官方目录由 Tavern 固定提供；自定义 OpenAI-compatible API 由 reader 管理。----
async function refreshModels() {
  try {
    const mr = await bridge.get("/api/models");
    if (mr && mr.configs) state.models = mr;
  } catch (_) { /* 刷新失败保留旧列表,操作路径各自有 toast */ }
  renderPanel();
  renderModelSheet();
}

function openModelSheet() {
  closeDrawers();
  const card = el("div", "modalCard sheetCard");
  card.innerHTML = `<div class="sheetHd"><span class="t">${esc(t("modelSheetTitle"))}</span>
      <button class="sheetClose" aria-label="${esc(t("ariaClose"))}">✕</button></div>
    <div class="sheetBody"><div id="mcBody"></div></div>`;
  openModal(card);
  card.querySelector(".sheetClose").onclick = closeModal;
  renderModelSheet();
  refreshModels();
}

function renderModelSheet() {
  const box = document.getElementById("mcBody");
  if (!box) return;  // sheet 没开着(如乐观切换回滚时),只有 panel 需要刷
  const ms = state.models || { configs: [], active: "builtin" };
  const official = ms.configs.filter((c) => c.kind === "official" || c.builtin);
  const custom = ms.configs.filter((c) => c.kind === "custom" || !c.builtin);
  const rows = (configs) => configs.map((c) => {
    const meta = c.builtin
      ? t("modelClawlingMeta", { model: c.model || "" })
      : t("modelKeyMeta", { model: c.model, mask: c.key_masked || "**" });
    const del = c.builtin ? ""
      : `<button class="mcDel" data-del="${c.id}" aria-label="${esc(t("ariaDeleteConfig"))}" title="${esc(t("ariaDeleteConfig"))}">${TRASH_SVG}</button>`;
    return `<div class="mcItem ${c.id === ms.active ? "active" : ""}" data-use="${c.id}">
      <div class="mcInfo"><div class="mcName">${esc(modelDisplayName(c))}</div><div class="mcMeta">${esc(meta)}</div></div>
      <span class="mcCheck">✓</span>${del}</div>`;
  }).join("");
  box.innerHTML = `<section class="mcGroup">
      <div class="mcGroupHead"><span>${esc(t("modelOfficialGroup"))}</span></div>
      ${rows(official)}
    </section>
    <section class="mcGroup">
      <div class="mcGroupHead"><span>${esc(t("modelCustomGroup"))}</span>
        <button class="actorMore mcAdd" id="modelAddCustom">${PLUS_SVG}${esc(t("modelAddCustom"))}</button></div>
      <p class="mcAgentHint">${esc(t("modelCustomAgentHint"))}</p>
      ${custom.length ? rows(custom) : `<p class="mcEmpty">${esc(t("modelCustomEmpty"))}</p>`}
    </section>`;
  box.querySelectorAll("[data-use]").forEach((d) => d.onclick = () => useModel(d.dataset.use));
  box.querySelectorAll("[data-del]").forEach((b) =>
    b.onclick = (e) => { e.stopPropagation(); askDeleteModel(b.dataset.del); });
  const add = document.getElementById("modelAddCustom");
  if (add) add.onclick = openModelConfigSheet;
}

function openModelConfigSheet() {
  const card = el("div", "modalCard sheetCard modelConfigSheet");
  card.innerHTML = `<div class="sheetHd"><span class="t">${esc(t("modelConfigTitle"))}</span>
      <button class="sheetClose" aria-label="${esc(t("ariaClose"))}">✕</button></div>
    <div class="sheetBody"><form id="modelConfigForm" class="modelConfigForm">
      <label class="fieldLabel">${esc(t("modelConfigName"))}<input class="formControl" id="modelConfigName" maxlength="60" autocomplete="off" placeholder="${esc(t("modelConfigNamePlaceholder"))}" required></label>
      <label class="fieldLabel">${esc(t("modelConfigBase"))}<input class="formControl" id="modelConfigBase" type="url" inputmode="url" autocomplete="url" spellcheck="false" placeholder="https://api.example.com/v1" required></label>
      <label class="fieldLabel">${esc(t("modelConfigId"))}<input class="formControl" id="modelConfigId" autocomplete="off" spellcheck="false" placeholder="${esc(t("modelConfigIdPlaceholder"))}" required></label>
      <label class="fieldLabel">${esc(t("modelConfigKey"))}<input class="formControl" id="modelConfigKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="sk-..." required></label>
      <p class="modelConfigNote">${esc(t("modelConfigNote"))}</p>
    </form></div>
    <div class="sheetActions"><button class="btn ghost" id="modelConfigCancel">${esc(t("cancel"))}</button><button class="btn" id="modelConfigSave">${esc(t("modelConfigSave"))}</button></div>`;
  openModal(card);
  card.querySelector(".sheetClose").onclick = closeModal;
  card.querySelector("#modelConfigCancel").onclick = openModelSheet;
  card.querySelector("#modelConfigSave").onclick = saveCustomModel;
  card.querySelector("#modelConfigForm").onsubmit = (e) => { e.preventDefault(); saveCustomModel(); };
  card.querySelector("#modelConfigName").focus();
}

async function saveCustomModel() {
  const form = document.getElementById("modelConfigForm");
  if (!form || !form.reportValidity()) return;
  const card = form.closest(".modelConfigSheet");
  const save = document.getElementById("modelConfigSave");
  const payload = {
    type: "model_add",
    name: document.getElementById("modelConfigName").value.trim(),
    base: document.getElementById("modelConfigBase").value.trim(),
    model: document.getElementById("modelConfigId").value.trim(),
    key: document.getElementById("modelConfigKey").value.trim(),
  };
  card.classList.add("saving");
  save.textContent = t("modelConfigTesting");
  try {
    const result = await bridge.event(payload);
    await refreshModels();
    toast(t("modelConfigSaved", { ms: result.latency_ms }));
    openModelSheet();
  } catch (e) {
    toast(t("modelConfigFailed", { err: e.message }));
    card.classList.remove("saving");
    save.textContent = t("modelConfigSave");
  }
}

async function useModel(id) {
  const ms = state.models;
  if (!ms || id === ms.active) return;
  const prev = ms.active;
  ms.active = id; renderModelSheet(); renderPanel();  // 乐观切换,失败回滚
  try {
    await bridge.event({ type: "model_use", id });
  } catch (e) {
    ms.active = prev; renderModelSheet(); renderPanel();
    toast(t("modelSwitchFailed", { err: e.message }));
  }
}

async function askDeleteModel(id) {
  const c = ((state.models || {}).configs || []).find((x) => x.id === id);
  if (!c) return;
  // confirmDialog 与 sheet 共用 #modal(确认框顶掉列表),答完重开 sheet 回到列表
  const ok = await confirmDialog({
    title: t("modelDeleteTitle", { name: modelDisplayName(c) }),
    body: t("modelDeleteBody"),
  });
  if (ok) {
    try {
      await bridge.event({ type: "model_delete", id });
      await refreshModels();
      toast(t("modelDeleted"));
    } catch (e) { toast(t("modelDeleteFailed", { err: e.message })); }
  }
  openModelSheet();
}

function openVoiceSheet() {
  stopSpeech();
  closeDrawers();
  const card = el("div", "modalCard sheetCard");
  card.innerHTML = `<div class="sheetHd"><span class="t">${esc(t("voiceSheetTitle"))}</span>
      <button class="sheetClose" aria-label="${esc(t("ariaClose"))}">✕</button></div>
    <div class="sheetBody"><div id="voiceBody"></div></div>`;
  openModal(card);
  card.querySelector(".sheetClose").onclick = closeModal;
  renderVoiceSheet();
}

function speedStepperHtml(id, value = 0.9) {
  const speed = Math.min(4, Math.max(0.25, Number(value) || 0.9));
  return `<div class="speedStepper" data-speed-stepper="${esc(id)}">
    <button type="button" data-speed-delta="-0.05" aria-label="${esc(t("voiceSpeedSlower"))}">−</button>
    <output>${speed.toFixed(2)}×</output>
    <button type="button" data-speed-delta="0.05" aria-label="${esc(t("voiceSpeedFaster"))}">+</button>
    <input type="hidden" value="${speed.toFixed(2)}">
  </div>`;
}

function bindSpeedStepper(root, id) {
  const stepper = root.querySelector(`[data-speed-stepper="${id}"]`);
  if (!stepper) return { value: () => 0.9 };
  const input = stepper.querySelector("input");
  const output = stepper.querySelector("output");
  const update = (next) => {
    const value = Math.min(4, Math.max(0.25, Math.round(next * 20) / 20));
    input.value = value.toFixed(2);
    output.textContent = `${value.toFixed(2)}×`;
  };
  stepper.querySelectorAll("[data-speed-delta]").forEach((button) => {
    button.onclick = () => update(Number(input.value) + Number(button.dataset.speedDelta));
  });
  return { value: () => Number(input.value) };
}

function renderVoiceSheet() {
  const box = document.getElementById("voiceBody");
  if (!box) return;
  const cfg = state.tts || { voices: [], active_voice: "vivian", active_clone_id: "", mode: "preset", clones: [], clone: {} };
  const clones = Array.isArray(cfg.clones) ? cfg.clones : (cfg.clone?.configured ? [cfg.clone] : []);
  box.innerHTML = `<div class="voiceSheetModel"><span>${esc(cfg.model_name || "Qwen TTS")}</span>
      <button class="actorMore" id="voiceCloneCreate">${PENCIL_SVG}${esc(t("voiceCloneCreate"))}</button></div>`
    + (clones.length ? `<p class="voiceModelName voiceListLabel">${esc(t("voiceCloneListLabel"))}</p>` : "")
    + clones.map((clone) => `<div class="mcItem ${cfg.mode === "clone" && clone.id === cfg.active_clone_id ? "active" : ""}" data-clone-id="${esc(clone.id)}">
        <div class="mcInfo"><div class="mcName">${esc(clone.name || t("voiceCloneDefaultName"))}</div><div class="mcMeta">${esc(t("voiceCloneMeta", { speed: Number(clone.speed || 0.9).toFixed(2) }))}</div></div>
        <span class="mcCheck">✓</span><button class="mcDel" data-clone-delete="${esc(clone.id)}" aria-label="${esc(t("voiceCloneDelete"))}">${TRASH_SVG}</button></div>`).join("")
    + `<p class="voiceModelName voiceListLabel">${esc(t("voicePresetLabel"))}</p>`
    + (cfg.voices || []).map((voice) => {
      const description = I18N.lang === "zh" ? voice.description : "";
      const setting = cfg.preset_settings?.[voice.id] || { speed: 0.9, instructions: "" };
      const detail = setting.instructions || description || t(`voiceLang_${voice.language || "chinese"}`);
      const meta = `${Number(setting.speed || 0.9).toFixed(2)}× · ${detail}`;
      return `<div class="mcItem ${cfg.mode === "preset" && voice.id === cfg.active_voice ? "active" : ""}" data-voice="${esc(voice.id)}">
        <div class="mcInfo"><div class="mcName">${esc(voice.name || voiceDisplayName(voice))}</div><div class="mcMeta">${esc(meta)}</div></div>
        <div class="mcTools"><button class="mcIcon" data-voice-preview="${esc(voice.id)}" aria-label="${esc(t("voicePreview"))}" title="${esc(t("voicePreview"))}">${SPEAKER_SVG}</button>
        <button class="mcIcon" data-voice-settings="${esc(voice.id)}" aria-label="${esc(t("voiceSettings"))}" title="${esc(t("voiceSettings"))}">${SLIDERS_SVG}</button></div>
        <span class="mcCheck">✓</span></div>`;
    }).join("");
  const create = document.getElementById("voiceCloneCreate");
  if (create) create.onclick = openVoiceCloneSheet;
  box.querySelectorAll("[data-clone-id]").forEach((row) => row.onclick = () => useCloneVoice(row.dataset.cloneId));
  box.querySelectorAll("[data-clone-delete]").forEach((button) => {
    button.onclick = (event) => { event.stopPropagation(); deleteCloneVoice(button.dataset.cloneDelete); };
  });
  box.querySelectorAll("[data-voice]").forEach((row) => row.onclick = () => useVoice(row.dataset.voice));
  box.querySelectorAll("[data-voice-preview]").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      const voice = button.dataset.voicePreview;
      const setting = cfg.preset_settings?.[voice] || { speed: 0.9, instructions: "" };
      previewPresetVoice(button, { voice, ...setting });
    };
  });
  box.querySelectorAll("[data-voice-settings]").forEach((button) => {
    button.onclick = (event) => { event.stopPropagation(); openPresetVoiceSettings(button.dataset.voiceSettings); };
  });
}

async function useCloneVoice(cloneId) {
  if (!cloneId || (state.tts?.mode === "clone" && state.tts?.active_clone_id === cloneId)) return;
  try {
    const result = await bridge.event({ type: "tts_clone_use", clone_id: cloneId });
    state.tts = result.tts;
    renderVoiceSheet(); renderPanel();
    toast(t("voiceCloneSelected"));
  } catch (e) {
    toast(t("voiceSwitchFailed", { err: e.message }));
  }
}

async function useVoice(voice) {
  const cfg = state.tts;
  if (!cfg || (cfg.mode === "preset" && voice === cfg.active_voice)) return;
  const previous = cfg.active_voice;
  const previousMode = cfg.mode;
  cfg.active_voice = voice;
  cfg.mode = "preset";
  renderVoiceSheet(); renderPanel();
  try {
    const result = await bridge.event({ type: "tts_voice_use", voice });
    state.tts = result.tts;
    toast(t("voiceSelected", { voice: voiceDisplayName(voice) }));
  } catch (e) {
    cfg.active_voice = previous;
    cfg.mode = previousMode;
    renderVoiceSheet(); renderPanel();
    toast(t("voiceSwitchFailed", { err: e.message }));
  }
}

async function previewPresetVoice(button, payload) {
  if (speechState.button === button && speechState.audio) {
    return toggleSpeech(button);
  }
  stopSpeech();
  const controller = new AbortController();
  speechState.button = button;
  speechState.controller = controller;
  button.disabled = true;
  button.classList.add("busy");
  button.setAttribute("aria-label", t("voiceLoading"));
  try {
    const blob = await bridge.speechPreview(payload, controller.signal);
    if (speechState.controller !== controller) return;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    speechState.audio = audio;
    speechState.url = url;
    speechState.controller = null;
    button.disabled = false;
    button.classList.remove("busy");
    button.innerHTML = PAUSE_SVG;
    button.classList.add("playing");
    audio.onended = stopSpeech;
    audio.onerror = () => { stopSpeech(); toast(t("voiceFailed", { err: "audio playback" })); };
    await audio.play();
  } catch (e) {
    if (e.name !== "AbortError") toast(t("voiceFailed", { err: e.message }));
    stopSpeech();
  }
}

function openPresetVoiceSettings(voiceId) {
  stopSpeech();
  const cfg = state.tts || {};
  const voice = (cfg.voices || []).find((item) => item.id === voiceId);
  if (!voice) return;
  const setting = cfg.preset_settings?.[voiceId] || { speed: 0.9, instructions: "" };
  const card = el("div", "modalCard sheetCard voiceSettingsSheet");
  card.innerHTML = `<div class="sheetHd"><span class="t">${esc(voice.name || voiceDisplayName(voice))}</span>
      <button class="sheetClose" aria-label="${esc(t("ariaClose"))}">✕</button></div>
    <div class="sheetBody voiceSettingsForm">
      <label class="fieldLabel"><span>${esc(t("voiceSpeed"))}</span>${speedStepperHtml("presetSpeed", setting.speed)}</label>
      <label class="fieldLabel">${esc(t("voiceInstructions"))}<textarea class="formControl voiceInstructions" id="voiceInstructions" maxlength="1000" placeholder="${esc(t("voiceInstructionsPlaceholder"))}">${esc(setting.instructions || "")}</textarea></label>
    </div>
    <div class="sheetActions voiceSettingsActions"><button class="btn ghost previewIconBtn" id="voicePreview" aria-label="${esc(t("voicePreview"))}" title="${esc(t("voicePreview"))}">${SPEAKER_SVG}</button><button class="btn" id="voiceSettingsSave">${esc(t("save"))}</button></div>`;
  openModal(card);
  const speed = bindSpeedStepper(card, "presetSpeed");
  const instructions = card.querySelector("#voiceInstructions");
  card.querySelector(".sheetClose").onclick = openVoiceSheet;
  card.querySelector("#voicePreview").onclick = (event) => previewPresetVoice(event.currentTarget, {
    voice: voiceId, speed: speed.value(), instructions: instructions.value.trim(),
  });
  card.querySelector("#voiceSettingsSave").onclick = async (event) => {
    const save = event.currentTarget;
    save.disabled = true;
    try {
      const result = await bridge.event({ type: "tts_preset_settings", voice: voiceId,
        speed: speed.value(), instructions: instructions.value.trim() });
      state.tts = result.tts;
      openVoiceSheet(); renderPanel();
      toast(t("voiceSettingsSaved"));
    } catch (e) {
      save.disabled = false;
      toast(t("voiceSettingsSaveFailed", { err: e.message }));
    }
  };
}

function readFileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(t("voiceCloneReadFailed")));
    reader.readAsDataURL(file);
  });
}

function openVoiceCloneSheet() {
  const card = el("div", "modalCard sheetCard cloneSheet");
  card.innerHTML = `<div class="sheetHd"><span class="t">${esc(t("voiceCloneTitle"))}</span>
      <button class="sheetClose" aria-label="${esc(t("ariaClose"))}">✕</button></div>
    <div class="sheetBody cloneForm">
      <label class="fieldLabel">${esc(t("voiceCloneName"))}<input class="formControl" id="cloneName" maxlength="40"></label>
      <label class="fieldLabel">${esc(t("voiceCloneAudio"))}<input class="formControl cloneFile" id="cloneAudio" type="file" accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/aac,audio/ogg,audio/flac"><small>${esc(t("voiceCloneAudioHint"))}</small></label>
      <label class="fieldLabel">${esc(t("voiceCloneTranscript"))}<textarea class="formControl cloneTranscript" id="cloneTranscript" maxlength="4096" placeholder="${esc(t("voiceCloneTranscriptPlaceholder"))}"></textarea></label>
      <label class="fieldLabel"><span>${esc(t("voiceSpeed"))}</span>${speedStepperHtml("cloneSpeed", 0.9)}</label>
    </div>
    <div class="sheetActions"><button class="btn ghost" id="cloneCancel">${esc(t("cancel"))}</button><button class="btn" id="cloneSave">${esc(t("save"))}</button></div>`;
  openModal(card);
  card.querySelector("#cloneName").value = t("voiceCloneDefaultName");
  const speed = bindSpeedStepper(card, "cloneSpeed");
  card.querySelector(".sheetClose").onclick = openVoiceSheet;
  card.querySelector("#cloneCancel").onclick = openVoiceSheet;
  card.querySelector("#cloneSave").onclick = async () => {
    const file = card.querySelector("#cloneAudio").files[0];
    const refText = card.querySelector("#cloneTranscript").value.trim();
    const name = card.querySelector("#cloneName").value.trim();
    if (!file) return toast(t("voiceCloneAudioRequired"));
    if (file.size > 10 * 1024 * 1024) return toast(t("voiceCloneAudioTooLarge"));
    if (!refText) return toast(t("voiceCloneTranscriptRequired"));
    const save = card.querySelector("#cloneSave");
    save.disabled = true;
    save.textContent = t("saving");
    try {
      const audio = await readFileDataUrl(file);
      const result = await bridge.saveVoiceClone({ audio, ref_text: refText, name, speed: speed.value() });
      state.tts = result.tts;
      openVoiceSheet(); renderPanel();
      toast(t("voiceCloneSaved"));
    } catch (e) {
      save.disabled = false;
      save.textContent = t("save");
      toast(t("voiceCloneSaveFailed", { err: e.message }));
    }
  };
}

async function deleteCloneVoice(cloneId) {
  if (!cloneId) return;
  const ok = await confirmDialog({ title: t("voiceCloneDeleteTitle"), body: t("voiceCloneDeleteBody") });
  if (!ok) return openVoiceSheet();
  try {
    const result = await bridge.event({ type: "tts_clone_delete", clone_id: cloneId });
    state.tts = result.tts;
    openVoiceSheet(); renderPanel();
    toast(t("voiceCloneDeleted"));
  } catch (e) {
    openVoiceSheet();
    toast(t("voiceCloneDeleteFailed", { err: e.message }));
  }
}

// 软键盘弹起把可视视口压小:iOS WKWebView 不认 interactive-widget/dvh 的键盘收缩,
// 用 visualViewport 把 body 高度贴到可视视口(Android 由 meta interactive-widget+dvh 覆盖)。
// 同时打 body.kbd 标:键盘在场时 composer 收掉手势条安全区垫高(贴键盘,不留空白条)。
function keyboardInset() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    document.body.style.height = vv.height + "px";
    document.body.classList.toggle("kbd", vv.height < window.innerHeight * 0.8);
  };
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  apply();
}

function wire() {
  I18N.applyStatic();  // 静态 data-i18n 节点按解析出的语言填一遍(html 里的中文只是闪现兜底)
  $("#stage").dataset.drophint = t("dropHint");  // 拖入高亮的文案(CSS content:attr 读)
  $("#composer").onsubmit = (e) => { e.preventDefault(); submitOrStop(); };
  const input = $("#input");
  input.oninput = (e) => { autoGrow(e.target); updateSendEmpty(); };
  // IME 守卫(含 macOS WKWebView/WebKit 修正):
  // - Chromium:合成中的 Enter 带 isComposing=true / keyCode=229,直接挡。
  // - WebKit(macOS 容器 + Safari):compositionend 排在「确认候选词」的 Enter keydown **之前**,
  //   那个 keydown 的 isComposing 已是 false、keyCode=13 → 光靠 isComposing/229 挡不住(实测仍误发)。
  //   故再记一个「刚合成完」时间窗(CodeMirror/ProseMirror 同款),把紧跟其后的回车也判为确认、不发送。
  let imeComposing = false, imeEndedAt = 0;
  input.addEventListener("compositionstart", () => { imeComposing = true; });
  input.addEventListener("compositionend", () => { imeComposing = false; imeEndedAt = Date.now(); });
  input.onkeydown = (e) => {
    if (e.isComposing || e.keyCode === 229 || imeComposing) return;
    // Ctrl/⌘+I = 动作标记(动作渲染就是斜体,借斜体的通用键;Cmd 或 Ctrl 都认,不分平台)
    if ((e.metaKey || e.ctrlKey) && (e.key === "i" || e.key === "I")) {
      e.preventDefault(); wrapAction(); return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (Date.now() - imeEndedAt < 120) return; // 刚确认候选词的那个回车(WebKit 排序),别当发送
      e.preventDefault(); submitOrStop();
    }
  };
  $("#actBtn").onclick = () => wrapAction();
  $("#cardFile").onchange = (e) => { importCard(e.target.files[0]); e.target.value = ""; };
  $("#newWorldBtn").onclick = openNewWorldSheet;
  wireDropImport();
  const railToggle = $("#railToggle");
  if (railToggle) railToggle.onclick = () => openDrawer("#rail");
  const panelToggle = $("#panelToggle");
  if (panelToggle) panelToggle.onclick = () => openDrawer("#panel");
  $("#scrim").onclick = closeDrawers;
  // 生成中用户主动上滚(回看历史)→ 停止自动锚定,别跟用户抢;下一回合 force 重置。
  $("#convo").addEventListener("scroll", () => {
    if (state.busy && state._anchor != null && state._anchor - $("#convo").scrollTop > 24) state.stick = false;
    historyNavigator.sync();
    historyNavigator.capture();
  }, { passive: true });
  historyNavigator.init();
  setComposerSending(false);   // 初始 SVG 发送图标 + 空态
}

keyboardInset();
loadIdentity()
  .finally(() => {
    wire();
    loadAll().catch((e) => toast(t("loadFailed", { err: e.message })));
  });
