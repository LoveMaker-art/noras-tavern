import fs from 'node:fs';
import path from 'node:path';

const STATE_SCHEMA = 'nora-story-profile-preference-checkpoints/v1';
const STATE_FILENAME = 'story_profile_preference_checkpoints.json';

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readState(filePath) {
    try {
        const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (value?.schema === STATE_SCHEMA && value.worlds && typeof value.worlds === 'object') {
            return value;
        }
    } catch {
        // Missing or malformed state is recovered from the canonical chat.
    }
    return { schema: STATE_SCHEMA, worlds: {} };
}

function writeFileAtomicSync(filePath, content) {
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(temporary, content, 'utf8');
        fs.renameSync(temporary, filePath);
    } finally {
        try {
            fs.unlinkSync(temporary);
        } catch {
            // The rename removes the temporary path on success.
        }
    }
}

function normalizedStatus(value = {}) {
    return {
        reflected_at_turns: Math.max(0, Number.parseInt(value.reflected_at_turns, 10) || 0),
        last_attempt_at: String(value.last_attempt_at || ''),
        last_success_at: String(value.last_success_at || ''),
        last_error: String(value.last_error || ''),
    };
}

function userTurnCount(story) {
    return Array.isArray(story)
        ? story.filter(message => message?.role === 'user' && String(message?.text || '').trim()).length
        : 0;
}

/**
 * Persist one idempotent reflection cursor per World while keeping model work
 * off the foreground generation path.
 */
export function createPreferenceCheckpointCoordinator({
    stateDirectory,
    loadProgress,
    loadContext,
    runReflection,
    minimumTurns = process.env.TAVERN_STORY_PROFILE_REFLECT_MIN || 15,
    everyTurns = process.env.TAVERN_STORY_PROFILE_REFLECT_EVERY || 15,
    now = () => new Date().toISOString(),
} = {}) {
    if (!stateDirectory) throw new TypeError('Preference checkpoint state directory is required.');
    if (typeof loadProgress !== 'function') throw new TypeError('Preference progress reader is required.');
    if (typeof loadContext !== 'function') throw new TypeError('Preference context loader is required.');
    if (typeof runReflection !== 'function') throw new TypeError('Preference reflection runner is required.');

    const stateFile = path.join(path.resolve(stateDirectory), STATE_FILENAME);
    const minimum = positiveInteger(minimumTurns, 15);
    const interval = positiveInteger(everyTurns, 15);
    const jobs = new Map();
    const checks = new Map();
    let state = readState(stateFile);

    function save() {
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        writeFileAtomicSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    }

    function status(worldId) {
        const key = String(worldId || '').trim();
        return {
            world_id: key,
            ...normalizedStatus(state.worlds[key]),
            running: jobs.has(key),
        };
    }

    async function evaluate(worldId) {
        const key = String(worldId || '').trim();
        if (!key) throw new TypeError('World ID is required.');
        const progress = await loadProgress(key);
        if (!progress || String(progress.world_id || '') !== key) {
            throw new Error(`Story Profile world not found: ${key}`);
        }
        const userTurns = progress.user_turns;
        if (!Number.isSafeInteger(userTurns) || userTurns < 0) throw new TypeError('Invalid reflection turn count.');
        const current = normalizedStatus(state.worlds[key]);
        const due = userTurns >= minimum && userTurns - current.reflected_at_turns >= interval;
        if (!due) {
            return {
                scheduled: false,
                reason: 'not_due',
                user_turns: userTurns,
                ...status(key),
            };
        }
        if (jobs.has(key)) {
            return {
                scheduled: false,
                reason: 'already_running',
                user_turns: userTurns,
                ...status(key),
            };
        }

        const context = await loadContext(key);
        if (!context || String(context.world_id || '') !== key
            || context.session_id !== progress.session_id || context.revision !== progress.revision
            || userTurnCount(context.story) !== userTurns) {
            return { scheduled: false, reason: 'history_changed', user_turns: userTurns, ...status(key) };
        }

        current.last_attempt_at = now();
        current.last_error = '';
        state.worlds[key] = current;
        save();

        let job;
        // Install the job before any injected model runner can finish/throw.
        job = Promise.resolve().then(async () => {
            try {
                await runReflection(context);
                const latest = normalizedStatus(state.worlds[key]);
                latest.reflected_at_turns = Math.max(latest.reflected_at_turns, userTurns);
                latest.last_success_at = now();
                latest.last_error = '';
                state.worlds[key] = latest;
                save();
            } catch (error) {
                const latest = normalizedStatus(state.worlds[key]);
                latest.last_error = String(error?.message || error || 'reflection_failed').slice(0, 1000);
                state.worlds[key] = latest;
                save();
            } finally {
                if (jobs.get(key) === job) jobs.delete(key);
            }
        });
        jobs.set(key, job);
        return {
            scheduled: true,
            reason: 'checkpoint_due',
            user_turns: userTurns,
            ...status(key),
        };
    }

    function checkpoint(worldId) {
        const key = String(worldId || '').trim();
        const previous = checks.get(key) || Promise.resolve();
        // Serialize only eligibility/context reads, never the model call.
        const check = previous.catch(() => {}).then(() => evaluate(key));
        checks.set(key, check);
        return check.finally(() => {
            if (checks.get(key) === check) checks.delete(key);
        });
    }

    async function waitForIdle(worldId) {
        const job = jobs.get(String(worldId || '').trim());
        if (job) await job;
        return status(worldId);
    }

    return Object.freeze({ checkpoint, status, waitForIdle });
}
