// Nora World cards: reader summary and world-owned cast, not ST character aliases.
const FORMAT = 'nora-world-card/2';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Invalid ${label} fields`);
}
function text(value, label, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error(`Invalid ${label}`);
  return value;
}
function activation(value = { mode: 'constant' }) {
  keys(value, ['mode', 'enabled', 'keys', 'secondaryKeys', 'selectiveLogic', 'scanDepth', 'sticky', 'cooldown', 'delay', 'caseSensitive', 'matchWholeWords'], 'character activation');
  if (!['constant', 'triggered'].includes(value.mode)) throw new Error('Activation mode must be constant or triggered');
  const result = { ...value };
  for (const field of ['keys', 'secondaryKeys']) {
    const list = value[field] ?? [];
    if (!Array.isArray(list) || list.some(item => typeof item !== 'string')) throw new Error(`Invalid activation ${field}`);
    result[field] = [...new Set(list.map(item => item.trim()).filter(Boolean))];
  }
  if (value.mode === 'triggered' && !result.keys.length) throw new Error('Triggered characters require keywords');
  for (const field of ['enabled', 'caseSensitive', 'matchWholeWords']) {
    if (field in value && typeof value[field] !== 'boolean') throw new Error(`Invalid activation ${field}`);
  }
  for (const field of ['selectiveLogic', 'scanDepth', 'sticky', 'cooldown', 'delay']) {
    if (field in value && (!Number.isInteger(value[field]) || value[field] < 0)) throw new Error(`Invalid activation ${field}`);
  }
  if (value.selectiveLogic > 3 || value.scanDepth > 1000) throw new Error('Activation setting out of range');
  return result;
}

function compileWorld(card, world) {
  if (world === undefined) return card; // Old projects are not migrated.
  keys(world, ['persona', 'characters', 'language'], 'world');
  if (world.language !== undefined && !['zh', 'zh-Hant', 'en'].includes(world.language)) throw new Error('Invalid world language');
  keys(world.persona, ['name', 'description'], 'persona');
  const persona = {
    name: text(world.persona.name, 'persona name', 200),
    description: text(world.persona.description, 'persona description', 10000),
  };
  if (!Array.isArray(world.characters)) throw new Error('world.characters must be an array (empty is allowed)');
  const ids = new Set(['__user__']);
  const characters = world.characters.map(actor => {
    keys(actor, ['id', 'name', 'description', 'personality', 'activation'], 'character');
    if (typeof actor.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,191}$/.test(actor.id) || ids.has(actor.id)) throw new Error('Character ids must be unique stable IDs, not array indexes');
    ids.add(actor.id);
    return {
      id: actor.id,
      profile: {
        identity: { name: text(actor.name, 'character name', 200, true), description: text(actor.description, 'character description', 20000, true) },
        personality: { summary: text(actor.personality ?? '', 'character personality', 20000) },
      },
      persistent_status: {}, activation: activation(actor.activation),
    };
  });
  const result = JSON.parse(JSON.stringify(card));
  const data = result.data;
  for (const field of ['personality', 'scenario']) {
    if (String(data[field] ?? '').trim()) throw new Error(`New World cards do not author ${field}: put actor traits in world.characters and background/rules in Lorebook`);
  }
  if (data.extensions?.nora_world) throw new Error('Authored world cannot overwrite existing nora_world metadata');
  data.extensions ??= {};
  data.extensions.nora_world = { format: FORMAT, story_context: {
    schema_version: 1, card_format: FORMAT, characters, relationships: [],
    player: { profile: { identity: persona }, persistent_status: {} }, author_note: '', language: world.language ?? 'zh',
  } };
  return result;
}

module.exports = { compileWorld, FORMAT };
