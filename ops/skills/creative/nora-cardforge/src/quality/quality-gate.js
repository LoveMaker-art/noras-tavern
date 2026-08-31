const path = require('path');
const { spawnSync } = require('child_process');
const { runDiagnostics } = require('../diagnostics/static-checks');
const { validateStatusbarHtml } = require('../statusbar/statusbar');

function runQualityGate({ card, cardMdPath, statusbarHtml = '', profile = 'release' }) {
  const structure = runDiagnostics(card, { profile });
  const statusbar = statusbarHtml ? validateStatusbarHtml(card, statusbarHtml) : null;
  const writing = cardMdPath ? runWritingScore(cardMdPath) : null;
  const strictWriting = profile === 'release-strict';
  const hardFailures = [];
  if (!structure.passed) hardFailures.push('structure');
  if (statusbar && !statusbar.passed) hardFailures.push('statusbar');
  if (strictWriting && (!writing?.available || writing.score < 75)) hardFailures.push('writing');
  return {
    profile,
    passed: hardFailures.length === 0,
    hardFailures,
    structure,
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

function runWritingScore(cardMdPath) {
  const script = path.resolve(__dirname, '../../scripts/score_card.py');
  const result = spawnSync('python3', [script, path.resolve(cardMdPath), '--json'], {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.error) {
    return { available: false, score: null, error: result.error.message };
  }
  try {
    const parsed = JSON.parse(result.stdout || '[]')[0];
    return {
      available: true,
      score: Number(parsed?.score || 0),
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
