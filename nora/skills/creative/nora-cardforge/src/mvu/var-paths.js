const FORMAT = 'nora-mvu-fields/v1';
const KEY = /^[\p{L}\p{N}$-][\p{L}\p{N}_$-]*$/u;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const TYPES = ['string', 'number', 'boolean', 'enum', 'object', 'array', 'record'];
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(location, message) {
  throw Object.assign(new Error(`${location}: ${message}`), { code: 'MVU_FIELD_CONTRACT_INVALID' });
}
function checkKey(key, location) {
  if (typeof key !== 'string' || key.length > 128 || !KEY.test(key) || RESERVED.has(key)) fail(location, 'invalid, reserved or read-only key');
}
function checkKeys(value, allowed, location) {
  if (!object(value)) fail(location, 'expected an object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(location, `unknown property ${key}`);
}

function normalizeType(input, location, depth = 0, top = false) {
  if (depth > 16) fail(location, 'schema exceeds 16 levels');
  const options = { string: [], boolean: [], number: ['min', 'max', 'integer', 'clamp'], enum: ['enumValues'], object: ['properties'], array: ['items'], record: ['values'] };
  if (!TYPES.includes(input?.type)) fail(location, 'unsupported or missing type');
  checkKeys(input, ['type', 'description', ...(top ? ['group', 'field', 'default'] : []), ...options[input.type]], location);
  if (own(input, 'description') && typeof input.description !== 'string') fail(location, 'description must be text');
  const node = { type: input.type };
  if (input.description) node.description = input.description;
  if (node.type === 'number') {
    for (const name of ['min', 'max']) if (own(input, name)) {
      if (!Number.isFinite(input[name])) fail(location, `${name} must be finite`);
      node[name] = input[name];
    }
    if (node.min > node.max) fail(location, 'min exceeds max');
    for (const name of ['integer', 'clamp']) if (own(input, name)) {
      if (typeof input[name] !== 'boolean') fail(location, `${name} must be boolean`);
      node[name] = input[name];
    }
    if (node.clamp && node.min === undefined && node.max === undefined) fail(location, 'clamp needs min or max');
    if (node.integer && [node.min, node.max].some(v => v !== undefined && !Number.isSafeInteger(v))) fail(location, 'integer bounds must be safe integers');
  }
  if (node.type === 'enum') {
    if (!Array.isArray(input.enumValues) || !input.enumValues.length || input.enumValues.some(v => typeof v !== 'string' || !v.length) || new Set(input.enumValues).size !== input.enumValues.length) fail(location, 'enumValues must be a nonempty unique string array');
    node.enumValues = [...input.enumValues];
  }
  if (node.type === 'object') {
    if (!object(input.properties) || !Object.keys(input.properties).length) fail(location, 'object requires explicit properties');
    node.properties = {};
    for (const [key, value] of Object.entries(input.properties)) {
      checkKey(key, location);
      node.properties[key] = normalizeType(value, `${location}.${key}`, depth + 1);
    }
  }
  if (node.type === 'array') node.items = normalizeType(input.items, location + '[]', depth + 1);
  if (node.type === 'record') node.values = normalizeType(input.values, location + '{key}', depth + 1);
  return node;
}

// Authoring validation only; runtime writes still belong to MVU/Zod.
function validateValue(node, value, location) {
  const bad = message => fail(location, message);
  if (node.type === 'string' && typeof value !== 'string') bad('expected string');
  if (node.type === 'boolean' && typeof value !== 'boolean') bad('expected boolean');
  if (node.type === 'enum' && !node.enumValues.includes(value)) bad('default is not an enum member');
  if (node.type === 'number') {
    if (!Number.isFinite(value) || typeof value !== 'number') bad('expected finite number; coercion is not allowed');
    if (node.integer && !Number.isSafeInteger(value)) bad('expected safe integer');
    if (value < node.min || value > node.max) bad('value outside declared range');
  }
  if (node.type === 'array') {
    if (!Array.isArray(value)) bad('expected array');
    value.forEach((item, i) => validateValue(node.items, item, `${location}[${i}]`));
  }
  if (node.type === 'object' || node.type === 'record') {
    if (!object(value)) bad('expected object');
    for (const key of Object.keys(value)) {
      checkKey(key, location);
      if (node.type === 'object' && !own(node.properties, key)) bad(`unknown property ${key}`);
      validateValue(node.type === 'object' ? node.properties[key] : node.values, value[key], `${location}.${key}`);
    }
    if (node.type === 'object') for (const key of Object.keys(node.properties)) if (!own(value, key)) bad(`missing property ${key}`);
  }
}

function normalizeVarSpec(input) {
  checkKeys(input, ['format', 'variables'], 'MVU fields');
  if (input.format !== FORMAT) fail('MVU fields', `expected format ${FORMAT}`);
  if (!Array.isArray(input.variables) || !input.variables.length || input.variables.length > 512) fail('MVU fields', 'expected 1–512 variables');
  const groups = new Map();
  const seen = [];
  for (const [index, field] of input.variables.entries()) {
    const location = `variables[${index}]`;
    checkKey(field?.group, location + '.group');
    if (typeof field.field !== 'string') fail(location, 'field is required');
    const parts = field.field.split('.');
    if (parts.length > 16) fail(location, 'field path exceeds 16 levels');
    parts.forEach(key => checkKey(key, location + '.field'));
    const path = [field.group, ...parts];
    if (seen.some(previous => previous.slice(0, Math.min(previous.length, path.length)).every((key, i) => key === path[i]))) fail(location, `path conflict at ${path.join('.')}`);
    seen.push(path);
    const schema = normalizeType(field, location, parts.length, true);
    if (!own(field, 'default')) fail(location, 'explicit default is required');
    if (!field.description?.trim()) fail(location, 'description must state meaning and update conditions');
    validateValue(schema, field.default, location + '.default');
    if (!groups.has(field.group)) groups.set(field.group, []);
    groups.get(field.group).push({ name: field.field, type: field.type, defaultValue: structuredClone(field.default), description: field.description, schema });
  }
  return [...groups].map(([name, fields]) => ({ name, fields }));
}

function buildFieldContract(groups) {
  const schema = { type: 'object', properties: {} };
  const initial = {};
  for (const group of groups) {
    schema.properties[group.name] = { type: 'object', properties: {} };
    initial[group.name] = {};
    for (const field of group.fields) {
      const parts = field.name.split('.');
      let node = schema.properties[group.name], data = initial[group.name];
      for (const key of parts.slice(0, -1)) {
        node.properties[key] ??= { type: 'object', properties: {} };
        data[key] ??= {};
        node = node.properties[key]; data = data[key];
      }
      node.properties[parts.at(-1)] = field.schema;
      data[parts.at(-1)] = structuredClone(field.defaultValue);
    }
  }
  validateValue(schema, initial, 'initial');
  return { format: FORMAT, schema, initial };
}

function toZod(node) {
  let code;
  switch (node.type) {
    case 'string': code = 'z.string()'; break;
    case 'boolean': code = 'z.boolean()'; break;
    case 'enum': code = `z.enum(${JSON.stringify(node.enumValues)})`; break;
    case 'number':
      code = 'z.number()';
      if (node.integer) code += '.int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)';
      if (node.clamp) code += `.transform(v => Math.min(${node.max ?? 'Infinity'}, Math.max(${node.min ?? '-Infinity'}, v)))`;
      else {
        if (node.min !== undefined) code += `.min(${node.min})`;
        if (node.max !== undefined) code += `.max(${node.max})`;
      }
      break;
    case 'array': code = `z.array(${toZod(node.items)})`; break;
    case 'record': code = `z.record(z.string().max(128).regex(new RegExp(${JSON.stringify(KEY.source)}, 'u')).refine(k => !['__proto__','prototype','constructor'].includes(k)), ${toZod(node.values)})`; break;
    case 'object': code = `z.object({${Object.entries(node.properties).map(([key, child]) => `${JSON.stringify(key)}: ${toZod(child)}`).join(',')}}).strict()`; break;
    default: fail('schema', 'unsupported type');
  }
  return node.description ? code + `.describe(${JSON.stringify(node.description)})` : code;
}

function resolveFieldSchema(contract, parts) {
  if (!Array.isArray(parts) || !parts.length || parts.length > 32) return null;
  let node = contract?.schema;
  for (const key of parts) {
    if (node?.type === 'object') node = typeof key === 'string' && own(node.properties, key) ? node.properties[key] : null;
    else if (node?.type === 'array') node = Number.isSafeInteger(key) && key >= 0 ? node.items : null;
    else if (node?.type === 'record') node = typeof key === 'string' && key.length <= 128 && KEY.test(key) && !RESERVED.has(key) ? node.values : null;
    else return null;
  }
  return node || null;
}

function getMvuVariablePaths(card) {
  const groups = card.data?.extensions?.cfMvuVarGroups || [];
  return new Set(groups.flatMap(group => (group.fields || []).filter(field => field?.name).map(field => `${group.name}.${field.name}`)));
}

module.exports = { FORMAT, normalizeVarSpec, buildFieldContract, toZod, validateValue, resolveFieldSchema, getMvuVariablePaths };
