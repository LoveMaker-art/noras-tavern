const { getMvuVariablePaths, resolveFieldSchema } = require('../mvu/var-paths');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

function validateStatusbarHtml(card, html) {
  const issues = [];
  const text = String(html || '');
  if (!text.trim()) issues.push(issue('error', 'HTML 为空'));
  if (Buffer.byteLength(text, 'utf8') > 256 * 1024) issues.push(issue('error', 'HTML 超过 256 KB 安全上限'));
  if (!/<\/body>|<\/html>/i.test(text)) issues.push(issue('warning', 'HTML 缺少完整 body/html 结尾'));
  if (/\bfetch\s*\(|XMLHttpRequest|WebSocket\s*\(|EventSource\s*\(|sendBeacon\s*\(|localStorage|sessionStorage|indexedDB|document\.cookie|\beval\s*\(|\bFunction\s*\(|window\.open\s*\(|location\s*=|<script[^>]+src=|<iframe\b|<form[^>]+action=|<meta[^>]+http-equiv=["']?refresh|(?:src|href)\s*=\s*["']?\s*(?:https?:|\/\/)|url\(\s*["']?\s*(?:https?:|\/\/)/i.test(text)) {
    issues.push(issue('error', 'HTML 含不允许的外部访问或持久化能力'));
  }
  const syntax = issues.some(i => i.severity === 'error')
    ? { checked: 0, status: 'skipped', issues: [] } : checkScriptSyntax(text);
  issues.push(...syntax.issues);
  const verification = {
    scope: 'literal-bindings', scriptsExecuted: false, runtime: 'not-verified',
    scriptSyntax: { checked: syntax.checked, status: syntax.status },
  };

  const targets = [...text.matchAll(/data-target=["']([^"']+)["']/g)].map(m => m[1]);
  for (const target of targets) {
    const hasId = new RegExp(`id=["']${escapeRegExp(target)}["']`).test(text);
    if (!hasId) issues.push(issue('error', `tab target 没有对应 id：${target}`));
  }

  const contract = card.data?.extensions?.cfMvuFieldContract;
  if (contract) {
    const bindings = readBindings(text);
    issues.push(...bindings.issues);
    for (const path of bindings.paths) if (!resolveFieldSchema(contract, path)) issues.push(issue('error', `未声明的显示路径：${JSON.stringify(path)}`));
    // Literal bindings can be checked. Custom code is preserved, not executed
    // or certified by this scanner; interaction acceptance is a separate step.
    issues.push(issue('warning', '仅检查字面字段绑定与内嵌脚本语法；自定义脚本读写、显示和交互仍需运行验收'));
    return {
      passed: !issues.some(i => i.severity === 'error'),
      stats: { usedPaths: bindings.paths, tabTargets: targets },
      verification,
      issues
    };
  }
  const variablePaths = getMvuVariablePaths(card);
  if (/\bdata-mvu-path\s*=/i.test(text)) issues.push(issue('error', 'data-mvu-path requires a compiled MVU field contract'));
  const usedPaths = extractStatusbarPaths(text);
  for (const path of usedPaths) {
    if (!variablePaths.has(path)) issues.push(issue('error', `引用不存在的变量路径：${path}`));
  }

  return {
    passed: !issues.some(i => i.severity === 'error'),
    stats: { usedPaths: [...usedPaths], declaredPaths: [...variablePaths], tabTargets: targets },
    verification: { ...verification, scope: 'legacy-paths' },
    issues
  };
}

function checkScriptSyntax(html) {
  const python = process.env.NORA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(python, [path.resolve(__dirname, '../../scripts/check_statusbar.py'), process.execPath], {
    input: html, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  try {
    if (result.error || result.status !== 0) throw new Error(result.error?.message || `checker exit ${result.status}`);
    const report = JSON.parse(result.stdout);
    if (!Array.isArray(report.issues) || !Number.isInteger(report.checked)) throw new Error('invalid checker report');
    return { ...report, status: report.issues.some(i => i.severity === 'error') ? 'failed' : 'passed' };
  } catch (error) {
    return { checked: 0, status: 'unavailable', issues: [issue('error', `脚本语法检查不可用：${error.message}`)] };
  }
}

function createStatusbarPatch(html, options = {}) {
  const mode = options.mode || 'mvu';
  if (options.contract) {
    if (mode !== 'mvu') throw new Error('Nora field-contract status UI requires mvu mode');
    const report = validateStatusbarHtml({ data: { extensions: { cfMvuFieldContract: options.contract } } }, html);
    if (!report.passed) throw Object.assign(new Error(report.issues.map(i => i.title).join('; ')), { code: 'STATUS_BINDING_INVALID', report });
    // Only bound text nodes use our reader; custom-only UI owns its lifecycle.
    if (report.stats.usedPaths.length) html = String(html) + '\n<script type="module">\n' + rendererSource() + '\n</script>';
  }
  const operations = [];
  if (mode === 'text') {
    operations.push({
      type: 'upsertRegexScript',
      scriptName: '状态栏',
      script: {
        findRegex: '/<StatusData>([\\s\\S]*?)<\\/StatusData>/gm',
        replaceString: '```html\n' + String(html || '') + '\n```',
        markdownOnly: true,
        promptOnly: false
      }
    });
    operations.push({
      type: 'upsertRegexScript',
      scriptName: '对AI隐藏状态数据',
      script: {
        findRegex: '/<StatusData>[\\s\\S]*?<\\/StatusData>/gm',
        replaceString: '',
        markdownOnly: false,
        promptOnly: true,
        minDepth: 6
      }
    });
  } else {
    operations.push({
      type: 'upsertRegexScript',
      scriptName: '状态栏美化',
      script: {
        findRegex: '/<StatusPlaceHolderImpl\\s*\\/>/g',
        replaceString: '```html\n' + String(html || '') + '\n```',
        markdownOnly: true,
        promptOnly: false
      }
    });
    operations.push({
      type: 'upsertRegexScript',
      scriptName: '[不发送]界面占位符',
      script: {
        findRegex: '/<StatusPlaceHolderImpl\\s*\\/>/g',
        replaceString: '',
        markdownOnly: false,
        promptOnly: true
      }
    });
    operations.push({ type: 'appendPlaceholder', placeholder: '<StatusPlaceHolderImpl/>' });
  }
  return { format: 'nora-cardforge-patch/v1', operations };
}

function readBindings(html) {
  const paths = [], issues = [];
  const text = String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const mentions = [...text.matchAll(/\bdata-mvu-path\s*=/gi)];
  const attributes = [...text.matchAll(/\bdata-mvu-path\s*=\s*("[^"]*"|'[^']*')/gi)];
  if (mentions.length !== attributes.length) issues.push(issue('error', 'data-mvu-path 必须为带引号的 JSON 数组'));
  for (const match of attributes) {
    try {
      const raw = match[1].slice(1, -1).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
      const path = JSON.parse(raw);
      if (!Array.isArray(path) || !path.length || path.some(k => !(typeof k === 'string' && k.length || Number.isSafeInteger(k) && k >= 0))) throw new Error('invalid path');
      paths.push(path);
    } catch { issues.push(issue('error', 'data-mvu-path 必须是非空的字面路径数组')); }
  }
  return { paths, issues };
}

function rendererSource() {
  return `async function init() {
  await waitGlobalInitialized('Mvu');
  const messageId = getCurrentMessageId();
  function render() {
    let state;
    try { state = Mvu.getMvuData({ type: 'message', message_id: messageId })?.stat_data; } catch { state = undefined; }
    for (const element of document.querySelectorAll('[data-mvu-path]')) {
      try {
        const path = JSON.parse(element.getAttribute('data-mvu-path'));
        const value = path.reduce((data, key) => data != null && Object.hasOwn(data, key) ? data[key] : undefined, state);
        element.textContent = value === undefined ? '尚未初始化' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      } catch { element.textContent = '字段绑定错误'; }
    }
  }
  eventOn(Mvu.events.VARIABLE_INITIALIZED, render);
  if (Mvu.events.TRANSACTION_COMMITTED) {
    eventOn(Mvu.events.TRANSACTION_COMMITTED, render);
  } else {
    // Upstream refreshes the message after writing its snapshot. Its MVU
    // UPDATE_ENDED event is earlier and must not be treated as a commit.
    eventOn(tavern_events.CHARACTER_MESSAGE_RENDERED, id => {
      if (Number(id) === messageId) render();
    });
  }
  render();
}
$(errorCatched(init));`;
}

function extractStatusbarPaths(html) {
  const set = new Set();
  const text = String(html || '');
  const re = /stat_data\.([\w\u4e00-\u9fa5][\w\u4e00-\u9fa5.]*)/g;
  let match;
  while ((match = re.exec(text)) !== null) set.add(match[1].replace(/[),;'"`\]}]+$/, ''));
  return set;
}

function issue(severity, title) {
  return { severity, title };
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { validateStatusbarHtml, createStatusbarPatch, extractStatusbarPaths };
