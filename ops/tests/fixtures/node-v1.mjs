// Sanitized historical nora-world/v1 layout (legacy-migration.js's real contract).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function createLegacyState(state, repository) {
    const root = path.join(state, 'native/default-user');
    for (const name of ['characters', 'chats/legacy', 'worlds', 'nora-worlds']) await fs.mkdir(path.join(root, name), { recursive: true });
    const card = await fs.readFile(path.join(repository, 'app/engine/sillytavern/tests/fixtures/nora-world-compat/sanitized-managed-mvu-v3.png'));
    await fs.writeFile(path.join(root, 'characters/legacy.png'), card);
    const registry = {
        schema: 'nora-world/v1', id: 'world:legacy-fixture', name: '迁移测试世界',
        persona: { name: '测试用户', description: '保留我的角色设定' },
        runtime: { character_avatar: 'legacy.png', chat_id: 'story', worldbook_names: ['setting'] },
        ownership: { character_card: false, worldbooks: [] },
        source: { sha256: crypto.createHash('sha256').update(card).digest('hex'), file_name: 'legacy.png', format: 'png' },
        created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-02T00:00:00.000Z',
    };
    await fs.writeFile(path.join(root, 'nora-worlds/legacy.json'), JSON.stringify(registry));
    await fs.writeFile(path.join(root, 'worlds/setting.json'), JSON.stringify({ entries: { 0: { uid: 0, key: ['测试'], content: '保留世界设定', constant: true } } }));
    const header = { user_name: '测试用户', character_name: 'legacy', create_date: registry.created_at,
        chat_metadata: { nora_world: { id: registry.id, version: 1, name: registry.name, persona: registry.persona }, world_info: 'setting', variables: { stat_data: { time: 30 } } } };
    const messages = Array.from({ length: 60 }, (_, i) => ({ name: i % 2 ? '角色' : '测试用户', is_user: i % 2 === 0,
        is_system: false, mes: `保留第 ${Math.floor(i / 2) + 1} 轮 ${i % 2 ? '回复' : '输入'}`,
        extra: i % 2 ? { reasoning: '保留思考', variables: { stat_data: { turn: i } } } : {},
        ...(i === 59 ? { swipe_id: 0, swipes: ['保留回复', '另一回复'] } : {}) }));
    const chat = path.join(root, 'chats/legacy/story.jsonl');
    await fs.writeFile(chat, [header, ...messages].map(x => JSON.stringify(x)).join('\n') + '\n');
    const event = { id: 'fixture-event', date: '2026-08-01', change: '保留事件', source_type: 'manual', created_at: 1785542400 };
    const profile = { schema_version: 1, revision: 1, created_at: 1785542400, updated_at: 1785542400,
        display: { identity_markdown: '原主理人', signature_markdown: '原签名' },
        preferences: [{ id: 'fixture-preference', text: '保留口味', status: 'confirmed', scope: 'both', locked: false }],
        recent_timeline: [event], taste_profile: {}, shared_story_memory: [], stats: { event_count: 1, era_count: 1 } };
    await fs.writeFile(path.join(state, 'story_profile.json'), JSON.stringify(profile));
    await fs.writeFile(path.join(state, 'profile_eras.json'), JSON.stringify([{ id: 'fixture-era', summary: '保留故事年表',
        start_date: '2026-08-01', end_date: '2026-08-01', event_count: 1, event_ids: [event.id], created_at: 1785542400 }]));
    await fs.writeFile(path.join(state, 'profile_events.jsonl'), JSON.stringify(event) + '\n');
    return { root, chat, registry, messages };
}
