const fs = require('fs');
const crypto = require('crypto');
const { normalizeCard, normalizeWorldEntry, normalizeRegexScript, normalizeTavernScript, clone } = require('./card-model');

function loadPatch(filePath) {
  const patch = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const normalized = patch && patch.patch && Array.isArray(patch.patch.operations) ? patch.patch : patch;
  if (!normalized || !Array.isArray(normalized.operations)) throw new Error('Patch must contain operations[]');
  return normalized;
}

function applyPatchSet(card, patchSet) {
  const next = normalizeCard(clone(card));
  const applied = [];
  const warnings = [];
  for (const op of patchSet.operations || []) {
    try {
      applyOperation(next, op);
      applied.push(op.type);
    } catch (error) {
      warnings.push({ operation: op, error: error.message });
      if (op.required !== false) throw error;
    }
  }
  return { card: next, applied, warnings };
}

function applyOperation(card, op) {
  const d = card.data;
  switch (op.type) {
    case 'setField':
      requireString(op.field, 'field');
      d[op.field] = op.value == null ? '' : String(op.value);
      return;
    case 'upsertWorldEntry':
      upsertWorldEntry(card, op.comment, op.entry || {});
      return;
    case 'removeWorldEntryByCommentIncludes':
      removeWorldEntryByCommentIncludes(card, op.text);
      return;
    case 'upsertRegexScript':
      upsertRegexScript(card, op.scriptName, op.script || {});
      return;
    case 'removeRegexByNameIncludes':
      removeRegexByNameIncludes(card, op.text);
      return;
    case 'upsertTavernScript':
      upsertTavernScript(card, op.name, op.script || {});
      return;
    case 'removeTavernScriptByNameIncludes':
      removeTavernScriptByNameIncludes(card, op.text);
      return;
    case 'appendPlaceholder':
      appendPlaceholder(card, op.placeholder || '<StatusPlaceHolderImpl/>');
      return;
    case 'setExtension':
      requireString(op.key, 'key');
      d.extensions[op.key] = clone(op.value);
      return;
    default:
      throw new Error(`Unknown patch operation: ${op.type}`);
  }
}

function upsertWorldEntry(card, comment, entryPatch) {
  requireString(comment, 'comment');
  const entries = card.data.character_book.entries;
  let entry = entries.find(e => e.comment === comment);
  if (!entry) {
    entry = { id: nextEntryId(entries), comment };
    entries.push(entry);
  }
  Object.assign(entry, clone(entryPatch), { comment });
  normalizeWorldEntry(entry, entries.indexOf(entry));
}

function removeWorldEntryByCommentIncludes(card, text) {
  requireString(text, 'text');
  const entries = card.data.character_book.entries;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (String(entries[i].comment || '').includes(text)) entries.splice(i, 1);
  }
}

function upsertRegexScript(card, scriptName, scriptPatch) {
  requireString(scriptName, 'scriptName');
  const scripts = card.data.extensions.regex_scripts;
  let script = scripts.find(s => s.scriptName === scriptName);
  if (!script) {
    script = { id: crypto.randomUUID(), scriptName };
    scripts.push(script);
  }
  Object.assign(script, clone(scriptPatch), { scriptName });
  normalizeRegexScript(script);
}

function removeRegexByNameIncludes(card, text) {
  requireString(text, 'text');
  const scripts = card.data.extensions.regex_scripts;
  for (let i = scripts.length - 1; i >= 0; i--) {
    if (String(scripts[i].scriptName || '').includes(text)) scripts.splice(i, 1);
  }
}

function upsertTavernScript(card, name, scriptPatch) {
  requireString(name, 'name');
  const scripts = card.data.extensions.tavern_helper.scripts;
  let script = scripts.find(s => s.name === name);
  if (!script) {
    script = { id: crypto.randomUUID(), name };
    scripts.push(script);
  }
  Object.assign(script, clone(scriptPatch), { name });
  normalizeTavernScript(script);
}

function removeTavernScriptByNameIncludes(card, text) {
  requireString(text, 'text');
  const scripts = card.data.extensions.tavern_helper.scripts;
  for (let i = scripts.length - 1; i >= 0; i--) {
    if (String(scripts[i].name || '').includes(text)) scripts.splice(i, 1);
  }
}

function appendPlaceholder(card, placeholder) {
  const d = card.data;
  if (!String(d.first_mes || '').includes(placeholder)) {
    d.first_mes = String(d.first_mes || '') + (d.first_mes ? '\n' : '') + placeholder;
  }
  for (let i = 0; i < d.alternate_greetings.length; i++) {
    if (!String(d.alternate_greetings[i] || '').includes(placeholder)) {
      d.alternate_greetings[i] = String(d.alternate_greetings[i] || '') + '\n' + placeholder;
    }
  }
}

function nextEntryId(entries) {
  return entries.length ? Math.max(...entries.map(e => Number.isInteger(e.id) ? e.id : 0)) + 1 : 0;
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`Operation requires ${name}`);
}

module.exports = { loadPatch, applyPatchSet };
