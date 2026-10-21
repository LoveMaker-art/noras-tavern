/* Story Profile labels only. Locale: URL lang → session → navigator → English.
 * Preserve {parameter} placeholders when translating. */
"use strict";
const I18N = (() => {
  const STRINGS = {
    zh: {
      docTitleActor: "故事档案",
      appWindowTitleActor: "Story Profile",
      ariaBack: "返回酒馆",
      acLoading: "读取故事档案…",
      acLoadFailed: "读不到故事档案:{err}",
      acNameFallback: "主理人",
      statDebut: "相识",
      statDebutUnit: "天",
      statPlayed: "同行",
      statPlayedUnit: "轮",
      statWritten: "累计",
      statWrittenUnit: "字",
      statProds: "世界",
      statProdsUnit: "个",
      statRoles: "角色",
      statRolesUnit: "条",
      statTimeline: "记录",
      statTimelineUnit: "笔",
      intimacySub: "一起走过 {n} 轮 · 记下你 {m} 笔",
      intimacyToNext: "距「{next}」还差 {n} 轮故事",
      intimacyMax: "已是知己",
      acKnowsHead: "我对你的了解",
      acKnowsEmpty: "还在读你的口味——多走几场我就懂了。",
      acTimelineHead: "故事年表",
      acEntriesCount: "{n} 笔",
      acTimelineEmpty: "还没有故事记录。走几场、整理几次,这里就会慢慢长出来。",
      personalityOpen: "人格设定",
      personalityTitle: "人格设定",
      personalityHint: "这里决定主理人的性格、语气与相处方式。保存后，从下一条消息开始生效。",
      personalityCancel: "取消",
      personalitySave: "保存",
      personalityDiscard: "尚未保存，确定离开吗？",
      personalityEmpty: "人格设定不能为空。",
      personalitySaving: "正在保存…",
      personalitySaved: "已保存，下一条消息起生效。",
      personalityConflict: "人格设定已在别处更新，请重新打开后再编辑。",
      personalitySaveFailed: "保存失败：{err}",
      wan: "万"
    },
    en: {
      docTitleActor: "Story Profile",
      appWindowTitleActor: "Story Profile",
      ariaBack: "Back to Tavern",
      acLoading: "Loading story profile…",
      acLoadFailed: "Couldn't load the story profile: {err}",
      acNameFallback: "Curator",
      statDebut: "Met",
      statDebutUnit: "d",
      statPlayed: "Turns",
      statPlayedUnit: "turns",
      statWritten: "Written",
      statWrittenUnit: "chars",
      statProds: "Productions",
      statProdsUnit: "",
      statRoles: "Roles",
      statRolesUnit: "",
      statTimeline: "Notes",
      statTimelineUnit: "",
      intimacySub: "{n} turns together · {m} notes on your taste",
      intimacyToNext: "{n} story turns to \"{next}\"",
      intimacyMax: "Already a confidant",
      acKnowsHead: "What I know about you",
      acKnowsEmpty: "Still reading your taste — a few scenes and I'll get it.",
      acTimelineHead: "Story timeline",
      acEntriesCount: "{n} entries",
      acTimelineEmpty: "No career entries yet. Play a few scenes, run a debrief — I'll start growing.",
      personalityOpen: "Personality",
      personalityTitle: "Personality",
      personalityHint: "Set the curator's personality, voice, and way of relating to you. Changes apply from the next message.",
      personalityCancel: "Cancel",
      personalitySave: "Save",
      personalityDiscard: "You have unsaved changes. Leave anyway?",
      personalityEmpty: "The personality document cannot be empty.",
      personalitySaving: "Saving…",
      personalitySaved: "Saved. It will apply from your next message.",
      personalityConflict: "The personality changed elsewhere. Reopen it before editing.",
      personalitySaveFailed: "Couldn't save: {err}",
      wan: "0k"
    },
  };

  // 繁體中文使用獨立文案包；內容由簡體基準逐 key 轉換並可單獨維護。
  STRINGS["zh-Hant"] =   {
      "docTitleActor": "故事檔案",
      "appWindowTitleActor": "Story Profile",
      "ariaBack": "返回酒館",
      "acLoading": "讀取故事檔案…",
      "acLoadFailed": "讀不到故事檔案:{err}",
      "acNameFallback": "主理人",
      "statDebut": "相識",
      "statDebutUnit": "天",
      "statPlayed": "同行",
      "statPlayedUnit": "輪",
      "statWritten": "累計",
      "statWrittenUnit": "字",
      "statProds": "世界",
      "statProdsUnit": "個",
      "statRoles": "角色",
      "statRolesUnit": "條",
      "statTimeline": "記錄",
      "statTimelineUnit": "筆",
      "intimacySub": "一起走過 {n} 輪 · 記下你 {m} 筆",
      "intimacyToNext": "距「{next}」還差 {n} 輪故事",
      "intimacyMax": "已是知己",
      "acKnowsHead": "我對你的瞭解",
      "acKnowsEmpty": "還在讀你的口味——多走幾場我就懂了。",
      "acTimelineHead": "故事年表",
      "acEntriesCount": "{n} 筆",
      "acTimelineEmpty": "還沒有故事記錄。走幾場、整理幾次,這裡就會慢慢長出來。",
      "personalityOpen": "人格設定",
      "personalityTitle": "人格設定",
      "personalityHint": "這裡決定主理人的性格、語氣與相處方式。儲存後，從下一則訊息開始生效。",
      "personalityCancel": "取消",
      "personalitySave": "儲存",
      "personalityDiscard": "尚未儲存，確定離開嗎？",
      "personalityEmpty": "人格設定不能為空。",
      "personalitySaving": "正在儲存…",
      "personalitySaved": "已儲存，下一則訊息起生效。",
      "personalityConflict": "人格設定已在別處更新，請重新開啟後再編輯。",
      "personalitySaveFailed": "儲存失敗：{err}",
      "wan": "萬"
    };

  Object.assign(STRINGS.zh, {
    storyRecapIntro: "回顾故事的重要进展",
    storyRecapMilestones: "故事走到这里",
    storyRecapThreads: "还未揭开的事",
    storyRecapOther: "查看其他故事",
    storyRecapLegacyEmpty: "这段故事暂时没有可展示的进展。",
    storyRecapMore: "展开更多进展与线索",
    storyRecapEarlier: "更早的进展",
    storyRecapRemaining: "其他未解事项",
    storyProgressSessions: "{n} 个会话",
    storyProgressSession: "会话：{name}",
    storyProgressCoverage: "已整理 {covered} 轮 / 当前 {total} 轮",
    storyProgressTotal: "当前共 {n} 轮",
    storyProgressActive: "已用于续写",
    storyProgressPrepared: "已整理但未用于续写",
    storyProgressDisabled: "已停用，当前不用于续写",
    storyProgressStaleCandidate: "另有待用摘要已失效；当前显示已核验的摘要。",
    storyProgressLaterFailure: "后续整理未完成，当前仍显示已保存摘要。",
    storyProgressUnorganized: "尚未整理",
    storyProgressUnknown: "进度尚无法确认；保留原有摘要与故事。",
    storyProgressFailed: "进度读取失败；未把未知进度记为零。",
    storyProgressUnavailableSession: "此故事会话当前不可读取。",
    storyProgressEvents: "关键事件",
    storyProgressThreads: "未解决事项",
    storyProgressUncovered: "最近未整理：第 {from}—{to} 轮",
    storyProgressEmpty: "还没有已整理的故事进展。",
    storyProgressUnavailable: "暂时无法读取故事进度，原有偏好和历史档案仍保留。",
    storyProgressUnknownCount: "未知",
    storyProgressUnknownWorld: "未命名故事",
    storyProgressUnknownSession: "未命名会话"
  });
  Object.assign(STRINGS.en, {
    storyRecapIntro: "Revisit the important moments in your stories",
    storyRecapMilestones: "The story so far",
    storyRecapThreads: "Still unresolved",
    storyRecapOther: "View other stories",
    storyRecapLegacyEmpty: "No story progress is available to display yet.",
    storyRecapMore: "More progress and leads",
    storyRecapEarlier: "Earlier developments",
    storyRecapRemaining: "Other unresolved matters",
    storyProgressSessions: "{n} sessions",
    storyProgressSession: "Session: {name}",
    storyProgressCoverage: "Reviewed {covered} turns / {total} current turns",
    storyProgressTotal: "{n} current turns",
    storyProgressActive: "Used for story continuation",
    storyProgressPrepared: "Reviewed, not yet used for continuation",
    storyProgressDisabled: "Disabled; not currently used for continuation",
    storyProgressStaleCandidate: "Another prepared summary is stale. The verified summary is shown.",
    storyProgressLaterFailure: "Later review did not finish. The saved summary is still shown.",
    storyProgressUnorganized: "Not reviewed yet",
    storyProgressUnknown: "Progress is unconfirmed. Existing summary and story are preserved.",
    storyProgressFailed: "Progress could not be read. Unknown progress is not counted as zero.",
    storyProgressUnavailableSession: "This story session is currently unavailable.",
    storyProgressEvents: "Key events",
    storyProgressThreads: "Unresolved threads",
    storyProgressUncovered: "Recent unreviewed turns: {from}–{to}",
    storyProgressEmpty: "No summarized story progress yet.",
    storyProgressUnavailable: "Story progress is unavailable. Existing preferences and archives are preserved.",
    storyProgressUnknownCount: "unknown",
    storyProgressUnknownWorld: "Unnamed story",
    storyProgressUnknownSession: "Unnamed session"
  });
  Object.assign(STRINGS["zh-Hant"], {
    storyRecapIntro: "回顧故事的重要進展",
    storyRecapMilestones: "故事走到這裡",
    storyRecapThreads: "還未揭開的事",
    storyRecapOther: "查看其他故事",
    storyRecapLegacyEmpty: "這段故事暫時沒有可展示的進展。",
    storyRecapMore: "展開更多進展與線索",
    storyRecapEarlier: "更早的進展",
    storyRecapRemaining: "其他未解事項",
    storyProgressSessions: "{n} 個對話",
    storyProgressSession: "對話：{name}",
    storyProgressCoverage: "已整理 {covered} 輪 / 目前 {total} 輪",
    storyProgressTotal: "目前共 {n} 輪",
    storyProgressActive: "已用於續寫",
    storyProgressPrepared: "已整理但未用於續寫",
    storyProgressDisabled: "已停用，目前不用於續寫",
    storyProgressStaleCandidate: "另有待用摘要已失效；目前顯示已核驗的摘要。",
    storyProgressLaterFailure: "後續整理未完成，目前仍顯示已儲存摘要。",
    storyProgressUnorganized: "尚未整理",
    storyProgressUnknown: "進度尚無法確認；保留原有摘要與故事。",
    storyProgressFailed: "進度讀取失敗；未把未知進度記為零。",
    storyProgressUnavailableSession: "此故事對話目前無法讀取。",
    storyProgressEvents: "關鍵事件",
    storyProgressThreads: "未解決事項",
    storyProgressUncovered: "最近未整理：第 {from}—{to} 輪",
    storyProgressEmpty: "還沒有已整理的故事進展。",
    storyProgressUnavailable: "暫時無法讀取故事進度，原有偏好和歷史檔案仍保留。",
    storyProgressUnknownCount: "未知",
    storyProgressUnknownWorld: "未命名故事",
    storyProgressUnknownSession: "未命名對話"
  });

  function normalizeLocale(value) {
    const raw = String(value || "").trim().replace(/_/g, "-").toLowerCase();
    if (!raw) return "en";
    if (["zh-hant", "zh-tw", "zh-hk", "zh-mo"].includes(raw)) {
      return "zh-Hant";
    }
    if (raw === "zh" || raw.startsWith("zh-")) return "zh";
    return "en";
  }

  // 解析链:?lang(存 session 供页内导航)→ session → navigator → en。
  function pick() {
    let raw = null;
    try {
      const q = new URLSearchParams(location.search).get("lang");
      if (q) { raw = q; sessionStorage.setItem("cc_lang", q); }
      if (!raw) raw = sessionStorage.getItem("cc_lang");
    } catch (_) { /* sessionStorage 被禁(极端隐私模式)→ 走 navigator */ }
    if (!raw) raw = navigator.language || "en";
    return normalizeLocale(raw);
  }
  const lang = pick();
  const isChinese = lang === "zh" || lang === "zh-Hant";
  function setIdentity(id) {
    if (!id || typeof id !== "object") return;
    const zhName = String(id.persona_name || "主理人");
    const zhActor = String(id.actor_name || `${zhName}的故事档案`);
    const hantActor = `${zhName}的故事檔案`;
    const enName = String(id.persona_name_en || "Curator");
    const enActor = String(id.actor_name_en || "Story Profile");

    Object.assign(STRINGS.zh, {
      docTitleActor: zhActor,
      appWindowTitleActor: enActor,
      acNameFallback: zhName
    });
    Object.assign(STRINGS["zh-Hant"], {
      docTitleActor: hantActor,
      appWindowTitleActor: enActor,
      acNameFallback: zhName
    });
    Object.assign(STRINGS.en, {
      docTitleActor: enActor,
      appWindowTitleActor: enActor,
      acNameFallback: enName
    });
  }

  function t(key, params) {
    let s = STRINGS[lang][key];
    if (s === undefined) s = STRINGS.en[key];
    if (s === undefined) s = STRINGS.zh[key];
    if (s === undefined) return key;
    if (params) {
      for (const k in params) s = s.split("{" + k + "}").join(String(params[k]));
    }
    return s;
  }

  // 静态节点填充:data-i18n(textContent)/-placeholder/-aria/-title;
  // <body data-doc-title=key> 定文档标题。动态节点由 actor.js 用 t() 拼。
  function applyStatic() {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : (lang === "zh-Hant" ? "zh-Hant" : "en");
    const dt = document.body.dataset.docTitle;
    if (dt) document.title = t(dt);
    document.querySelectorAll("[data-i18n]").forEach((e) => { e.textContent = t(e.dataset.i18n); });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((e) => { e.placeholder = t(e.dataset.i18nPlaceholder); });
    document.querySelectorAll("[data-i18n-aria]").forEach((e) => { e.setAttribute("aria-label", t(e.dataset.i18nAria)); });
    document.querySelectorAll("[data-i18n-title]").forEach((e) => { e.title = t(e.dataset.i18nTitle); });
  }

  return { t, lang, isChinese, normalizeLocale, applyStatic, setIdentity };
})();
