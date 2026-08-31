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
    } catch {
        return fallback;
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
    return {
        profile: readJson(path.join(stateDirectory, 'story_profile.json'), {}),
        eras: readJson(path.join(stateDirectory, 'profile_eras.json'), []),
        identity: readJson(path.join(stateDirectory, 'app_identity.json'), {}),
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

export async function loadStoryProfileCard({
    directories,
    stateDirectory = resolveStoryProfileStateDirectory(),
    now,
    getCharacterFn,
    listWorldsFn = runtimeDirectories => resolveNoraWorldCore(runtimeDirectories).listWorlds(),
    statistics,
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
    return buildStoryProfileCard({ worlds, statsByWorld, characters, now, ...state });
}
