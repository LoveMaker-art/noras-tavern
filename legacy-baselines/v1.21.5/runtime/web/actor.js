// actor.js — 故事档案 reader。取 /api/actor_card 聚合数据 → 渲染主理人的生涯/亲密度/口味/年表。
// 展示 surface，无渐进披露、无原生手势（liveware-frontend §1）。词汇：戏路≠搭档，口味≠年表。
// 文案走 i18n.js(locale contract);亲密度级名/blurb 是 server 下发的 UI 标签,
// 由 /api/actor_card?lang= 按语言给(server 端 INTIMACY_*_EN)。
'use strict';
const t = I18N.t;
const { escapeHtml: esc, safeSameOriginTarget } = TavernUI;

async function loadIdentity() {
  try {
    const r = await fetch('/api/identity');
    I18N.setIdentity(await r.json());
  } catch (_) {}
}

// 累计字:zh ≥1万显「X.X万」;en 用 k(12.3k)。整数直显(actor-card §6 数值格式)。
function fmtWords(n) {
  n = Math.round(n || 0);
  if (I18N.lang === 'zh') return n >= 10000 ? (n / 10000).toFixed(1) + t('wan') : String(n);
  return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

// 值 + 单位小字 + 标签:「3 天 / 出道」连读成词，标签单看也成立（actor-card 数值文案）。
function stat(v, unit, label) {
  return `<div class="acStat"><div class="acStatV">${esc(v)}${unit ? `<span class="acStatU">${esc(unit)}</span>` : ''}</div><div class="acStatL">${esc(label)}</div></div>`;
}

function render(d) {
  const c = d.career || {}, it = d.intimacy || {};
  const knows = (d.knows || []).filter(Boolean);
  const tl = d.timeline || [];

  // 亲密度不进数值格（它有自己的整张卡，紧挨其下，连显两遍是冗余）；第 6 格给年表笔数。
  const stats = [
    stat(c.debut_days, t('statDebutUnit'), t('statDebut')),
    stat(c.turns, t('statPlayedUnit'), t('statPlayed')),
    stat(fmtWords(c.words), t('statWrittenUnit'), t('statWritten')),
    stat(c.productions, t('statProdsUnit'), t('statProds')),
    stat(c.roles, t('statRolesUnit'), t('statRoles')),   // 戏路 = 演过的角色数（不是搭档）
    stat(it.log || 0, t('statTimelineUnit'), t('statTimeline')),
  ].join('');

  const pct = Math.max(0, Math.min(100, Math.round(Number(it.progress || 0) * 100) || 0));
  const sub = t('intimacySub', { n: c.turns || 0, m: it.log || 0 });  // 笔 = 年表条数（非口味）
  // to_next 以「轮」计(1 轮 = 1 分;复盘记一笔年表 = 8 分,会跳级)——给用户可预期的最慢路径
  const foot = it.next
    ? `<span>${esc(it.blurb || '')}</span><span>${esc(t('intimacyToNext', { next: it.next, n: Math.max(0, it.to_next || 0) }))}</span>`
    : `<span>${esc(it.blurb || '')}</span><span>${esc(t('intimacyMax'))}</span>`;
  const intimacy = `
    <div class="acIntimacy">
      <div class="acIntHead"><span class="acIntLevel">${esc(it.level || '')}</span><span class="acIntSub">${esc(sub)}</span></div>
      <div class="acProg"><div class="acProgBar" style="width:${pct}%"></div></div>
      <div class="acIntFoot">${foot}</div>
    </div>`;

  const knowsBlock = `
    <div class="acSec">
      <div class="pHead">${esc(t('acKnowsHead'))}</div>
      ${knows.length
        ? `<ul class="acKnows">${knows.map((k) => `<li class="acKnow">${esc(k)}</li>`).join('')}</ul>`
        : `<div class="acEmpty2">${esc(t('acKnowsEmpty'))}</div>`}
    </div>`;

  const timelineBlock = `
    <div class="acSec">
      <div class="acSecHead"><span class="pHead">${esc(t('acTimelineHead'))}</span>${tl.length ? `<span class="acCount">${esc(t('acEntriesCount', { n: tl.length }))}</span>` : ''}</div>
      ${tl.length
        ? `<div class="acTimeline">${tl.map((e) => `
            <div class="acEntry">
              <div class="acEntryMeta">${esc([e.date, e.reason].filter(Boolean).join(' · '))}</div>
              <div class="acEntryText">${esc(e.change)}</div>
            </div>`).join('')}</div>`
        : `<div class="acEmpty2">${esc(t('acTimelineEmpty'))}</div>`}
    </div>`;

  document.getElementById('acRoot').innerHTML = `
    <div class="acHero">
      <div class="acAvatar">✦</div>
      <div class="acName">${esc(d.name || t('acNameFallback'))}</div>
      <div class="acTagline">${esc(d.tagline || '')}</div>
    </div>
    <div class="acStats">${stats}</div>
    ${intimacy}
    ${knowsBlock}
    ${timelineBlock}`;
}

async function load() {
  try {
    // lang 透传给 server:亲密度级名/blurb 是 server 下发的 UI 标签,按语言给
    const r = await fetch('/api/actor_card?lang=' + encodeURIComponent(I18N.lang));
    render(await r.json());
  } catch (e) {
    document.getElementById('acRoot').innerHTML =
      `<div class="acEmpty">${esc(t('acLoadFailed', { err: e.message || e }))}</div>`;
  }
}

// 从酒馆页内跳来(?from=console)才显返回——独立打开故事档案活件时无处可返(liveware-frontend §3)。
if (new URLSearchParams(location.search).get('from') === 'console') {
  const b = document.getElementById('acBack');
  if (b) {
    b.classList.remove('hidden');
    b.onclick = () => {
      const ret = new URLSearchParams(location.search).get('return');
      const target = safeSameOriginTarget(ret);
      if (target) location.href = target;
      else if (history.length > 1) history.back();
      else location.href = '/';
    };
  }
}
loadIdentity().finally(() => {
  I18N.applyStatic();
  load();
});
