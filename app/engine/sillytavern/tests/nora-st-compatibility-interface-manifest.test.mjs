import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');
const manifestPath = path.join(root, '../docs/architecture/ST-COMPATIBILITY-INTERFACE-MANIFEST.json');

test('ST compatibility has an explicit capability owner and support boundary', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.schema_version, 1);

    const capabilities = new Map(manifest.capabilities.map(item => [item.id, item]));
    const expected = new Map([
        ['story.send', ['story-action-dispatcher', 'adapter']],
        ['story.stop', ['story-action-dispatcher', 'adapter']],
        ['story.regenerate', ['story-action-dispatcher', 'adapter']],
        ['story.edit', ['story-action-dispatcher', 'adapter']],
        ['story.swipe', ['story-action-dispatcher', 'adapter']],
        ['helper.generate', ['tavern-helper-action-adapter', 'adapter']],
        ['helper.generateRaw', ['tavern-helper-action-adapter', 'adapter']],
        ['helper.stop', ['tavern-helper-action-adapter', 'adapter']],
        ['helper.slash', ['tavern-helper-native', 'matrix']],
        ['helper.variables', ['tavern-helper-native', 'adapter']],
        ['helper.worldbook', ['tavern-helper-native', 'adapter']],
        ['legacy.dom-controls', ['per-extension-adapter', 'matrix']],
        ['remote.arbitrary-script', ['security-policy', 'unsupported']],
    ]);

    for (const [id, [owner, support]] of expected) {
        const capability = capabilities.get(id);
        assert.ok(capability, `missing capability: ${id}`);
        assert.equal(capability.owner, owner, `${id} owner`);
        assert.equal(capability.support, support, `${id} support`);
        assert.ok(capability.entrypoint, `${id} must name its entrypoint`);
    }

    const messageActions = new Map(manifest.post_message_actions.map(item => [item.type, item]));
    assert.equal(messageActions.get('request_chat_completion')?.command, 'story.send');
    assert.equal(messageActions.get('request_chat_stop')?.command, 'story.stop');
    assert.equal(manifest.unknown_card_action_policy, 'explicit-error');
    assert.deepEqual(manifest.removed_st_dom_controls.sort(), ['#mes_stop', '#options_button', '#send_but']);
});

test('all direct model APIs in the supported compatibility surface converge on StoryActionDispatcher', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const capability of manifest.capabilities.filter(item => item.model_output === 'direct' && item.support === 'adapter')) {
        assert.equal(capability.dispatcher, 'StoryActionDispatcher', capability.id);
    }
});
