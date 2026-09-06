import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createChatIdentity,
    createStorySessionIdentity,
    noraIdentityKey,
    sameNoraIdentity,
} from '../public/scripts/nora-chat/identity.js';

test('normalizes the optional JSONL suffix before comparing chat identities', () => {
    const withoutSuffix = createChatIdentity({ avatar: 'target.png', chatId: 'session' });
    const withSuffix = createChatIdentity({ avatar: 'target.png', chatId: 'session.jsonl' });

    assert.equal(sameNoraIdentity(withoutSuffix, withSuffix), true);
    assert.equal(noraIdentityKey(withoutSuffix), noraIdentityKey(withSuffix));
});

test('keeps different Runtime Cards and Story Sessions distinct', () => {
    const firstChat = createChatIdentity({ avatar: 'first.png', chatId: 'session' });
    const secondChat = createChatIdentity({ avatar: 'second.png', chatId: 'session' });
    const firstSession = createStorySessionIdentity({ worldId: 'world:one', sessionId: 'session:one' });
    const secondSession = createStorySessionIdentity({ worldId: 'world:one', sessionId: 'session:two' });

    assert.equal(sameNoraIdentity(firstChat, secondChat), false);
    assert.equal(sameNoraIdentity(firstSession, secondSession), false);
    assert.notEqual(noraIdentityKey(firstChat), noraIdentityKey(secondChat));
    assert.notEqual(noraIdentityKey(firstSession), noraIdentityKey(secondSession));
});

test('rejects incomplete and cross-kind identities', () => {
    const chat = createChatIdentity({ avatar: 'target.png', chatId: 'session' });
    const session = createStorySessionIdentity({ worldId: 'world:one', sessionId: 'session' });

    assert.equal(createChatIdentity({ avatar: 'target.png' }), null);
    assert.equal(createStorySessionIdentity({ worldId: 'world:one' }), null);
    assert.equal(sameNoraIdentity(chat, session), false);
    assert.equal(noraIdentityKey(null), null);
});
