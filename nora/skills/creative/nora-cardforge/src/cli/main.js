#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readCard, writeCardArtifact } = require('../core/card-io');
const { summarizeCard } = require('../core/card-model');
const { runDiagnostics } = require('../diagnostics/static-checks');
const { validateStatusbarHtml } = require('../statusbar/statusbar');
const { initProject, ingestProject, buildProject, inspectProject } = require('../project/project-engine');
const { prepareImport, verifyImport } = require('../install/prepare-import');
const { editProse } = require('../core/prose-edit');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function readTextFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeJsonOutput(value, outputPath) {
  const json = JSON.stringify(value, null, 2);
  if (outputPath) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, json + '\n', 'utf8');
  } else {
    process.stdout.write(json + '\n');
  }
}

function requireArg(args, key) {
  if (!args[key]) throw new Error(`Missing required --${key}`);
  return args[key];
}

async function commandInspect(args) {
  const loaded = readCard(requireArg(args, 'input'));
  writeJsonOutput({
    ok: true,
    source: {
      path: loaded.source.path,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(loaded.source.path)).digest('hex'),
      type: loaded.source.type,
      chunkKeyword: loaded.source.chunkKeyword,
      availableKeywords: loaded.source.availableKeywords
    },
    card: summarizeCard(loaded.card)
  }, args.output);
}

async function commandProjectInit(args) {
  const result = initProject(requireArg(args, 'project'), {
    name: requireArg(args, 'name'),
    slug: args.slug,
    creator: args.creator
  });
  writeJsonOutput(result, args.output);
}

async function commandProjectIngest(args) {
  const result = ingestProject(requireArg(args, 'input'), requireArg(args, 'project'), { slug: args.slug });
  writeJsonOutput(result, args.output);
}

async function commandProjectInspect(args) {
  writeJsonOutput(inspectProject(requireArg(args, 'project')), args.output);
}

async function commandProjectBuild(args) {
  const result = buildProject(requireArg(args, 'project'), { profile: args.profile, scoreWriting: args['score-writing'] === true });
  writeJsonOutput(result, args.output);
}

async function commandPrepareImport(args) {
  for (const key of ['confirm', 'world-id', 'native-cli', 'url']) {
    if (Object.hasOwn(args, key)) throw new Error(`--${key} is not a prepare-import option; this command only stages a new-World MCP request`);
  }
  const result = prepareImport(requireArg(args, 'project'), {
    dryRun: !!args['dry-run'],
    uploadRoot: requireArg(args, 'upload-root'),
    idempotencyKey: requireArg(args, 'idempotency-key')
  });
  writeJsonOutput(result, args.output);
}

async function commandDiagnose(args) {
  const loaded = readCard(requireArg(args, 'input'));
  const report = runDiagnostics(loaded.card, { profile: args.profile || 'nora' });
  writeJsonOutput({ ok: true, report }, args.output);
}

async function commandStatusbarValidate(args) {
  const loaded = readCard(requireArg(args, 'input'));
  const html = readTextFile(requireArg(args, 'html'));
  const report = validateStatusbarHtml(loaded.card, html);
  writeJsonOutput({ ok: report.passed, report }, args.output);
}

async function commandExport(args) {
  const loaded = readCard(requireArg(args, 'input'));
  const outputPath = requireArg(args, 'output');
  writeCardArtifact({
    card: loaded.card,
    source: loaded.source,
    outputPath,
    coverPath: args.cover
  });
  writeJsonOutput({ ok: true, output: outputPath }, args.report);
}

async function commandProseEdit(args) {
  const plan = JSON.parse(readTextFile(requireArg(args, 'edits')));
  const result = editProse(requireArg(args, 'input'), plan, requireArg(args, 'output'), { dryRun: !!args['dry-run'] });
  writeJsonOutput(result);
}

function printHelp() {
  process.stdout.write(`nora-cardforge <command> [options]

Commands:
  init --project DIR --name NAME [--slug SLUG] [--creator CREATOR]
  ingest --input card.png|card.json --project DIR [--slug SLUG]
  project-inspect --project DIR [--output report.json]
  build --project DIR [--profile release|release-strict] [--score-writing] [--output report.json]
  prepare-import --project DIR --upload-root DIR --idempotency-key KEY [--dry-run] [--output report.json]
  verify-import --prepared handoff.json --inspection world-inspect.json [--output report.json]
  inspect --input card.png|card.json [--output report.json]
  diagnose --input card.png|card.json [--profile nora] [--output report.json]
  prose-edit --input card.png|card.json --edits prose.json --output NEW.png|json [--dry-run]
  statusbar-validate --input card.png|card.json --html statusbar.html [--output report.json]
  export --input card.png|card.json --output card.out.png|json [--cover cover.png]
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || command === 'help' || args.help) {
    printHelp();
    return;
  }
  if (command === 'install') {
    const error = new Error('install was retired. Use prepare-import, then the configured nora.world.import MCP tool after authorization to create a NEW World. See references/import-install.md.');
    error.code = 'INSTALL_MOVED_TO_MCP';
    throw error;
  }
  const commands = {
    init: commandProjectInit,
    ingest: commandProjectIngest,
    'project-inspect': commandProjectInspect,
    build: commandProjectBuild,
    'prepare-import': commandPrepareImport,
    'verify-import': async args => {
      const report = verifyImport(JSON.parse(readTextFile(requireArg(args, 'prepared'))), JSON.parse(readTextFile(requireArg(args, 'inspection'))));
      writeJsonOutput(report, args.output);
      if (!report.ok) process.exitCode = 1;
    },
    inspect: commandInspect,
    diagnose: commandDiagnose,
    'prose-edit': commandProseEdit,
    'statusbar-validate': commandStatusbarValidate,
    export: commandExport
  };
  if (!commands[command]) throw new Error(`Unknown command: ${command}`);
  await commands[command](args);
}

main().catch(error => {
  process.stderr.write(JSON.stringify({
    ok: false,
    code: error.code || 'COMMAND_FAILED',
    error: error.message,
    report: error.report || undefined
  }, null, 2) + '\n');
  process.exitCode = error.code === 'QUALITY_GATE_FAILED' ? 1 : 2;
});
