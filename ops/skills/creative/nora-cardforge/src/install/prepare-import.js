const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readCard } = require('../core/card-io');
const { summarizeCard } = require('../core/card-model');

const MAX_BYTES = 64 * 1024 * 1024;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function projectFile(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) fail('IMPORT_PATH_INVALID', 'Expected a project-relative artifact path');
  const file = path.resolve(root, relative);
  const rel = path.relative(root, file);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`)) fail('IMPORT_PATH_INVALID', 'Artifact escapes project root');
  // Reject symlink components, including in-root aliases, before reading bytes.
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) fail('IMPORT_PATH_INVALID', 'Project artifacts must not use symlinks');
  }
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) fail('IMPORT_FILE_INVALID', 'Expected a regular artifact of at most 64 MiB');
  return file;
}

function prepareImport(projectDir, { uploadRoot, idempotencyKey, dryRun = false } = {}) {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey !== idempotencyKey.trim() || idempotencyKey.length > 200) {
    fail('IMPORT_KEY_REQUIRED', 'Provide one stable idempotency key (1–200 characters) per intended new World; reuse it on retries');
  }
  if (typeof uploadRoot !== 'string' || !path.isAbsolute(uploadRoot)) fail('IMPORT_ROOT_REQUIRED', 'Provide the actual absolute upload directory from the installed nora MCP configuration');
  const root = fs.realpathSync(projectDir);
  const uploads = fs.realpathSync(uploadRoot);
  if (!fs.statSync(uploads).isDirectory() || uploads === path.parse(uploads).root) fail('IMPORT_ROOT_INVALID', 'Expected a dedicated existing upload directory');
  const manifest = JSON.parse(fs.readFileSync(projectFile(root, 'reports/build-manifest.json'), 'utf8'));
  if (manifest.format !== 'nora-card-build/v1' || manifest.quality?.passed !== true) fail('IMPORT_BUILD_INVALID', 'Build the project successfully before preparing import');
  const kind = manifest.artifacts?.v3Png ? 'v3Png' : 'v2Json';
  const artifact = projectFile(root, manifest.artifacts?.[kind]);
  const extension = kind === 'v3Png' ? '.png' : '.json';
  if (path.extname(artifact).toLowerCase() !== extension) fail('IMPORT_FILE_INVALID', 'Artifact extension does not match its manifest type');
  const bytes = fs.readFileSync(artifact);
  const hash = sha256(bytes);
  if (hash !== manifest.sha256?.[kind]) fail('IMPORT_ARTIFACT_CHANGED', 'Artifact no longer matches its build hash; rebuild before importing');
  const loaded = readCard(artifact);
  if (loaded.card.data.name !== manifest.card?.name) fail('IMPORT_CARD_MISMATCH', 'Artifact name does not match its build manifest');
  if (kind === 'v3Png' && (loaded.source.chunkKeyword !== 'ccv3' || !['chara', 'ccv3'].every(key => loaded.source.availableKeywords.includes(key)))) {
    fail('IMPORT_FILE_INVALID', 'Expected a dual-metadata V2/V3 PNG');
  }
  // No card rewrite here: imported scripts and unknown fields keep identical bytes.
  const destination = path.join(uploads, `cardforge-${hash}${extension}`);
  let reused = false;
  const verifyExisting = () => {
    const stat = fs.lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes.length || sha256(fs.readFileSync(destination)) !== hash) {
      fail('IMPORT_STAGING_CONFLICT', 'Existing staged file is not the expected artifact; it was not overwritten');
    }
    return true;
  };
  try { reused = verifyExisting(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!dryRun && !reused) {
    const temporary = path.join(uploads, `.cardforge-${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
      try { fs.linkSync(temporary, destination); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        reused = verifyExisting();
      }
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  return {
    ok: true, stage: dryRun ? 'preview' : 'prepared', dryRun, reused,
    artifact, artifactSha256: hash, bytes: bytes.length, card: summarizeCard(loaded.card),
    stagedPath: destination, worldChanged: false, runtimeVerified: false,
    effect: 'The MCP call creates a NEW World; it is not library-only storage or an existing-World replacement.',
    mcpCall: {
      tool: 'nora.world.import',
      arguments: { filePath: destination, idempotencyKey },
      requiresConfirmation: true,
      ready: !dryRun,
    },
    recovery: { tool: 'nora.operation.get', operationId: `operation:${sha256(idempotencyKey).slice(0, 32)}` },
  };
}

module.exports = { prepareImport };
