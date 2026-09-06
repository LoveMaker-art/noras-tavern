import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const domain = read('engine/sillytavern/src/nora-world-core/domain.js');
const core = read('engine/sillytavern/src/nora-world-core/service.js');
const endpoint = read('engine/sillytavern/src/endpoints/nora-worlds-v2.js');
const client = read('engine/sillytavern/public/scripts/nora-worlds/world-core-client.js');
const controller = read('engine/sillytavern/public/scripts/nora-worlds/world-capability-controller.js');
const renderReadiness = read('engine/sillytavern/public/scripts/nora-worlds/world-render-readiness.js');
const script = read('engine/sillytavern/public/script.js');
const adapter = read('engine/sillytavern/public/scripts/nora-adapters/st-card-adapter.js');
const ui = read('native-extensions/nora-ui/index.js');
const worldController = read('native-extensions/nora-ui/world-controller.js');
const startupController = read('native-extensions/nora-ui/startup-controller.js');
const panelController = read('native-extensions/nora-ui/panel-controller.js');

for (const signal of [
    'beginWorldCapabilityAttempt',
    'settleWorldCapabilityAttempt',
    'attempt_id',
    'duration_ms',
    'evidence',
    'NORA_CAPABILITY_ATTEMPT_CONFLICT',
]) {
    assert.match(domain, new RegExp(signal), `World manifest capability state is missing: ${signal}`);
}
assert.match(core, /beginCapabilityAttempt[\s\S]*settleCapabilityAttempt/);
assert.match(endpoint, /capabilities\/:capability\/attempts[\s\S]*attempts\/:attemptId/);
assert.match(client, /beginCapabilityAttempt[\s\S]*settleCapabilityAttempt/);

assert.match(controller, /CAPABILITY_ORDER\s*=\s*Object\.freeze\(\['prompt_template', 'regex', 'tavern_helper', 'mvu'\]\)/);
assert.match(controller, /runtime\.ensureCharacterCapability\(character, capability\)/);
assert.match(controller, /status:\s*'DEGRADED'[\s\S]*client\.settleCapabilityAttempt/);
assert.match(controller, /const runtimeVerified = new Set\(\)/, 'page runtime readiness must not reuse persisted READY evidence');
assert.match(controller, /return Object\.freeze\(\{\s*prepare,\s*ensure,\s*retry:/, 'the controller must expose one pre-render preparation owner, one persistence owner and an explicit retry path');

for (const signal of [
    "normalized === 'prompt_template'",
    "normalized === 'regex'",
    "normalized === 'tavern_helper'",
    'NORA_MVU_TIMEOUT',
    "api: 'getMvuData'",
    'extension_active: true',
    'character_allowed: true',
]) {
    assert.match(adapter, new RegExp(signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `ST readiness adapter is missing: ${signal}`);
}

const baseActivation = worldController.indexOf('worldRuntime.activate(current.id');
const supportingSchedule = worldController.indexOf('scheduleSupportingContent(current, current.interactionId)');
assert.ok(baseActivation >= 0 && supportingSchedule > baseActivation, 'supporting capability settlement must remain after base World activation');
assert.match(renderReadiness, /export function registerWorldRenderReadiness[\s\S]*export async function prepareWorldRender/);
assert.match(ui, /registerWorldRenderReadiness\(\(\{ worldId \}\) => prepareWorldCapabilities\(worldId\)\)/, 'Nora UI must register the sole display-capability preparation owner');
const displayPreparation = script.indexOf("snapshotStep('display-capabilities', () => prepareWorldRender(");
const chatPreRender = script.indexOf("snapshotStep('event.chat-pre-render'");
const domRender = script.indexOf("snapshotStep('dom-render', printMessages)");
assert.ok(displayPreparation >= 0 && chatPreRender > displayPreparation && domRender > chatPreRender, 'display capabilities must settle at the ST render boundary before extension hooks and DOM rendering');
assert.doesNotMatch(worldController, /prepareWorldCapabilities/, 'World selection must not duplicate display-capability preparation');
assert.doesNotMatch(startupController, /loadWorldCapabilities|promptCharacterCapabilities/, 'startup must not duplicate World capability ownership');
assert.match(panelController, /data-retry-capability[\s\S]*retryWorldCapability/);

const browserSources = [worldController, startupController, panelController].join('\n');
assert.doesNotMatch(browserSources, /ensureCharacterCapability\(/, 'Nora UI controllers must not execute ST readiness adapters directly');

console.log('nora-world-capability-contract=PASS');
