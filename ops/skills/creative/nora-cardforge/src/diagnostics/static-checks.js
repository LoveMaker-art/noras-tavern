const { normalizeCard } = require('../core/card-model');
const { getMvuVariablePaths } = require('../mvu/var-paths');
const { extractStatusbarPaths } = require('../statusbar/statusbar');

function runDiagnostics(card, options = {}) {
  const normalized = normalizeCard(card);
  const checks = [
    checkBasicInfo(normalized),
    checkWorldbookStructure(normalized),
    checkKeywordConflicts(normalized),
    checkTokenUsage(normalized),
    checkRecursionSettings(normalized),
    checkRegexScripts(normalized),
    checkMvuStatusbarPaths(normalized)
  ];
  const issues = checks.flatMap(check => check.issues.map(issue => ({ ...issue, check: check.key })));
  return {
    profile: options.profile || 'nora',
    passed: !issues.some(issue => issue.severity === 'error'),
    summary: {
      checks: checks.length,
      errors: issues.filter(i => i.severity === 'error').length,
      warnings: issues.filter(i => i.severity === 'warning').length,
      info: issues.filter(i => i.severity === 'info').length
    },
    checks,
    issues
  };
}

function checkBasicInfo(card) {
  const d = card.data;
  const issues = [];
  const required = [
    ['name', '角色名', 1],
    ['description', '角色描述', 50],
    ['personality', '性格', 10],
    ['first_mes', '开场白', 30]
  ];
  for (const [key, label, min] of required) {
    const value = String(d[key] || '').trim();
    if (!value) issues.push(issue('error', `${label}为空`, key, `${key} is required`));
    else if (value.length < min) issues.push(issue('warning', `${label}偏短`, key, `${value.length}/${min}`));
  }
  return result('basic_info', '基础字段', issues);
}

function checkWorldbookStructure(card) {
  const issues = [];
  for (const entry of card.data.character_book.entries) {
    const label = `world entry #${entry.id} ${entry.comment || ''}`.trim();
    if (!String(entry.content || '').trim()) issues.push(issue('error', '世界书条目内容为空', label));
    if (!entry.constant && entry.enabled && (!entry.keys || entry.keys.filter(Boolean).length === 0)) {
      issues.push({
        ...issue('error', '绿灯条目没有关键词', label),
        suggestedFix: { type: 'upsertWorldEntry', comment: entry.comment, entry: { constant: true, selective: false } }
      });
    }
    if (entry.insertion_order !== 100 && !String(entry.comment || '').includes('[mvu_update]')) {
      issues.push(issue('warning', '普通世界书条目 order 不是 100', label, `order=${entry.insertion_order}`));
    }
    if (Array.isArray(entry.keys) && entry.keys.some(k => !String(k || '').trim())) {
      issues.push(issue('warning', '关键词包含空值', label));
    }
  }
  return result('worldbook_structure', '世界书结构', issues);
}

function checkKeywordConflicts(card) {
  const issues = [];
  const keyMap = new Map();
  for (const entry of card.data.character_book.entries) {
    if (!entry.enabled || entry.constant) continue;
    for (const key of entry.keys || []) {
      const trimmed = String(key || '').trim();
      if (!trimmed) continue;
      if (!keyMap.has(trimmed)) keyMap.set(trimmed, []);
      keyMap.get(trimmed).push(entry);
    }
  }
  for (const [key, entries] of keyMap.entries()) {
    if (entries.length > 1) issues.push(issue('warning', `关键词重复触发：${key}`, entries.map(e => e.comment).join(' / ')));
  }
  for (const key of ['的', '了', '是', '在', '有', '系统', '世界']) {
    if (keyMap.has(key)) issues.push(issue('error', `关键词过度通用：${key}`, key));
  }
  return result('keyword_conflicts', '关键词冲突', issues);
}

function checkTokenUsage(card) {
  const entries = card.data.character_book.entries.filter(e => e.enabled);
  const constantChars = entries.filter(e => e.constant).reduce((sum, e) => sum + String(e.content || '').length, 0);
  const triggeredChars = entries.filter(e => !e.constant).reduce((sum, e) => sum + String(e.content || '').length, 0);
  const issues = [];
  const constantTokens = Math.round(constantChars * 1.3);
  if (constantTokens > 8000) issues.push(issue('warning', `常驻世界书 token 偏高：~${constantTokens}`, 'worldbook'));
  return { ...result('token_usage', 'Token 估算', issues), stats: { constantTokens, triggeredTokens: Math.round(triggeredChars * 1.3) } };
}

function checkRecursionSettings(card) {
  const issues = [];
  for (const entry of card.data.character_book.entries) {
    if (!entry.enabled) continue;
    const ext = entry.extensions || {};
    if (entry.constant && !ext.exclude_recursion) {
      issues.push(issue('warning', '蓝灯条目未开启不可递归', entry.comment || `#${entry.id}`));
    }
    if (!entry.constant && (!ext.exclude_recursion || !ext.prevent_recursion)) {
      issues.push(issue('warning', '绿灯条目递归保护不完整', entry.comment || `#${entry.id}`));
    }
  }
  return result('recursion_settings', '递归设置', issues);
}

function checkRegexScripts(card) {
  const issues = [];
  card.data.extensions.regex_scripts.forEach((script, index) => {
    if (script.disabled) return;
    if (!String(script.findRegex || '').trim()) {
      issues.push(issue('error', '正则 findRegex 为空', script.scriptName || `regex #${index}`));
      return;
    }
    try {
      const parsed = parseRegexLiteral(script.findRegex);
      new RegExp(parsed.pattern, parsed.flags);
    } catch (error) {
      issues.push(issue('error', '正则语法错误', script.scriptName || `regex #${index}`, error.message));
    }
    if (!Array.isArray(script.placement) || script.placement.length === 0) {
      issues.push(issue('warning', '正则 placement 为空', script.scriptName || `regex #${index}`));
    }
  });
  return result('regex_scripts', '正则脚本', issues);
}

function checkMvuStatusbarPaths(card) {
  const issues = [];
  const variablePaths = getMvuVariablePaths(card);
  const statusScripts = card.data.extensions.regex_scripts.filter(s => ['状态栏美化', '状态栏'].includes(s.scriptName));
  for (const script of statusScripts) {
    const paths = extractStatusbarPaths(script.replaceString || '');
    for (const p of paths) {
      if (!variablePaths.has(p)) issues.push(issue('error', `状态栏引用不存在的变量：${p}`, script.scriptName));
    }
  }
  return result('mvu_statusbar_paths', 'MVU/状态栏路径', issues, { variables: variablePaths.size });
}

function parseRegexLiteral(input) {
  const s = String(input || '');
  if (!s.startsWith('/')) return { pattern: s, flags: '' };
  const last = s.lastIndexOf('/');
  if (last <= 0) throw new Error('Invalid regex literal');
  return { pattern: s.slice(1, last), flags: s.slice(last + 1) };
}

function result(key, name, issues, stats = {}) {
  return { key, name, passed: !issues.some(i => i.severity === 'error'), stats, issues };
}

function issue(severity, title, location, description = '') {
  return { severity, title, location: location || '', description, fixable: false };
}

module.exports = { runDiagnostics, parseRegexLiteral };
