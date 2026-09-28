const fs = require('node:fs');
const path = require('node:path');
const { normalizeVarSpec, buildFieldContract } = require('../mvu/var-paths');
const { validateStatusbarHtml } = require('./statusbar');

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

// Only markup and literal bindings are authored here. The existing compiler
// supplies the one MVU reader; defaults and custom scripts are never copied.
function createBasicStatusbar(spec, { title = '当前状态' } = {}) {
  if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('Template title must contain 1–200 characters');
  const groups = normalizeVarSpec(spec);
  const contract = buildFieldContract(groups);
  const paths = [];
  const body = groups.map(group => {
    const rows = group.fields.map(field => {
      const fieldPath = [group.name, ...field.name.split('.')];
      paths.push(fieldPath);
      return `        <div class="field"><dt>${escapeHtml(field.name)}</dt><dd data-mvu-path='${escapeHtml(JSON.stringify(fieldPath))}'>尚未初始化</dd></div>`;
    }).join('\n');
    return `    <section>\n      <h2>${escapeHtml(group.name)}</h2>\n      <dl>\n${rows}\n      </dl>\n    </section>`;
  }).join('\n');
  const source = fs.readFileSync(path.resolve(__dirname, '../../resources/statusbar/basic.html'), 'utf8');
  const html = source.replace(/__NORA_(TITLE|GROUPS)__/g, (_, key) => key === 'TITLE' ? escapeHtml(title) : body);
  const report = validateStatusbarHtml({ data: { extensions: { cfMvuFieldContract: contract } } }, html);
  if (!report.passed) throw Object.assign(new Error('Basic status template failed validation'), { report });
  return { html, paths, report };
}

module.exports = { createBasicStatusbar };
