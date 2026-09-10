const { getMvuVariablePaths } = require('../mvu/var-paths');

function validateStatusbarHtml(card, html) {
  const issues = [];
  const text = String(html || '');
  if (!text.trim()) issues.push(issue('error', 'HTML 为空'));
  if (Buffer.byteLength(text, 'utf8') > 256 * 1024) issues.push(issue('error', 'HTML 超过 256 KB 安全上限'));
  if (!/<\/body>|<\/html>/i.test(text)) issues.push(issue('warning', 'HTML 缺少完整 body/html 结尾'));
  if (/\bfetch\s*\(|XMLHttpRequest|WebSocket\s*\(|EventSource\s*\(|sendBeacon\s*\(|localStorage|sessionStorage|indexedDB|document\.cookie|\beval\s*\(|\bFunction\s*\(|window\.open\s*\(|location\s*=|<script[^>]+src=|<iframe\b|<form[^>]+action=|<meta[^>]+http-equiv=["']?refresh|(?:src|href)\s*=\s*["']?\s*(?:https?:|\/\/)|url\(\s*["']?\s*(?:https?:|\/\/)/i.test(text)) {
    issues.push(issue('error', 'HTML 含不允许的外部访问或持久化能力'));
  }

  const targets = [...text.matchAll(/data-target=["']([^"']+)["']/g)].map(m => m[1]);
  for (const target of targets) {
    const hasId = new RegExp(`id=["']${escapeRegExp(target)}["']`).test(text);
    if (!hasId) issues.push(issue('error', `tab target 没有对应 id：${target}`));
  }

  const variablePaths = getMvuVariablePaths(card);
  const usedPaths = extractStatusbarPaths(text);
  for (const path of usedPaths) {
    if (!variablePaths.has(path)) issues.push(issue('error', `引用不存在的变量路径：${path}`));
  }

  return {
    passed: !issues.some(i => i.severity === 'error'),
    stats: { usedPaths: [...usedPaths], declaredPaths: [...variablePaths], tabTargets: targets },
    issues
  };
}

function createStatusbarPatch(html, options = {}) {
  const mode = options.mode || 'mvu';
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
