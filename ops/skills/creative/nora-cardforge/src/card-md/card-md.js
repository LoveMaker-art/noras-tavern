const { createEmptyCard, normalizeCard, clone } = require('../core/card-model');

const SECTION_ALIASES = new Map([
  ['description', ['description', '简介', '描述', '角色描述']],
  ['personality', ['personality', '性格', '人格']],
  ['scenario', ['scenario', '场景', '情景']],
  ['first_mes', ['first message', 'first_mes', 'greeting', '开场白', '首条消息']],
  ['mes_example', ['example dialogue', 'mes_example', 'dialogue examples', '对话示例']],
  ['creator_notes', ['creator notes', 'creator_notes', '作者注', '作者的话']],
  ['system_prompt', ['system prompt', 'system_prompt', '系统提示词']],
  ['post_history_instructions', ['post history instructions', 'post_history_instructions', '历史后指令']],
  ['lorebook', ['lorebook', 'world book', 'worldbook', '世界书']]
]);

function parseCardMarkdown(text, options = {}) {
  const { frontmatter, body } = parseFrontmatter(String(text || ''));
  const sections = parseSections(body);
  const card = options.baseCard ? normalizeCard(clone(options.baseCard)) : createEmptyCard();
  const data = card.data;
  const find = key => findSection(sections, key);
  const assignSection = (field, frontKey = null) => {
    const fromFront = frontKey && Object.prototype.hasOwnProperty.call(frontmatter, frontKey)
      ? String(frontmatter[frontKey] ?? '')
      : null;
    const section = find(field);
    if (fromFront !== null) data[field] = fromFront;
    else if (section) data[field] = section.content;
  };

  if (frontmatter.name != null) data.name = String(frontmatter.name);
  assignSection('description');
  assignSection('personality');
  assignSection('scenario', 'scenario');
  assignSection('first_mes');
  assignSection('mes_example');
  assignSection('creator_notes');
  assignSection('system_prompt', 'system_prompt');
  assignSection('post_history_instructions', 'post_history_instructions');

  if (frontmatter.tags != null) data.tags = parseList(frontmatter.tags);
  if (frontmatter.creator != null) data.creator = String(frontmatter.creator);
  if (!data.creator && !options.baseCard) data.creator = 'Nora';
  if (frontmatter.character_version != null) data.character_version = String(frontmatter.character_version);
  if (frontmatter.nickname != null) data.nickname = String(frontmatter.nickname);

  const altSections = sections.filter(section => isAlternateGreeting(section.title));
  if (altSections.length) data.alternate_greetings = altSections.map(section => section.content);

  const loreSection = find('lorebook');
  if (loreSection) {
    data.character_book = {
      ...(data.character_book || {}),
      name: String(frontmatter.lorebook_name || data.character_book?.name || `${data.name} lorebook`),
      entries: parseLorebook(loreSection.content),
      extensions: clone(data.character_book?.extensions || {})
    };
  }

  return {
    card: normalizeCard(card),
    metadata: {
      imagePrompt: String(frontmatter.image_prompt || ''),
      frontmatter,
      customSections: sections.filter(section => !canonicalSectionKey(section.title) && !isAlternateGreeting(section.title))
    }
  };
}

function cardToMarkdown(card, metadata = {}) {
  const normalized = normalizeCard(clone(card));
  const data = normalized.data;
  const front = [
    '---',
    `name: ${yamlString(data.name)}`,
    `scenario: ${yamlString(data.scenario)}`,
    `system_prompt: ${yamlString(data.system_prompt)}`,
    `post_history_instructions: ${yamlString(data.post_history_instructions)}`,
    `tags: ${JSON.stringify(data.tags || [])}`,
    `creator: ${yamlString(data.creator || 'Nora')}`,
    `character_version: ${yamlString(data.character_version || '1.0')}`
  ];
  if (metadata.imagePrompt) front.push(`image_prompt: ${yamlString(metadata.imagePrompt)}`);
  if (data.nickname) front.push(`nickname: ${yamlString(data.nickname)}`);
  front.push('---', '');

  const blocks = [
    section('Description', data.description),
    section('Personality', data.personality),
    section('Scenario', data.scenario),
    section('First Message', data.first_mes)
  ];
  (data.alternate_greetings || []).forEach((value, index) => {
    blocks.push(section(`Alternate Greeting ${index + 1}`, value));
  });
  blocks.push(section('Example Dialogue', data.mes_example));
  blocks.push(section('Lorebook', serializeLorebook(data.character_book?.entries || [])));
  blocks.push(section('Creator Notes', data.creator_notes));
  return front.join('\n') + blocks.join('\n\n') + '\n';
}

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { frontmatter: {}, body: text };
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== '---') return { frontmatter: {}, body: text };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) throw new Error('card.md frontmatter is not closed');
  const frontmatter = {};
  let currentKey = null;
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line) && currentKey) {
      frontmatter[currentKey] = `${frontmatter[currentKey]}\n${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    currentKey = line.slice(0, colon).trim();
    frontmatter[currentKey] = parseScalar(line.slice(colon + 1).trim());
  }
  return { frontmatter, body: lines.slice(end + 1).join('\n') };
}

function parseSections(body) {
  const matches = [...String(body || '').matchAll(/^##\s+(.+?)\s*$/gm)];
  return matches.map((match, index) => ({
    title: match[1].trim(),
    content: body.slice(match.index + match[0].length, matches[index + 1]?.index ?? body.length).trim()
  }));
}

function parseLorebook(text) {
  const matches = [...String(text || '').matchAll(/^###\s+(.+?)\s*$/gm)];
  return matches.map((match, index) => {
    const header = match[1].trim();
    const content = text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length).trim();
    const parts = header.split('|').map(part => part.trim()).filter(Boolean);
    const entry = {
      id: index,
      keys: [],
      secondary_keys: [],
      comment: parts.shift() || `条目 ${index + 1}`,
      content,
      constant: false,
      selective: false,
      insertion_order: 100,
      enabled: true,
      position: 'before_char',
      use_regex: false,
      extensions: {}
    };
    for (const part of parts) applyLoreDirective(entry, part);
    if (!entry.keys.length && !entry.constant) entry.constant = true;
    entry.selective = entry.secondary_keys.length > 0;
    return entry;
  });
}

function applyLoreDirective(entry, directive) {
  const [rawKey, ...rest] = directive.split(':');
  const key = rawKey.trim().toLowerCase();
  const value = rest.join(':').trim();
  if (key === 'constant') entry.constant = true;
  else if (key === 'keys') entry.keys = splitValues(value);
  else if (key === 'secondary') entry.secondary_keys = splitValues(value);
  else if (key === 'order') entry.insertion_order = integer(value, 'order');
  else if (key === 'position') entry.position = value.includes('after') ? 'after_char' : 'before_char';
  else if (key === 'depth') {
    entry.extensions.depth = integer(value, 'depth');
    entry.extensions.position = 4;
  } else if (key === 'role') {
    entry.extensions.role = ({ system: 0, user: 1, assistant: 2 })[value.toLowerCase()] ?? 0;
  } else if (key === 'logic') {
    entry.extensions.selectiveLogic = ({ and_any: 0, not_all: 1, not_any: 2, and_all: 3 })[value] ?? 0;
  } else if (key === 'prob') {
    entry.extensions.useProbability = true;
    entry.extensions.probability = boundedInteger(value, 'prob', 0, 100);
  } else if (key === 'sticky' || key === 'cooldown') {
    entry.extensions[key] = integer(value, key);
  } else if (key === 'recursion') {
    if (value === 'exclude') entry.extensions.exclude_recursion = true;
    if (value === 'prevent') entry.extensions.prevent_recursion = true;
  } else if (key === 'group') entry.extensions.group = value;
  else if (key === 'weight') entry.extensions.group_weight = integer(value, 'weight');
  else if (key === 'regex') entry.use_regex = true;
}

function serializeLorebook(entries) {
  return entries.map(entry => {
    const directives = [];
    if (entry.keys?.length) directives.push(`keys: ${entry.keys.join(', ')}`);
    if (entry.constant) directives.push('constant');
    if (entry.insertion_order !== 100) directives.push(`order: ${entry.insertion_order}`);
    if (entry.position && entry.position !== 'before_char') directives.push(`position: ${entry.position}`);
    if (entry.secondary_keys?.length) directives.push(`secondary: ${entry.secondary_keys.join(', ')}`);
    const ext = entry.extensions || {};
    if (Number.isFinite(ext.depth)) directives.push(`depth: ${ext.depth}`);
    if (Number.isFinite(ext.role)) directives.push(`role: ${['system', 'user', 'assistant'][ext.role] || 'system'}`);
    if (Number.isFinite(ext.selectiveLogic)) directives.push(`logic: ${['and_any', 'not_all', 'not_any', 'and_all'][ext.selectiveLogic] || 'and_any'}`);
    if (ext.useProbability && Number.isFinite(ext.probability)) directives.push(`prob: ${ext.probability}`);
    if (Number.isFinite(ext.sticky)) directives.push(`sticky: ${ext.sticky}`);
    if (Number.isFinite(ext.cooldown)) directives.push(`cooldown: ${ext.cooldown}`);
    if (ext.exclude_recursion) directives.push('recursion: exclude');
    else if (ext.prevent_recursion) directives.push('recursion: prevent');
    if (ext.group) directives.push(`group: ${ext.group}`);
    if (Number.isFinite(ext.group_weight)) directives.push(`weight: ${ext.group_weight}`);
    if (entry.use_regex) directives.push('regex');
    const heading = [`### ${entry.comment || '未命名条目'}`, ...directives].join(' | ');
    return `${heading}\n${String(entry.content || '').trim()}`;
  }).join('\n\n');
}

function canonicalSectionKey(title) {
  const normalized = normalizeTitle(title);
  for (const [key, aliases] of SECTION_ALIASES.entries()) {
    if (aliases.some(alias => normalizeTitle(alias) === normalized)) return key;
  }
  return '';
}

function findSection(sections, key) {
  return sections.find(section => canonicalSectionKey(section.title) === key);
}

function isAlternateGreeting(title) {
  return /^(alternate|alt)\s+greeting(?:\s+\d+)?$/i.test(title.trim()) || /^备[选用]开场白(?:\s*\d+)?$/.test(title.trim());
}

function parseScalar(value) {
  if (!value) return '';
  if (value.startsWith('[') && value.endsWith(']')) {
    try { return JSON.parse(value.replace(/'/g, '"')); } catch (_) { return parseList(value); }
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    if (value.startsWith('"')) {
      try { return JSON.parse(value); } catch (_) { /* fall through */ }
    }
    return value.slice(1, -1);
  }
  return value;
}

function parseList(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  return splitValues(String(value || '').replace(/^\[|\]$/g, ''));
}

function splitValues(value) {
  return String(value || '').split(/[,，、|/]/).map(item => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

function integer(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid lorebook ${label}: ${value}`);
  return parsed;
}

function boundedInteger(value, label, min, max) {
  const parsed = integer(value, label);
  if (parsed < min || parsed > max) throw new Error(`Lorebook ${label} must be ${min}-${max}`);
  return parsed;
}

function normalizeTitle(value) {
  return String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function section(title, content) {
  return `## ${title}\n${String(content || '').trim()}`;
}

module.exports = {
  parseCardMarkdown,
  cardToMarkdown,
  parseFrontmatter,
  parseSections,
  parseLorebook,
  serializeLorebook
};
