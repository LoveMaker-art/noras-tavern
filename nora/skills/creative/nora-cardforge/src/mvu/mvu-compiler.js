const { normalizeVarSpec } = require('./var-paths');

const MVU_IMPORT = "import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js';";

function createMvuPatch(card, varSpecInput, options = {}) {
  const groups = normalizeVarSpec(varSpecInput);
  if (groups.length === 0) throw new Error('MVU variable spec is empty');
  const keepFloors = Number.isFinite(options.keepFloors) ? options.keepFloors : 3;
  const operations = [
    { type: 'setExtension', key: 'cfMvuVarGroups', value: groups },
    {
      type: 'upsertTavernScript',
      name: 'MVU 变量系统',
      script: {
        type: 'script',
        enabled: true,
        content: MVU_IMPORT,
        button: {
          enabled: true,
          buttons: [
            { name: '重新处理变量', visible: true },
            { name: '重新读取初始变量', visible: true },
            { name: '清除旧楼层变量', visible: false },
            { name: '快照楼层', visible: false },
            { name: '重演楼层', visible: false },
            { name: '重试额外模型解析', visible: false }
          ]
        }
      }
    },
    {
      type: 'upsertTavernScript',
      name: 'Zod Schema',
      script: { type: 'script', enabled: true, content: buildZodFromGroups(groups) }
    },
    {
      type: 'upsertWorldEntry',
      comment: '[initvar]变量初始化勿开',
      entry: configuredEntry({
        content: buildInitVarFromGroups(groups),
        constant: false,
        enabled: false
      })
    },
    {
      type: 'upsertWorldEntry',
      comment: '变量列表',
      entry: configuredEntry({
        content: '---\n<status_current_variables>\n{{format_message_variable::stat_data}}\n</status_current_variables>'
      })
    },
    {
      type: 'upsertWorldEntry',
      comment: '[mvu_update]变量更新规则',
      entry: configuredEntry({ content: buildRulesFromGroups(groups) })
    },
    {
      type: 'upsertWorldEntry',
      comment: '[mvu_update]变量输出格式',
      entry: configuredEntry({ content: OUTPUT_FORMAT })
    },
    {
      type: 'upsertWorldEntry',
      comment: '[mvu_update]变量输出格式强调',
      entry: configuredEntry({ content: OUTPUT_EMPHASIS })
    },
    {
      type: 'upsertRegexScript',
      scriptName: '[美化]变量更新中',
      script: {
        findRegex: '/<UpdateVariable>(?![\\s\\S]*<\\/UpdateVariable>)([\\s\\S]*)/gs',
        replaceString: '<details open style="background:rgba(0,0,0,0.15);border:1px solid rgba(100,200,255,0.15);border-radius:6px;padding:8px;margin:4px 0;font-size:12px"><summary style="cursor:pointer;color:#60a5fa">变量更新中...</summary><pre style="white-space:pre-wrap;color:#aaa;margin:4px 0">$1</pre></details>',
        markdownOnly: true,
        promptOnly: false
      }
    },
    {
      type: 'upsertRegexScript',
      scriptName: '[美化]完整变量完成',
      script: {
        findRegex: '/<UpdateVariable>([\\s\\S]*?)<\\/UpdateVariable>/gs',
        replaceString: '<details style="background:rgba(0,0,0,0.15);border:1px solid rgba(255,255,255,0.06);border-radius:6px;padding:8px;margin:4px 0;font-size:12px"><summary style="cursor:pointer;color:#888">变量更新</summary><pre style="white-space:pre-wrap;color:#aaa;margin:4px 0">$1</pre></details>',
        markdownOnly: true,
        promptOnly: false
      }
    },
    {
      type: 'upsertRegexScript',
      scriptName: `只发送最新${keepFloors}楼的变量更新`,
      script: {
        findRegex: '/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/gm',
        replaceString: '',
        markdownOnly: false,
        promptOnly: true,
        minDepth: keepFloors * 2
      }
    },
    {
      type: 'upsertRegexScript',
      scriptName: '[不发送]界面占位符',
      script: {
        findRegex: '/<StatusPlaceHolderImpl\\s*\\/>/g',
        replaceString: '',
        markdownOnly: false,
        promptOnly: true
      }
    },
    { type: 'appendPlaceholder', placeholder: '<StatusPlaceHolderImpl/>' }
  ];
  return {
    format: 'nora-cardforge-patch/v1',
    intent: 'mvu_apply',
    stats: { groups: groups.length, variables: groups.reduce((sum, g) => sum + g.fields.length, 0) },
    operations
  };
}

function configuredEntry(overrides) {
  return {
    keys: [],
    secondary_keys: [],
    content: '',
    constant: true,
    selective: false,
    insertion_order: 200,
    enabled: true,
    position: 'before_char',
    use_regex: false,
    extensions: {
      position: 4,
      depth: 0,
      prevent_recursion: true,
      exclude_recursion: true,
      probability: 100,
      useProbability: true
    },
    ...overrides
  };
}

function buildZodFromGroups(groups) {
  let code = "import { registerMvuSchema } from\n  'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';\n\nexport const Schema = z.object({\n";
  for (const group of groups) {
    if (!group.name) continue;
    code += `  ${safeKey(group.name)}: z.object({\n`;
    code += zodTreeToCode(buildFieldTree(group.fields), 2);
    code += '  }).prefault({}),\n';
  }
  code += '});\n\n$(() => {\n  registerMvuSchema(Schema);\n});\n';
  return code;
}

function zodTreeToCode(tree, indent) {
  let code = '';
  const pad = '  '.repeat(indent);
  for (const [key, value] of Object.entries(tree)) {
    if (value.__field) code += `${pad}${safeKey(key)}: ${buildZodType(value.__field)},\n`;
    else code += `${pad}${safeKey(key)}: z.object({\n${zodTreeToCode(value, indent + 1)}${pad}}).prefault({}),\n`;
  }
  return code;
}

function buildZodType(field) {
  if (field.type === 'number') {
    let code = 'z.coerce.number()';
    if (field.clamp && (field.min !== null || field.max !== null)) {
      code += `.transform(v => _.clamp(v, ${field.min ?? -999999}, ${field.max ?? 999999}))`;
    }
    return code + `.prefault(${Number(field.defaultValue) || 0})`;
  }
  if (field.type === 'boolean') return `z.boolean().prefault(${field.defaultValue === 'true' || field.defaultValue === true})`;
  if (field.type === 'array') return 'z.array(z.string()).prefault([])';
  if (field.type === 'record') return "z.record(z.string(), z.string().prefault('')).prefault({})";
  if (field.type === 'enum' && field.enumValues) {
    const values = field.enumValues.split(',').map(v => v.trim()).filter(Boolean);
    return `z.enum([${values.map(v => quote(v)).join(', ')}]).prefault(${quote(field.defaultValue || values[0] || '')})`;
  }
  return `z.string().prefault(${quote(field.defaultValue || '')})`;
}

function buildInitVarFromGroups(groups) {
  let yaml = '';
  for (const group of groups) {
    yaml += `${group.name}:\n`;
    yaml += treeToYaml(buildFieldTree(group.fields), 1);
  }
  return yaml;
}

function treeToYaml(tree, indent) {
  let yaml = '';
  const pad = '  '.repeat(indent);
  for (const [key, value] of Object.entries(tree)) {
    if (value.__field) yaml += `${pad}${key}: ${yamlValue(value.__field)}\n`;
    else yaml += `${pad}${key}:\n${treeToYaml(value, indent + 1)}`;
  }
  return yaml;
}

function buildRulesFromGroups(groups) {
  let text = '---\n变量更新规则:\n';
  for (const group of groups) {
    text += `  ${group.name}:\n`;
    text += ruleTreeToText(buildFieldTree(group.fields.filter(f => !f.name.startsWith('_'))), 2);
  }
  return text;
}

function ruleTreeToText(tree, indent) {
  let text = '';
  const pad = '  '.repeat(indent);
  for (const [key, value] of Object.entries(tree)) {
    if (value.__field) {
      const field = value.__field;
      text += `${pad}${key}:\n`;
      if (field.type !== 'string') text += `${pad}  type: ${field.type}\n`;
      if (field.type === 'number' && (field.min !== null || field.max !== null)) {
        text += `${pad}  range: ${field.min ?? 0}~${field.max ?? '...'}\n`;
      }
      text += `${pad}  check:\n`;
      const checks = String(field.description || defaultCheck(field)).split('\n').map(s => s.trim()).filter(Boolean);
      for (const check of checks) text += `${pad}    - ${check}\n`;
    } else {
      text += `${pad}${key}:\n${ruleTreeToText(value, indent + 1)}`;
    }
  }
  return text;
}

function buildFieldTree(fields) {
  const tree = {};
  for (const field of fields) {
    if (!field.name) continue;
    const parts = field.name.split('.');
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]] || node[parts[i]].__field) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = { __field: field };
  }
  return tree;
}

function yamlValue(field) {
  if (field.type === 'number') return String(Number(field.defaultValue) || 0);
  if (field.type === 'boolean') return field.defaultValue === 'true' || field.defaultValue === true ? 'true' : 'false';
  if (field.type === 'array') return '[]';
  if (field.type === 'record') return '{}';
  return quote(field.defaultValue || '');
}

function defaultCheck(field) {
  if (field.type === 'number') return 'update when relevant events cause this value to change, use reasonable delta';
  if (field.type === 'enum') return 'update only when conditions trigger a stage transition';
  if (field.type === 'record') return 'insert when new entries appear, remove when they leave or are consumed';
  if (field.type === 'boolean') return 'toggle when the condition changes';
  return 'update when this information changes in the narrative';
}

function quote(value) {
  return JSON.stringify(String(value));
}

function safeKey(key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key);
}

const OUTPUT_FORMAT = `---
变量输出格式:
  rule:
    - you must output the update analysis and the actual update commands at once in the end of the next reply
    - the update commands works like the JSON Patch standard, but supports replace, delta, insert, remove, move
    - don't update field names starts with \`_\` as they are readonly
  format: |-
    <UpdateVariable>
    <Analysis>$(IN CHINESE, no more than 400 words)</Analysis>
    <JSONPatch>
    [
      { "op": "replace", "path": "$\{/path/to/variable}", "value": "$\{new_value}" },
      { "op": "delta", "path": "$\{/path/to/number/variable}", "value": "$\{positive_or_negative_delta}" }
    ]
    </JSONPatch>
    </UpdateVariable>`;

const OUTPUT_EMPHASIS = `---
变量输出格式强调:
  rule: The following must be inserted to the end of reply, and cannot be omitted
  format: |-
    <UpdateVariable>
    ...
    </UpdateVariable>`;

module.exports = { createMvuPatch };
