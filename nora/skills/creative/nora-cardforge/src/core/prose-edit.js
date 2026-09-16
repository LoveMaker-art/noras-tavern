const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readPngCardData, extractChunks, encodeChunks, decodeCardTextChunk,
  decodeCardPayload, encodeTextChunk } = require('./card-io');

const TEXT_FIELDS = new Set(['description', 'personality', 'scenario', 'first_mes', 'mes_example']);
const GREETINGS = new Set(['alternate_greetings', 'group_only_greetings']);
// These delimiters are recognizable safeguards, not a parser for arbitrary card scripts.
const PROTECTED = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`]*`|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<%[\s\S]*?%>|\{\{[\s\S]*?\}\}|<[^>\n]+>|\[(?:\/?(?:nora_mvu[^\]]*|mvu[^\]]*|InitVar|UpdateVariable|JSONPatch))\]|\b(?:_\.(?:set|add|insert|remove|delete)|Mvu\.\w+)\s*\([^\n]*|https?:\/\/[^\s<>]+/gi;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function textTarget(card, targetPath) {
  if (!Array.isArray(targetPath) || !targetPath.length) throw new Error('path must be relative to card data');
  const allowed = targetPath.length === 1 && TEXT_FIELDS.has(targetPath[0])
    || targetPath.length === 2 && GREETINGS.has(targetPath[0]) && Number.isInteger(targetPath[1]) && targetPath[1] >= 0
    || targetPath.length === 4 && targetPath[0] === 'character_book' && targetPath[1] === 'entries'
      && Number.isInteger(targetPath[2]) && targetPath[2] >= 0 && targetPath[3] === 'content';
  if (!allowed) throw new Error(`Not a supported prose field: ${JSON.stringify(targetPath)}`);
  let parent = card.data && typeof card.data === 'object' ? card.data : card;
  for (const key of targetPath.slice(0, -1)) {
    if (!parent || !Object.hasOwn(parent, key)) throw new Error('Missing prose path');
    parent = parent[key];
  }
  const key = targetPath.at(-1);
  if (!parent || !Object.hasOwn(parent, key) || typeof parent[key] !== 'string') throw new Error('Prose target must be an existing string');
  return { parent, key };
}

function revisePayload(card, edits) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) throw new Error('Invalid card object');
  const next = structuredClone(card);
  // Resolve every span against the ORIGINAL payload, so edits cannot silently retarget each other.
  const groups = new Map();
  for (const edit of edits) {
    if (!edit || Object.keys(edit).some(key => !['path', 'before', 'after'].includes(key))) throw new Error('Invalid prose edit properties');
    if (typeof edit.before !== 'string' || !edit.before.length || typeof edit.after !== 'string' || !edit.after.trim()) throw new Error('before and after must be nonempty strings');
    if (edit.before === edit.after) throw new Error('Prose edit has no change');
    const { parent, key } = textTarget(card, edit.path);
    const value = parent[key];
    const start = value.indexOf(edit.before);
    if (start < 0 || value.indexOf(edit.before, start + 1) !== -1) throw new Error('before must match exactly once; include more surrounding prose');
    const end = start + edit.before.length;
    const spans = [...value.matchAll(PROTECTED)];
    if (spans.some(m => start < m.index + m[0].length && end > m.index)
      || [...edit.after.matchAll(PROTECTED)].length) throw new Error('Edit touches recognizable code, markup, macro or protocol; select plain prose only');
    const id = JSON.stringify(edit.path);
    const group = groups.get(id) || { path: edit.path, value, edits: [] };
    if (group.edits.some(e => start < e.end && end > e.start)) throw new Error('Overlapping prose edits');
    group.edits.push({ start, end, after: edit.after });
    groups.set(id, group);
  }
  for (const group of groups.values()) {
    let value = group.value;
    for (const edit of group.edits.sort((a, b) => b.start - a.start)) {
      value = value.slice(0, edit.start) + edit.after + value.slice(edit.end);
    }
    const { parent, key } = textTarget(next, group.path);
    parent[key] = value;
  }
  return next;
}

function editProse(inputPath, plan, outputPath, { dryRun = false } = {}) {
  const input = path.resolve(inputPath);
  const output = path.resolve(outputPath);
  if (input === output || fs.existsSync(output)) throw new Error('Output must be a new file; preserve the source and previous candidates');
  const bytes = fs.readFileSync(input);
  if (plan?.format !== 'nora-card-prose/1' || plan.sourceSha256 !== hash(bytes)
    || !Array.isArray(plan.edits) || !plan.edits.length
    || Object.keys(plan).some(key => !['format', 'sourceSha256', 'edits'].includes(key))) {
    throw new Error('Invalid prose plan or source hash mismatch');
  }
  const ext = path.extname(input).toLowerCase();
  if (ext !== path.extname(output).toLowerCase()) throw new Error('Keep the original file format');
  let result;
  const payloads = [];
  if (ext === '.json') {
    result = Buffer.from(JSON.stringify(revisePayload(JSON.parse(bytes.toString('utf8')), plan.edits), null, 2) + '\n');
    payloads.push('json');
  } else if (ext === '.png') {
    readPngCardData(bytes); // Existing size/CRC/card-data validation, without normalization.
    const chunks = extractChunks(bytes).map(chunk => {
      const text = decodeCardTextChunk(chunk);
      if (!text || !['chara', 'ccv3'].includes(text.keyword)) return chunk;
      if (payloads.includes(text.keyword)) throw new Error('Duplicate card metadata: resolve ambiguity before editing');
      payloads.push(text.keyword);
      const raw = JSON.parse(decodeCardPayload(text.value));
      const revised = revisePayload(raw, plan.edits);
      return { type: 'tEXt', data: encodeTextChunk(text.keyword, Buffer.from(JSON.stringify(revised)).toString('base64')) };
    });
    // Preserve trailing bytes as well as all non-card chunk contents.
    const chunkEnd = 8 + extractChunks(bytes).reduce((sum, chunk) => sum + chunk.data.length + 12, 0);
    result = Buffer.concat([encodeChunks(chunks), bytes.subarray(chunkEnd)]);
  } else {
    throw new Error('Prose editing supports JSON and PNG cards');
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, result, { flag: 'wx' });
  }
  return { ok: true, stage: dryRun ? 'preview' : 'prose-candidate', sourceSha256: hash(bytes),
    output, outputSha256: hash(result), payloads, edits: plan.edits.length,
    paths: [...new Set(plan.edits.map(e => JSON.stringify(e.path)))],
    verification: { unchangedDataOutsideEdits: true, semantics: 'requires-review', runtime: 'not-tested' } };
}

module.exports = { editProse };
