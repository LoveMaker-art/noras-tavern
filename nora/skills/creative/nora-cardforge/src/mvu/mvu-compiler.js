const { normalizeVarSpec, buildFieldContract, toZod } = require('./var-paths');

// The card has an upstream baseline; Nora projects these imports onto its
// managed runtime without modifying the delivered PNG.
const MVU_IMPORT = "import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@7fe9ae7cfe01f13d606f7a2e533a458431fe318c/artifact/bundle.js';";
const ZOD_HELPER = 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource@b0ee9f4a371e0ec61dbd361443de5539d557a871/dist/util/mvu_zod.js';
const FALLBACK_COMMENT = '[mvu_update][nora_mvu_fallback/1]原MVU输出格式';

function createMvuPatch(card, varSpecInput, options = {}) {
  for (const key of Object.keys(options)) if (!['protocol', 'keepFloors'].includes(key)) throw new Error(`Unsupported MVU build option: ${key}`);
  const protocol = options.protocol || 'legacy';
  if (!['legacy', 'nora-mvu/1'].includes(protocol)) throw new Error(`Unsupported MVU protocol: ${protocol}`);
  const groups = normalizeVarSpec(varSpecInput);
  if (groups.length === 0) throw new Error('MVU variable spec is empty');
  const keepFloors = options.keepFloors ?? 3;
  if (!Number.isSafeInteger(keepFloors) || keepFloors < 0 || keepFloors > 1000) throw new Error('keepFloors must be an integer from 0 to 1000');
  const contract = buildFieldContract(groups);
  const operations = [
    { type: 'setExtension', key: 'cfMvuFieldContract', value: contract },
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
      script: { type: 'script', enabled: true, content: buildZodFromContract(contract) }
    },
    {
      type: 'upsertWorldEntry',
      comment: '[initvar]变量初始化勿开',
      entry: configuredEntry({
        content: JSON.stringify(contract.initial, null, 2),
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
      comment: protocol === 'legacy' ? '[mvu_update]变量更新规则' : '[mvu_update][nora_mvu/1]变量更新规则',
      entry: configuredEntry({ content: buildRulesFromGroups(groups) })
    },
    {
      type: 'upsertWorldEntry',
      comment: protocol === 'legacy' ? '[mvu_update]变量输出格式' : FALLBACK_COMMENT,
      entry: configuredEntry({ content: OUTPUT_FORMAT })
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
  if (protocol === 'nora-mvu/1') {
    // Model output is data, never executable HTML. Status UI is a separate
    // fixed template reading the committed snapshot.
    operations.filter(operation => operation.scriptName?.startsWith('[美化]')).forEach(operation => {
      operation.script.replaceString = '';
    });
  }
  return {
    format: 'nora-cardforge-patch/v1',
    intent: 'mvu_apply',
    stats: { protocol, groups: groups.length, variables: groups.reduce((sum, g) => sum + g.fields.length, 0) },
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

function buildZodFromContract(contract) {
  return `import { registerMvuSchema } from '${ZOD_HELPER}';\n\nexport const Schema = ${toZod(contract.schema)};\n\n$(() => {\n  registerMvuSchema(Schema);\n});\n`;
}

function buildRulesFromGroups(groups) {
  return groups.flatMap(group => group.fields.map(field =>
    JSON.stringify({ path: [group.name, ...field.name.split('.')], type: field.type, rule: field.description })
  )).join('\n');
}

function validateCompiledMvu(card) {
  const ext = card.data?.extensions;
  if (!ext?.cfMvuFieldContract) return { applicable: false, passed: true };
  try {
    const groups = normalizeVarSpec({ format: 'nora-mvu-fields/v1', variables: ext.cfMvuVarGroups.flatMap(group => group.fields.map(field => ({
      group: group.name, field: field.name, ...field.schema, default: field.defaultValue, description: field.description,
    }))) });
    const contract = buildFieldContract(groups);
    if (JSON.stringify(contract) !== JSON.stringify(ext.cfMvuFieldContract)) throw new Error('Field metadata and compiled contract differ');
    const entries = card.data.character_book.entries;
    const init = entries.filter(e => e.comment === '[initvar]变量初始化勿开');
    if (init.length !== 1 || JSON.stringify(JSON.parse(init[0].content)) !== JSON.stringify(contract.initial)) throw new Error('Initial state differs from field contract');
    const nora = entries.some(e => e.enabled && e.comment?.includes('[nora_mvu/1]'));
    const scripts = ext.tavern_helper.scripts.filter(s => s.name === 'Zod Schema' && s.enabled);
    if (scripts.length !== 1 || scripts[0].content !== buildZodFromContract(contract)) throw new Error('Generated Zod does not match field contract');
    const rules = entries.filter(e => e.enabled && e.comment === (nora ? '[mvu_update][nora_mvu/1]变量更新规则' : '[mvu_update]变量更新规则'));
    if (rules.length !== 1 || rules[0].content !== buildRulesFromGroups(groups)) throw new Error('Update rules do not match field contract');
    const formats = entries.filter(e => e.enabled && e.comment === (nora ? FALLBACK_COMMENT : '[mvu_update]变量输出格式'));
    if (formats.length !== 1 || !formats[0].constant || formats[0].content !== OUTPUT_FORMAT) throw new Error('Upstream fallback format is missing or changed');
    const loaders = ext.tavern_helper.scripts.filter(s => s.name === 'MVU 变量系统' && s.enabled);
    if (loaders.length !== 1 || loaders[0].content !== MVU_IMPORT) throw new Error('Upstream MVU loader is missing or changed');
    return { applicable: true, passed: true, fields: groups.reduce((sum, g) => sum + g.fields.length, 0) };
  } catch (error) { return { applicable: true, passed: false, error: error.message }; }
}

const OUTPUT_FORMAT = `变量更新：仅依据本轮已经发生的剧情和字段规则，不推测未发生的变化。
使用原 MVU 的 JSONPatch：replace 设置值，delta 增减数字，insert 新增对象成员或数组元素，remove 删除可选成员或数组元素。
路径为相对 stat_data 的 JSON Pointer，例如 /玩家/能量、/玩家/背包/0；数组末尾新增使用 /玩家/背包/-。
新增档案用 insert，路径指向已有档案集合下的新成员，value 提供该成员的完整对象；字段名称和成员结构以本卡实际定义为准。
值保持字段类型：数字不加引号，字符串用 JSON 字符串，对象提供完整必填字段。不要修改以下划线开头的字段。无需更新时用空数组 []。
普通聊天回复在剧情末尾附加一个 <UpdateVariable><JSONPatch>[操作列表]</JSONPatch></UpdateVariable>，不输出 HTML 状态栏。
若运行时明确指定工具调用或 JSON Schema，按其要求包装同一组 JSONPatch 操作，不再添加聊天标签。`;

module.exports = { createMvuPatch, validateCompiledMvu };
