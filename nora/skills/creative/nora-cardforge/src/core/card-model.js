const crypto = require('crypto');

function createEmptyCard() {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '',
      description: '',
      personality: '',
      scenario: '',
      first_mes: '',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      tags: [],
      creator: '',
      character_version: '1.0',
      alternate_greetings: [],
      extensions: {
        talkativeness: '0.5',
        fav: false,
        world: '',
        depth_prompt: { prompt: '', depth: 4, role: 'system' },
        regex_scripts: [],
        tavern_helper: { scripts: [], variables: {} }
      },
      group_only_greetings: [],
      character_book: {
        name: '',
        entries: []
      }
    }
  };
}

function normalizeCard(raw) {
  let card;
  if (raw && raw.data) {
    card = clone(raw);
  } else if (raw && (raw.name || raw.first_mes || raw.description)) {
    card = createEmptyCard();
    card.data = { ...card.data, ...clone(raw) };
  } else {
    throw new Error('Input is not a recognizable SillyTavern character card');
  }

  card.spec = card.spec || 'chara_card_v2';
  card.spec_version = card.spec_version || '2.0';
  const d = card.data || {};
  card.data = d;
  d.name = d.name || '';
  d.description = d.description || '';
  d.personality = d.personality || '';
  d.scenario = d.scenario || '';
  d.first_mes = d.first_mes || '';
  d.mes_example = d.mes_example || '';
  d.creator_notes = d.creator_notes || d.creatorcomment || '';
  d.system_prompt = d.system_prompt || '';
  d.post_history_instructions = d.post_history_instructions || '';
  d.tags = Array.isArray(d.tags) ? d.tags : [];
  d.alternate_greetings = Array.isArray(d.alternate_greetings) ? d.alternate_greetings : [];
  d.group_only_greetings = Array.isArray(d.group_only_greetings) ? d.group_only_greetings : [];
  d.extensions = d.extensions || {};
  d.extensions.regex_scripts = Array.isArray(d.extensions.regex_scripts) ? d.extensions.regex_scripts : [];
  d.extensions.depth_prompt = d.extensions.depth_prompt || { prompt: '', depth: 4, role: 'system' };
  d.extensions.tavern_helper = normalizeTavernHelper(d.extensions.tavern_helper);
  d.character_book = d.character_book || { name: '', entries: [] };
  d.character_book.extensions = d.character_book.extensions && typeof d.character_book.extensions === 'object'
    ? d.character_book.extensions
    : {};
  d.character_book.entries = Array.isArray(d.character_book.entries) ? d.character_book.entries : [];

  d.character_book.entries.forEach((entry, index) => normalizeWorldEntry(entry, index));
  d.extensions.regex_scripts.forEach(normalizeRegexScript);
  d.extensions.tavern_helper.scripts.forEach(normalizeTavernScript);
  return card;
}

function normalizeTavernHelper(value) {
  if (Array.isArray(value)) {
    const out = {};
    for (const item of value) {
      if (Array.isArray(item) && item.length >= 2) out[item[0]] = item[1];
    }
    value = out;
  }
  const helper = value && typeof value === 'object' ? value : {};
  helper.scripts = Array.isArray(helper.scripts) ? helper.scripts : [];
  helper.variables = helper.variables && typeof helper.variables === 'object' ? helper.variables : {};
  return helper;
}

function normalizeWorldEntry(entry, index) {
  entry.id = Number.isInteger(entry.id) ? entry.id : index;
  entry.keys = Array.isArray(entry.keys) ? entry.keys : (Array.isArray(entry.key) ? entry.key : []);
  entry.secondary_keys = Array.isArray(entry.secondary_keys) ? entry.secondary_keys : (Array.isArray(entry.keysecondary) ? entry.keysecondary : []);
  entry.comment = entry.comment || '';
  entry.content = entry.content || '';
  entry.constant = !!entry.constant;
  entry.selective = !!entry.selective;
  entry.insertion_order = Number.isFinite(entry.insertion_order) ? entry.insertion_order : 100;
  entry.enabled = entry.enabled !== false && entry.disable !== true;
  entry.position = entry.position || 'before_char';
  entry.use_regex = !!entry.use_regex;
  entry.extensions = entry.extensions || {};
  entry.extensions.display_index = Number.isFinite(entry.extensions.display_index) ? entry.extensions.display_index : index;
  entry.extensions.position = Number.isFinite(entry.extensions.position)
    ? entry.extensions.position
    : (entry.position === 'after_char' ? 1 : 0);
  entry.extensions.depth = Number.isFinite(entry.extensions.depth) ? entry.extensions.depth : 4;
  entry.extensions.probability = Number.isFinite(entry.extensions.probability) ? entry.extensions.probability : 100;
  entry.extensions.useProbability = entry.extensions.useProbability !== false;
  entry.extensions.exclude_recursion = !!entry.extensions.exclude_recursion;
  entry.extensions.prevent_recursion = !!entry.extensions.prevent_recursion;
  return entry;
}

function normalizeRegexScript(script) {
  script.id = script.id || crypto.randomUUID();
  script.scriptName = script.scriptName || '未命名正则';
  script.findRegex = script.findRegex || '';
  script.replaceString = script.replaceString || '';
  script.trimStrings = Array.isArray(script.trimStrings) ? script.trimStrings : [];
  script.placement = Array.isArray(script.placement) ? script.placement : [2];
  script.disabled = !!script.disabled;
  script.markdownOnly = !!script.markdownOnly;
  script.promptOnly = !!script.promptOnly;
  script.runOnEdit = script.runOnEdit !== false;
  script.substituteRegex = Number.isFinite(script.substituteRegex) ? script.substituteRegex : 0;
  return script;
}

function normalizeTavernScript(script) {
  script.type = script.type || 'script';
  script.enabled = script.enabled !== false;
  script.name = script.name || '未命名脚本';
  script.id = script.id || crypto.randomUUID();
  script.content = script.content || '';
  script.info = script.info || '';
  script.button = script.button || { enabled: false, buttons: [] };
  script.button.buttons = Array.isArray(script.button.buttons) ? script.button.buttons : [];
  script.data = script.data || {};
  return script;
}

function exportCardV2(card) {
  const normalized = normalizeCard(card);
  const d = normalized.data;
  const output = clone(normalized);
  output.spec = 'chara_card_v2';
  output.spec_version = '2.0';
  output.data = clone(d);
  removeV1Mirrors(output);
  return output;
}

function exportCardV3(card) {
  const normalized = normalizeCard(card);
  const d = clone(normalized.data);
  d.group_only_greetings = Array.isArray(d.group_only_greetings) ? d.group_only_greetings : [];
  d.source = Array.isArray(d.source) ? d.source : [];
  const output = clone(normalized);
  output.spec = 'chara_card_v3';
  output.spec_version = '3.0';
  output.data = d;
  removeV1Mirrors(output);
  return output;
}

function exportCardJson(card) {
  return exportCardV2(card);
}

function removeV1Mirrors(output) {
  // ST's validator checks V1 first. These aliases make valid V2 JSON look like
  // V1 and World Core rejects it. Narrative fields are owned by data in V2/V3;
  // other vendor/root metadata remains untouched.
  for (const field of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example']) delete output[field];
}

function summarizeCard(card) {
  const normalized = normalizeCard(card);
  const d = normalized.data;
  const entries = d.character_book.entries;
  const regexScripts = d.extensions.regex_scripts;
  const tavernScripts = d.extensions.tavern_helper.scripts;
  const enabledEntries = entries.filter(e => e.enabled);
  const constantEntries = enabledEntries.filter(e => e.constant);
  const mvuVarGroups = d.extensions.cfMvuVarGroups || [];
  const hasStatusbar = regexScripts.some(s => ['状态栏美化', '状态栏'].includes(s.scriptName));
  return {
    name: d.name || '',
    spec: normalized.spec,
    specVersion: normalized.spec_version,
    fields: {
      hasDescription: !!d.description,
      hasPersonality: !!d.personality,
      hasScenario: !!d.scenario,
      hasFirstMessage: !!d.first_mes,
      alternateGreetings: d.alternate_greetings.length
    },
    worldbook: {
      total: entries.length,
      enabled: enabledEntries.length,
      constant: constantEntries.length,
      triggered: enabledEntries.length - constantEntries.length
    },
    regexScripts: regexScripts.length,
    tavernScripts: tavernScripts.length,
    mvu: {
      hasVarGroups: Array.isArray(mvuVarGroups) && mvuVarGroups.length > 0,
      varGroups: Array.isArray(mvuVarGroups) ? mvuVarGroups.length : 0,
      hasMagVarUpdate: tavernScripts.some(s => String(s.content || '').includes('MagVarUpdate'))
    },
    statusbar: { present: hasStatusbar }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  createEmptyCard,
  normalizeCard,
  normalizeWorldEntry,
  normalizeRegexScript,
  normalizeTavernScript,
  exportCardV2,
  exportCardV3,
  exportCardJson,
  summarizeCard,
  clone
};
