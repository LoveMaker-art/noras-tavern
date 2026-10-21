import fs from 'node:fs';
import path from 'node:path';

import { resolveNoraWorldCore } from './nora-world-core/runtime.js';
import { resolveStoryStatistics, summarizeStoryChat } from './nora-story-statistics.js';

const INTIMACY_WEIGHT = 8;
const INTIMACY_LADDER = [
    { level: '初见', threshold: 0, blurb: '刚认识，还在摸你的脾气' },
    { level: '相识', threshold: 15, blurb: '演过几场，记住了你几样' },
    { level: '搭档', threshold: 40, blurb: '有默契雏形，接得住你的球' },
    { level: '默契', threshold: 100, blurb: '一个眼神就懂，越演越顺' },
    { level: '知己', threshold: 250, blurb: '最懂你怎么玩的那个演员' },
];

function readJson(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (cause) {
        if (cause.code === 'ENOENT') return fallback;
        throw Object.assign(new Error('故事档案文件无法读取；原数据已保留。', { cause }), {
            code: 'STORY_PROFILE_STORAGE_UNREADABLE', file: path.basename(filePath),
        });
    }
}

function text(value) {
    return String(value ?? '').trim();
}

function characterTags(character) {
    const source = character?.data?.tags ?? character?.tags ?? [];
    return Array.isArray(source)
        ? source.map(text).filter(tag => /[\p{L}\p{N}]/u.test(tag))
        : [];
}

function activePreferences(profile) {
    return (Array.isArray(profile?.preferences) ? profile.preferences : [])
        .filter(item => item?.status === 'confirmed' && text(item?.text))
        .map(item => text(item.text));
}

function intimacy(score) {
    let index = 0;
    for (let cursor = 0; cursor < INTIMACY_LADDER.length; cursor += 1) {
        if (score >= INTIMACY_LADDER[cursor].threshold) index = cursor;
    }
    const current = INTIMACY_LADDER[index];
    const next = INTIMACY_LADDER[index + 1] ?? null;
    const span = next ? next.threshold - current.threshold : 0;
    const progress = next && span > 0
        ? Math.max(0, Math.min(1, (score - current.threshold) / span))
        : 1;
    return {
        level: current.level,
        score,
        next: next?.level ?? null,
        to_next: next ? Math.max(0, next.threshold - score) : 0,
        progress: Math.round(progress * 1000) / 1000,
        blurb: current.blurb,
    };
}

function worldIdentity(world) {
    return text(world?.world_id);
}

function worldAvatar(world) {
    return text(world?.runtime_card?.binding?.avatar);
}

/**
 * Reproduce the original Story Profile career/intimacy/archive projection from
 * current Nora world documents and native SillyTavern chat messages.
 */
export function buildStoryProfileCard({
    worlds = [],
    chatsByWorld = {},
    statsByWorld = {},
    characters = [],
    profile = {},
    eras = [],
    identity = {},
    now = () => new Date(),
} = {}) {
    const characterByAvatar = new Map(characters.map(character => [text(character?.avatar), character]));
    const roleAvatars = new Set();
    const rolesPlayed = new Map();
    const roleNames = new Map();
    const specialties = [];
    let totalTurns = 0;
    let totalWords = 0;
    let debutAt = null;

    for (const world of worlds) {
        const avatar = worldAvatar(world);
        const cast = world.story_context?.characters;
        const roles = cast ? cast.map(character => ({ id: 'cast:' + character.id,
            name: character.profile.identity.name, tags: character.tags || [] }))
            : avatar ? [{ id: avatar, name: text(characterByAvatar.get(avatar)?.name) || '角色',
                tags: characterTags(characterByAvatar.get(avatar)) }] : [];
        for (const role of roles) {
            roleAvatars.add(role.id);
            roleNames.set(role.id, role.name);
        }
        const createdAt = Date.parse(text(world?.created_at));
        if (Number.isFinite(createdAt) && (debutAt === null || createdAt < debutAt)) debutAt = createdAt;

        const stats = Object.hasOwn(statsByWorld, worldIdentity(world))
            ? statsByWorld[worldIdentity(world)]
            : summarizeStoryChat(chatsByWorld?.[worldIdentity(world)] || []);
        const worldTurns = stats.turns;
        totalTurns += stats.turns;
        totalWords += stats.words;
        for (const role of roles) {
            rolesPlayed.set(role.id, (rolesPlayed.get(role.id) ?? 0) + worldTurns);
            for (const tag of role.tags) if (!specialties.includes(tag)) specialties.push(tag);
        }
    }

    const nowValue = now();
    const nowMs = nowValue instanceof Date ? nowValue.getTime() : new Date(nowValue).getTime();
    const debutDays = debutAt === null || !Number.isFinite(nowMs)
        ? 0
        : Math.max(0, Math.floor((nowMs - debutAt) / 86_400_000));
    const timeline = Array.isArray(profile?.recent_timeline) ? [...profile.recent_timeline].reverse() : [];
    const eventCount = Number.parseInt(profile?.stats?.event_count, 10);
    const logCount = Number.isFinite(eventCount) ? eventCount : timeline.length;
    const intimacyValue = intimacy(totalTurns + INTIMACY_WEIGHT * logCount);
    intimacyValue.turns = totalTurns;
    intimacyValue.log = logCount;

    return {
        name: text(identity?.persona_name) || '故事主理人',
        tagline: text(identity?.actor_tagline) || '你的故事主理人',
        career: {
            debut_days: debutDays,
            productions: worlds.length,
            turns: totalTurns,
            words: totalWords,
            roles: roleAvatars.size,
        },
        intimacy: intimacyValue,
        knows: activePreferences(profile),
        timeline,
        eras: Array.isArray(eras) ? [...eras].reverse() : [],
        profile_revision: Number.parseInt(profile?.revision, 10) || 0,
        specialties: specialties.slice(0, 8),
        roles_played: [...rolesPlayed.entries()]
            .map(([avatar, turns]) => ({
                name: roleNames.get(avatar) || '角色',
                turns,
            }))
            .sort((left, right) => right.turns - left.turns),
    };
}

export function resolveStoryProfileStateDirectory(environment = process.env) {
    const hermesHome = text(environment.HERMES_HOME)
        || (process.platform === 'linux' && fs.existsSync('/opt/data/skills') ? '/opt/data' : path.join(process.env.HOME || '.', '.hermes'));
    return path.resolve(text(environment.TAVERN_STATE_DIR) || path.join(text(environment.TAVERN_DATA_ROOT) || hermesHome, 'tavern-state'));
}

export function readStoryProfileState(stateDirectory = resolveStoryProfileStateDirectory()) {
    if (fs.existsSync(path.join(stateDirectory, 'profile_commit.json'))) {
        throw Object.assign(new Error('档案保存尚未确认完成；请先恢复保存结果，原数据已保留。'), { code: 'STORY_PROFILE_COMMIT_PENDING' });
    }
    const profile = readJson(path.join(stateDirectory, 'story_profile.json'), null);
    const eras = readJson(path.join(stateDirectory, 'profile_eras.json'), []);
    if ((profile !== null && (typeof profile !== 'object' || Array.isArray(profile) || profile.schema_version !== 1 || !Array.isArray(profile.preferences))) || !Array.isArray(eras)) {
        throw Object.assign(new Error('故事档案格式不正确；原数据已保留。'), { code: 'STORY_PROFILE_STORAGE_UNREADABLE' });
    }
    if (profile === null && (fs.existsSync(path.join(stateDirectory, 'profile_events.jsonl')) || eras.length)) {
        throw Object.assign(new Error('主档案缺失，但历史记录仍存在；已保留历史，请先恢复档案。'), { code: 'STORY_PROFILE_STORAGE_UNREADABLE' });
    }
    return { profile: profile || {}, eras,
        identity: readJson(path.join(stateDirectory, 'app_identity.json'), {}),
        profile_storage_state: profile === null ? 'missing' : 'ready',
        taste_profile_stale: Boolean(profile?.taste_profile_stale),
    };
}

export function readAgentUserId(environment = process.env) {
    const configured = text(environment.TAVERN_AGENT_USER_ID);
    if (configured) return configured;
    const hermesHome = text(environment.HERMES_HOME)
        || (process.platform === 'linux' && fs.existsSync('/opt/data/skills') ? '/opt/data' : path.join(process.env.HOME || '.', '.hermes'));
    const configPath = text(environment.HERMES_CONFIG_PATH) || path.join(hermesHome, 'config.yaml');
    try {
        const match = fs.readFileSync(configPath, 'utf8').match(/^\s*user_id:\s*["']?(usr_[^\s"']+)/m);
        return match?.[1] || '';
    } catch {
        return '';
    }
}

export async function loadStoryProfileReflectionContext({
    directories,
    worldId,
    getCharacterFn,
    getWorldFn = (runtimeDirectories, requestedWorldId) => resolveNoraWorldCore(runtimeDirectories).getWorld(requestedWorldId),
} = {}) {
    if (!directories?.root || !directories?.chats) {
        throw new TypeError('Nora World Core and chat directories are required.');
    }
    if (typeof getCharacterFn !== 'function') {
        throw new TypeError('A character reader is required.');
    }
    const world = await getWorldFn(directories, worldId);
    if (!world) return null;
    const snapshot = await resolveStoryStatistics(directories).read(world, { includeMessages: true });
    const avatar = worldAvatar(world);
    const character = await getCharacterFn(directories, avatar);
    const characterName = world.story_context
        ? world.story_context.characters.map(member => member.profile.identity.name).join('、') || '故事旁白'
        : text(character?.data?.name ?? character?.name) || '角色';
    const story = snapshot.messages
        .map((message, index) => ({
            id: text(message?.send_date) || String(index),
            role: message?.is_user ? 'user' : 'char',
            text: text(message?.mes),
            speaker: text(message?.name) || (message?.is_user ? '用户' : characterName),
        }))
        .filter(message => message.text);
    return {
        world_id: worldIdentity(world),
        world_name: text(world.name) || worldIdentity(world),
        session_id: snapshot.session_id,
        revision: snapshot.revision,
        card: { name: characterName },
        story,
    };
}

export async function loadStoryProfileProgress({
    directories,
    worldId,
    getWorldFn = (runtimeDirectories, requestedWorldId) => resolveNoraWorldCore(runtimeDirectories).getWorld(requestedWorldId),
} = {}) {
    const world = await getWorldFn(directories, worldId);
    if (!world) return null;
    const snapshot = await resolveStoryStatistics(directories).read(world);
    return { world_id: worldIdentity(world), session_id: snapshot.session_id,
        revision: snapshot.revision, user_turns: snapshot.reflectionTurns };
}

/** Read every existing story Session through the canonical ledger reader.
 * This does not schedule compression, recover projections, or write memories.
 */
export async function loadStoryProfileStoryProgress({
    directories,
    worldId = '',
    sessionId = '',
    worlds,
    listWorldsFn = runtimeDirectories => resolveNoraWorldCore(runtimeDirectories).inspectWorlds(),
    collectProgressFn = async (...args) => {
        const { collectStoryProgress } = await import('./nora-story-ledger/profile-projection.js');
        return collectStoryProgress(...args);
    },
} = {}) {
    if (!directories?.root || !directories?.chats) throw new TypeError('Nora World Core and chat directories are required.');
    const allWorlds = worlds ?? await listWorldsFn(directories);
    const selectedWorlds = worldId ? allWorlds.filter(world => worldIdentity(world) === worldId) : allWorlds;
    if (worldId && selectedWorlds.length === 0) throw Object.assign(new Error('找不到指定故事。'), { code: 'WORLD_NOT_FOUND' });
    if (sessionId && !selectedWorlds.some(world => world.sessions?.items?.some(session => session.session_id === sessionId))) {
        throw Object.assign(new Error('找不到指定故事会话。'), { code: 'STORY_SESSION_NOT_FOUND' });
    }
    const scopedWorlds = sessionId ? selectedWorlds.map(world => ({ ...world,
        sessions: { ...world.sessions, items: world.sessions.items.filter(session => session.session_id === sessionId) } })) : selectedWorlds;
    const progress = await collectProgressFn(directories, async () => scopedWorlds);
    if (!Array.isArray(progress)) throw Object.assign(new Error('无法确认故事进度读取结果。'), { code: 'STORY_PROGRESS_UNAVAILABLE' });
    return sessionId ? progress.filter(item => item.session_id === sessionId) : progress;
}

/** Exact on-demand read; no profile loading, statistics pruning, model envelope,
 * World writer initialization or implicit recent-chat attachment. */
export async function loadStoryProfileStoryRead({ directories, payload = {},
    listWorldsFn = runtimeDirectories => resolveNoraWorldCore(runtimeDirectories).inspectWorlds(),
    readSnapshotFn,
} = {}) {
    if (!directories?.root || !directories?.chats) throw new TypeError('Nora World Core and chat directories are required.');
    const { readStoryOnDemand } = await import('./nora-story-ledger/story-read.js');
    const worlds = await listWorldsFn(directories);
    return readStoryOnDemand({ directories, worlds, payload, readSnapshotFn,
        verifyScopeFn: async (world, session) => {
            const fresh = (await listWorldsFn(directories)).find(item => item.world_id === world.world_id);
            const branch = fresh?.sessions?.items?.find(item => item.session_id === session.session_id);
            return Boolean(fresh && branch && JSON.stringify([fresh.name, fresh.revision, fresh.lifecycle,
                fresh.runtime_card?.binding, fresh.story_context, branch]) === JSON.stringify([world.name, world.revision,
                world.lifecycle, world.runtime_card?.binding, world.story_context, session]));
        } });
}

export async function loadStoryProfileCard({
    directories,
    stateDirectory = resolveStoryProfileStateDirectory(),
    now,
    getCharacterFn,
    listWorldsFn = runtimeDirectories => resolveNoraWorldCore(runtimeDirectories).inspectWorlds(),
    statistics,
    collectProgressFn,
} = {}) {
    if (!directories?.root || !directories?.chats) {
        throw new TypeError('Nora World Core and chat directories are required.');
    }
    if (typeof getCharacterFn !== 'function') {
        throw new TypeError('A character reader is required.');
    }
    const worlds = await listWorldsFn(directories);
    const reader = statistics || resolveStoryStatistics(directories);
    const statsByWorld = Object.create(null);
    // Bound peak memory: cold reads load at most one World chat at a time.
    for (const world of worlds) statsByWorld[worldIdentity(world)] = await reader.read(world);
    await reader.prune(worlds);
    const avatars = [...new Set(worlds.map(worldAvatar).filter(Boolean))];
    const characters = (await Promise.all(avatars.map(avatar => getCharacterFn(directories, avatar))))
        .filter(Boolean);
    const state = readStoryProfileState(stateDirectory);
    const card = buildStoryProfileCard({ worlds, statsByWorld, characters, now, ...state });
    let storyProgress;
    let storyProgressError;
    try {
        storyProgress = await loadStoryProfileStoryProgress({ directories, worlds, collectProgressFn });
    } catch (error) {
        storyProgressError = { code: error?.code || 'STORY_PROGRESS_UNAVAILABLE' };
    }
    return { ...card, profile_storage_state: state.profile_storage_state, taste_profile_stale: state.taste_profile_stale,
        story_progress: storyProgress ?? null, story_progress_state: storyProgress ? 'ready' : 'error',
        ...(storyProgressError ? { story_progress_error: storyProgressError } : {}),
        reflection_worlds: worlds.map(world => ({ world_id: worldIdentity(world), world_name: text(world.name) || worldIdentity(world),
            session_id: statsByWorld[worldIdentity(world)].session_id,
            user_turns: statsByWorld[worldIdentity(world)].reflectionTurns })) };
}
