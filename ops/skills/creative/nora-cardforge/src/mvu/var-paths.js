function getMvuVariablePaths(card) {
  const groups = card.data?.extensions?.cfMvuVarGroups || [];
  const paths = new Set();
  for (const group of groups) {
    if (!group || !group.name) continue;
    for (const field of group.fields || []) {
      if (!field || !field.name) continue;
      paths.add(`${group.name}.${field.name}`);
    }
  }
  return paths;
}

function normalizeVarSpec(input) {
  const raw = Array.isArray(input) ? { variables: input } : (input || {});
  const variables = Array.isArray(raw.variables) ? raw.variables : [];
  const groupMap = new Map();
  for (const v of variables) {
    const group = String(v.group || '其他').trim();
    const field = String(v.field || '').trim();
    if (!group || !field) continue;
    if (!groupMap.has(group)) groupMap.set(group, []);
    groupMap.get(group).push({
      name: field,
      type: v.type || 'string',
      defaultValue: String(v.defaultValue ?? v.default ?? ''),
      min: v.min ?? null,
      max: v.max ?? null,
      clamp: !!v.clamp,
      enumValues: v.enumValues || '',
      recordFields: v.recordFields || '',
      description: v.description || '',
      showAdvanced: false
    });
  }
  return [...groupMap.entries()].map(([name, fields]) => ({ name, fields }));
}

module.exports = { getMvuVariablePaths, normalizeVarSpec };
