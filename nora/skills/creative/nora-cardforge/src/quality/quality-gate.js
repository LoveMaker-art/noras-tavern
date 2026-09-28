const path = require('path');
const { spawnSync } = require('child_process');
const { runDiagnostics } = require('../diagnostics/static-checks');
const { validateStatusbarHtml } = require('../statusbar/statusbar');
const { validateCompiledMvu } = require('../mvu/mvu-compiler');

function runQualityGate({ card, writingCard = card, cardMdPath, statusbarHtml = '', profile = 'release', scoreWriting = false }) {
  const structure = runDiagnostics(card, { profile });
  const mvu = validateCompiledMvu(card);
  const statusbar = statusbarHtml ? validateStatusbarHtml(card, statusbarHtml) : null;
  const strictWriting = profile === 'release-strict';
  const writing = cardMdPath && (scoreWriting || strictWriting)
    ? runWritingScore(cardMdPath, writingCard?.data?.extensions?.nora_world ? writingCard : undefined) : null;
  const hardFailures = [];
  if (!structure.passed) hardFailures.push('structure');
  if (!mvu.passed) hardFailures.push('mvu-contract');
  if (statusbar && !statusbar.passed) hardFailures.push('statusbar');
  if (strictWriting && (!writing?.available || writing.score < 75)) hardFailures.push('writing');
  return {
    profile,
    passed: hardFailures.length === 0,
    hardFailures,
    structure,
    mvu,
    statusbar,
    writing,
    policy: {
      writingThreshold: 75,
      writingBlocksBuild: strictWriting,
      structureBlocksBuild: true,
      statusbarBlocksBuild: true
    }
  };
}

function runWritingScore(cardMdPath, card) {
  const script = path.resolve(__dirname, '../../scripts/score_card.py');
  const python = process.env.NORA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(python, [script, path.resolve(cardMdPath), '--json', ...(card ? ['--compiled-stdin'] : [])], {
    input: card ? JSON.stringify(card) : undefined,
    encoding: 'utf8',
    env: { ...process.env, PYTHONUTF8: '1' },
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.error) {
    return { available: false, score: null, error: result.error.message };
  }
  try {
    if (![0, 1].includes(result.status)) throw new Error(`scorer exit ${result.status}`);
    const parsed = JSON.parse(result.stdout)[0];
    if (!parsed || !Number.isFinite(parsed.score)) throw new Error('missing numeric score');
    return {
      available: true,
      score: parsed.score,
      categories: parsed?.categories || {},
      issues: parsed?.issues || [],
      detail: parsed?.detail || {},
      scorerExitCode: result.status
    };
  } catch (error) {
    return {
      available: false,
      score: null,
      error: `Writing scorer returned invalid JSON: ${error.message}`,
      stderr: String(result.stderr || '').slice(0, 1000)
    };
  }
}

module.exports = { runQualityGate, runWritingScore };
