const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readCard, writeCardArtifact, readPngCardData } = require('../core/card-io');
const { normalizeCard, summarizeCard } = require('../core/card-model');
const { parseCardMarkdown, cardToMarkdown } = require('../card-md/card-md');
const { createMvuPatch } = require('../mvu/mvu-compiler');
const { createStatusbarPatch } = require('../statusbar/statusbar');
const { applyPatchSet } = require('../core/patch-engine');
const { runQualityGate } = require('../quality/quality-gate');

const PROJECT_FORMAT = 'nora-card-project/v1';

function initProject(projectDir, options = {}) {
  const root = prepareEmptyProjectDir(projectDir);
  const name = String(options.name || '未命名角色').trim();
  const slug = slugify(options.slug || name);
  ensureProjectDirs(root);
  const card = normalizeCard({ name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '' });
  card.data.creator = options.creator || 'Nora';
  const config = createProjectConfig({ slug, sourceType: 'new' });
  writeJson(path.join(root, 'card.project.json'), config);
  fs.writeFileSync(path.join(root, 'card.md'), cardToMarkdown(card), 'utf8');
  return { ok: true, project: root, config, files: listProjectFiles(root) };
}

function ingestProject(inputPath, projectDir, options = {}) {
  const root = prepareEmptyProjectDir(projectDir);
  const loaded = readCard(inputPath);
  const card = normalizeCard(loaded.card);
  const slug = slugify(options.slug || card.data.name || path.basename(inputPath, path.extname(inputPath)));
  ensureProjectDirs(root);
  const sourceExt = path.extname(inputPath).toLowerCase();
  const sourceRelative = `source/original${sourceExt}`;
  fs.copyFileSync(path.resolve(inputPath), path.join(root, sourceRelative));
  writeJson(path.join(root, 'source/passthrough.json'), card);
  fs.writeFileSync(path.join(root, 'card.md'), cardToMarkdown(card), 'utf8');

  const extracted = extractAdvancedFeatures(card);
  if (extracted.mvu) writeJson(path.join(root, 'source/extracted-mvu.json'), extracted.mvu);
  if (extracted.statusbar) fs.writeFileSync(path.join(root, 'source/extracted-statusbar.html'), extracted.statusbar, 'utf8');

  const config = createProjectConfig({
    slug,
    sourceType: 'imported',
    original: sourceRelative,
    passthrough: 'source/passthrough.json'
  });
  writeJson(path.join(root, 'card.project.json'), config);
  return {
    ok: true,
    project: root,
    source: loaded.source,
    card: summarizeCard(card),
    extracted: { mvu: !!extracted.mvu, statusbar: !!extracted.statusbar },
    files: listProjectFiles(root)
  };
}

function buildProject(projectDir, options = {}) {
  const root = path.resolve(projectDir);
  const config = readProjectConfig(root);
  const cardMdPath = path.join(root, 'card.md');
  const baseCard = config.source?.passthrough
    ? JSON.parse(fs.readFileSync(resolveWithin(root, config.source.passthrough), 'utf8'))
    : null;
  let { card } = parseCardMarkdown(fs.readFileSync(cardMdPath, 'utf8'), { baseCard });

  const mvuPath = featurePath(root, config.features?.mvu, 'features/mvu.json');
  if (mvuPath && fs.existsSync(mvuPath)) {
    const patch = createMvuPatch(card, JSON.parse(fs.readFileSync(mvuPath, 'utf8')), config.mvu || {});
    card = applyPatchSet(card, patch).card;
  }
  const statusbarPath = featurePath(root, config.features?.statusbar, 'features/statusbar.html');
  let statusbarHtml = '';
  if (statusbarPath && fs.existsSync(statusbarPath)) {
    statusbarHtml = fs.readFileSync(statusbarPath, 'utf8');
    const patch = createStatusbarPatch(statusbarHtml, { mode: config.statusbar?.mode || 'mvu' });
    card = applyPatchSet(card, patch).card;
  }

  const profile = options.profile || config.build?.profile || 'release';
  const quality = runQualityGate({ card, cardMdPath, statusbarHtml, profile });
  ensureDir(path.join(root, 'reports'));
  writeJson(path.join(root, 'reports/quality.json'), quality);
  if (!quality.passed) {
    const error = new Error(`Build blocked by quality gate: ${quality.hardFailures.join(', ')}`);
    error.code = 'QUALITY_GATE_FAILED';
    error.report = quality;
    throw error;
  }

  const buildDir = path.join(root, 'build');
  ensureDir(buildDir);
  const slug = config.slug;
  const jsonPath = path.join(buildDir, `${slug}.v2.json`);
  const pngPath = path.join(buildDir, `${slug}.png`);
  writeCardArtifact({ card, outputPath: jsonPath });

  const coverPath = selectCover(root, config);
  let png = null;
  if (coverPath) {
    writeCardArtifact({ card, outputPath: pngPath, coverPath });
    const roundTrip = readCard(pngPath);
    const embedded = readPngCardData(fs.readFileSync(pngPath));
    if (!embedded.availableKeywords.includes('chara') || !embedded.availableKeywords.includes('ccv3')) {
      throw new Error('Built PNG is missing chara/ccv3 dual metadata');
    }
    if (roundTrip.card.data.name !== card.data.name) throw new Error('Built PNG round-trip changed the card name');
    png = relative(root, pngPath);
  }

  const artifacts = { v2Json: relative(root, jsonPath), v3Png: png };
  const manifest = {
    format: 'nora-card-build/v1',
    projectFormat: PROJECT_FORMAT,
    slug,
    card: summarizeCard(card),
    quality: { passed: quality.passed, profile, writingScore: quality.writing?.score ?? null },
    artifacts,
    sha256: Object.fromEntries(Object.entries(artifacts).filter(([, value]) => value)
      .map(([key, value]) => [key, sha256(fs.readFileSync(path.join(root, value)))]))
  };
  writeJson(path.join(root, 'reports/build-manifest.json'), manifest);
  return { ok: true, project: root, manifest, quality };
}

function inspectProject(projectDir) {
  const root = path.resolve(projectDir);
  const config = readProjectConfig(root);
  const baseCard = config.source?.passthrough
    ? JSON.parse(fs.readFileSync(resolveWithin(root, config.source.passthrough), 'utf8'))
    : null;
  const parsed = parseCardMarkdown(fs.readFileSync(path.join(root, 'card.md'), 'utf8'), { baseCard });
  return { ok: true, project: root, config, card: summarizeCard(parsed.card), files: listProjectFiles(root) };
}

function createProjectConfig({ slug, sourceType, original = null, passthrough = null }) {
  return {
    format: PROJECT_FORMAT,
    slug,
    source: { type: sourceType, original, passthrough },
    build: { profile: 'release', target: 'v2-json+v3-png', cover: 'assets/cover.png' },
    features: { mvu: null, statusbar: null },
    mvu: { keepFloors: 3, injectMode: 'single' },
    statusbar: { mode: 'mvu' }
  };
}

function readProjectConfig(root) {
  const configPath = path.join(root, 'card.project.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (config.format !== PROJECT_FORMAT) throw new Error(`Unsupported project format: ${config.format || 'missing'}`);
  if (!config.slug || slugify(config.slug) !== config.slug) throw new Error('Project slug must be lowercase ASCII letters, digits, and hyphens');
  return config;
}

function extractAdvancedFeatures(card) {
  const groups = card.data.extensions?.cfMvuVarGroups;
  const mvu = Array.isArray(groups) && groups.length
    ? { variables: groups.flatMap(group => (group.fields || []).map(field => ({
      group: group.name,
      field: field.name,
      type: field.type,
      default: field.defaultValue,
      min: field.min,
      max: field.max,
      clamp: field.clamp,
      enumValues: field.enumValues,
      description: field.description
    }))) }
    : null;
  const statusScript = card.data.extensions?.regex_scripts?.find(script => ['状态栏美化', '状态栏'].includes(script.scriptName));
  return { mvu, statusbar: statusScript ? extractHtmlFence(statusScript.replaceString) : '' };
}

function extractHtmlFence(value) {
  const text = String(value || '');
  const match = text.match(/```html\s*([\s\S]*?)\s*```/i);
  return match ? match[1].trim() : '';
}

function featurePath(root, configured, fallback) {
  if (configured === false) return null;
  if (typeof configured === 'string') return resolveWithin(root, configured);
  if (configured && typeof configured === 'object' && configured.enabled === false) return null;
  if (configured && typeof configured === 'object' && configured.path) return resolveWithin(root, configured.path);
  const candidate = resolveWithin(root, fallback);
  return fs.existsSync(candidate) ? candidate : null;
}

function selectCover(root, config) {
  const configured = config.build?.cover ? resolveWithin(root, config.build.cover) : null;
  if (configured && fs.existsSync(configured)) return configured;
  if (config.source?.original && path.extname(config.source.original).toLowerCase() === '.png') {
    const original = resolveWithin(root, config.source.original);
    if (fs.existsSync(original)) return original;
  }
  return null;
}

function prepareEmptyProjectDir(projectDir) {
  const root = path.resolve(projectDir);
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error(`Project directory is not empty: ${root}`);
  ensureDir(root);
  return root;
}

function ensureProjectDirs(root) {
  ['assets', 'build', 'features', 'reports', 'source'].forEach(dir => ensureDir(path.join(root, dir)));
}

function listProjectFiles(root) {
  const files = [];
  const walk = dir => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else files.push(relative(root, full));
    }
  };
  walk(root);
  return files.sort();
}

function resolveWithin(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`Project path escapes root: ${relativePath}`);
  return resolved;
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function relative(root, file) { return path.relative(root, file).split(path.sep).join('/'); }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function slugify(value) {
  const slug = String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || `card-${sha256(Buffer.from(String(value || 'card'))).slice(0, 8)}`;
}

module.exports = {
  PROJECT_FORMAT,
  initProject,
  ingestProject,
  buildProject,
  inspectProject,
  readProjectConfig,
  extractAdvancedFeatures,
  slugify
};
