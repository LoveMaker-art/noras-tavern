import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const STATE_SCHEMA = 'nora-story-profile-preference-checkpoints/v2';
const LEGACY_SCHEMA = 'nora-story-profile-preference-checkpoints/v1';
const STATE_FILENAME = 'story_profile_preference_checkpoints.json';
const SETTINGS_FILENAME = 'story_profile_preference_settings.json';
export const PREFERENCE_CONSENT_VERSION = 'story-profile-auto/v1';
const NOTICE = '自动整理故事偏好会把必要故事片段发送给当前酒馆文本模型，可能持续产生调用费用。关闭后不再发起新的自动复盘，已有档案保留。';

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function safeError(value) { return String(value || '').replace(/\bsk-[a-z0-9_-]{8,}/gi, '<redacted>').replace(/Bearer\s+[^\s\"']+/gi, 'Bearer <redacted>').replace(/([?&](?:token|api_key|key)=)[^&\s]+/gi, '$1<redacted>').slice(0, 1000); }
function failure(code, message, cause) { return Object.assign(new Error(message, { cause }), { code }); }
function readDocument(filePath, fallback, code) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch (cause) {
        if (cause.code === 'ENOENT') return fallback;
        throw failure(code, '故事档案状态记录无法读取；原文件已保留，请检查日志。', cause);
    }
}
function writeFileAtomicSync(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try { fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 }); fs.renameSync(temporary, filePath); }
    finally { try { fs.unlinkSync(temporary); } catch { /* Rename removes the temporary path. */ } }
}
function currentPreferenceSettings(stateDirectory) {
    const value = readDocument(path.join(stateDirectory, SETTINGS_FILENAME), undefined, 'STORY_PROFILE_SETTINGS_UNREADABLE');
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.auto_enabled !== 'boolean')) {
        throw failure('STORY_PROFILE_SETTINGS_UNREADABLE', '自动复盘设置格式不正确；原设置已保留。');
    }
    return value;
}
function readLegacyPreference(preferenceFile) {
    if (!preferenceFile) return {};
    const source = { path_sha256: createHash('sha256').update(path.resolve(preferenceFile)).digest('hex'), sha256: 'missing' };
    let bytes;
    try { bytes = fs.readFileSync(preferenceFile); }
    catch (cause) {
        if (cause.code === 'ENOENT') return { source };
        return { error: failure('STORY_PROFILE_SETTINGS_UNREADABLE', '旧自动复盘设置无法读取；原设置已保留。', cause) };
    }
    source.sha256 = createHash('sha256').update(bytes).digest('hex');
    try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || (Object.hasOwn(value, 'automatic_reflection') && (!value.automatic_reflection
                || typeof value.automatic_reflection !== 'object' || Array.isArray(value.automatic_reflection)
                || typeof value.automatic_reflection.enabled !== 'boolean'))) throw new TypeError('Invalid legacy choice.');
        return { source, choice: value.automatic_reflection?.enabled };
    } catch (cause) {
        return { source, error: failure('STORY_PROFILE_SETTINGS_UNREADABLE', '旧自动复盘设置格式不正确；原设置已保留。', cause) };
    }
}
export function readPreferenceSettings(stateDirectory, { preferenceFile } = {}) {
    const value = currentPreferenceSettings(stateDirectory), legacy = readLegacyPreference(preferenceFile);
    const overridden = Boolean(legacy.source && value?.legacy_source
        && value.legacy_source.path_sha256 === legacy.source.path_sha256 && value.legacy_source.sha256 === legacy.source.sha256);
    if (legacy.error && !overridden) throw legacy.error;
    // Explicit settings may resolve this exact legacy source; later legacy
    // changes re-enter off-first reconciliation without rewriting the old file.
    const choiceRecorded = value !== undefined || legacy.choice !== undefined;
    return { auto_enabled: overridden ? value.auto_enabled : value?.auto_enabled !== false && legacy.choice !== false, consent_version: PREFERENCE_CONSENT_VERSION,
        choice_recorded: choiceRecorded, updated_at: String(value?.updated_at || ''), notice: NOTICE };
}
export function writePreferenceSettings(stateDirectory, value, options = {}, now = () => new Date().toISOString()) {
    if (typeof options === 'function') { now = options; options = {}; }
    if (typeof value?.auto_enabled !== 'boolean' || (value.auto_enabled && value.consent_version !== PREFERENCE_CONSENT_VERSION)) {
        throw failure('STORY_PROFILE_CONSENT_REQUIRED', '请先阅读内容发送和费用说明，再选择是否开启自动复盘。');
    }
    // An explicit choice can resolve readable legacy bytes while leaving them
    // intact. Never replace an unreadable current file or cover an I/O unknown.
    currentPreferenceSettings(stateDirectory);
    const legacy = readLegacyPreference(options.preferenceFile);
    if (legacy.error && !legacy.source) throw legacy.error;
    writeFileAtomicSync(path.join(stateDirectory, SETTINGS_FILENAME), JSON.stringify({ schema: 'nora-story-profile-settings/v1',
        auto_enabled: value.auto_enabled, consent_version: PREFERENCE_CONSENT_VERSION, updated_at: now(),
        ...(legacy.source ? { legacy_source: legacy.source } : {}) }, null, 2) + '\n');
    return readPreferenceSettings(stateDirectory, options);
}
function normalizedStatus(value = {}) {
    const status = ['queued', 'running'].includes(value.status) ? 'unknown' : String(value.status || 'idle');
    return { session_id: String(value.session_id || ''), revision: String(value.revision || ''),
        reflected_at_turns: Math.max(0, Number.parseInt(value.reflected_at_turns, 10) || 0),
        last_attempt_at: String(value.last_attempt_at || ''), last_success_at: String(value.last_success_at || ''),
        last_error: safeError(value.last_error), last_code: String(value.last_code || ''),
        stage: String(value.stage || ''), status, summary_status: String(value.summary_status || ''),
        summary_recovered_job_id: String(value.summary_recovered_job_id || ''), resume_available: value.resume_available === true, extraction_complete: value.extraction_complete === true, review_required: value.review_required === true, candidate_ids: Array.isArray(value.candidate_ids) ? value.candidate_ids.slice(0, 30) : [],
        job_id: String(value.job_id || ''), processed: value.processed || null, retryable: value.retryable === true,
        attempts: Math.max(0, Number.parseInt(value.attempts, 10) || 0), retry_after: String(value.retry_after || '') };
}
function readState(filePath) {
    const empty = { schema: STATE_SCHEMA, worlds: {}, sessions: {}, operation: null };
    const value = readDocument(filePath, empty, 'STORY_PROFILE_CHECKPOINT_UNREADABLE');
    if (!value || ![STATE_SCHEMA, LEGACY_SCHEMA].includes(value.schema) || !value.worlds || typeof value.worlds !== 'object') {
        throw failure('STORY_PROFILE_CHECKPOINT_UNREADABLE', '复盘进度记录格式不正确；原记录已保留。');
    }
    if (value.schema === LEGACY_SCHEMA) return { ...empty, worlds: value.worlds, legacy: value };
    return { ...value, sessions: value.sessions || {} };
}
function sortedValue(value) {
    if (Array.isArray(value)) return value.map(sortedValue);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedValue(value[key])]));
    return value;
}
export function reflectionJobId(context = {}) {
    const source = { world_id: context.world_id ?? null, session_id: context.session_id ?? null,
        revision: context.revision ?? null, after_user_turns: context.after_user_turns ?? 0, story: context.story ?? [] };
    return 'reflect_' + createHash('sha256').update(JSON.stringify(sortedValue(source)), 'utf8').digest('hex').slice(0, 32);
}
function reconcileJob(stateDirectory, worldId, current) {
    if (!/^reflect_[a-f0-9]{32}$/.test(current.job_id)) return current;
    const filename = path.join(stateDirectory, 'story_profile_jobs', current.job_id + '.json');
    let job;
    try { job = JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch (cause) {
        if (cause.code === 'ENOENT') return current;
        return { ...current, status: 'unknown', last_code: 'STORY_PROFILE_JOB_UNREADABLE', last_error: '原复盘任务记录无法读取；已保留记录，未重新发起模型请求。', retryable: false };
    }
    const processed = job?.processed;
    const validRange = processed && processed.world_id === worldId && String(processed.session_id || '') === current.session_id
        && Number.isSafeInteger(processed.from_user_turn) && processed.from_user_turn >= 1
        && Number.isSafeInteger(processed.to_user_turn) && processed.to_user_turn >= processed.from_user_turn - 1;
    const hasTexts = Object.hasOwn(job || {}, 'texts');
    const stages = new Set(['requesting_extract', 'extracted', 'saving_preferences', 'preferences_saved', 'requesting_summary', 'completed', 'failed', 'unknown', 'save_failed', 'summary_failed', 'projection_pending']);
    if (!stages.has(job?.stage) || job?.schema !== 'story-profile-reflection-job/1' || job.job_id !== current.job_id || job.world_id !== worldId || !validRange
        || (hasTexts && (!Array.isArray(job.texts) || job.texts.length > 3 || !job.texts.every(text => typeof text === 'string' && text.trim())))) {
        return { ...current, status: 'unknown', last_code: 'STORY_PROFILE_JOB_INVALID', last_error: '原复盘任务记录无法核验；未重放请求或修改原档案。', retryable: false };
    }
    const saved = job.extraction_complete === true || job.result?.extraction_complete === true;
    const next = { ...current, resume_available: hasTexts, extraction_complete: saved,
        review_required: job.result?.review_required === true || current.review_required,
        candidate_ids: job.result?.candidate_ids || current.candidate_ids };
    if (saved) { next.processed = processed; next.reflected_at_turns = Math.max(current.reflected_at_turns, processed.to_user_turn); }
    if (saved && (job.stage === 'completed' || (current.summary_recovered_job_id === job.job_id && ['preferences_saved', 'requesting_summary', 'summary_failed'].includes(job.stage)))) {
        return { ...next, resume_available: false, status: 'completed', stage: 'complete', summary_status: 'current', last_error: '', last_code: '' };
    }
    if (saved) {
        return { ...next, status: 'partial', stage: job.stage === 'projection_pending' ? 'projection' : 'summary',
            summary_status: job.stage === 'summary_failed' ? 'failed' : 'pending', retryable: false,
            last_code: job.result?.code || 'STORY_PROFILE_SUMMARY_PENDING',
            last_error: safeError(job.result?.error || '偏好已保存，后续整理尚未完成；请继续原任务。') };
    }
    if (hasTexts) {
        return { ...next, status: 'failed', stage: 'save', summary_status: 'not_started', retryable: false,
            last_code: job.result?.code || 'STORY_PROFILE_SAVE_PENDING',
            last_error: safeError(job.result?.error || '模型提取结果已保留，尚未确认偏好保存；请继续原任务，无需再次提取。') };
    }
    if (['requesting_extract', 'unknown'].includes(job.stage)) {
        return { ...next, status: 'unknown', stage: 'extract', summary_status: 'not_started', retryable: false,
            last_code: job.result?.code || 'STORY_PROFILE_OUTCOME_UNKNOWN',
            last_error: safeError(job.result?.error || '上次提取请求结果尚未确认；请检查状态后明确选择是否再次调用模型。') };
    }
    return next;
}
function userTurnCount(story) { return Array.isArray(story) ? story.filter(message => message?.role === 'user' && String(message?.text || '').trim()).length : 0; }

/** One foreground-independent queue and session-bound cursor for all profile writers. */
export function createPreferenceCheckpointCoordinator({ stateDirectory, preferenceFile, loadProgress, loadContext, runReflection,
    loadSettings = () => readPreferenceSettings(stateDirectory, { preferenceFile }), minimumTurns = process.env.TAVERN_STORY_PROFILE_REFLECT_MIN || 15,
    everyTurns = process.env.TAVERN_STORY_PROFILE_REFLECT_EVERY || 15, now = () => new Date().toISOString() } = {}) {
    if (!stateDirectory) throw new TypeError('Preference checkpoint state directory is required.');
    if (typeof loadProgress !== 'function' || typeof loadContext !== 'function' || typeof runReflection !== 'function') throw new TypeError('Preference progress, context and reflection runners are required.');
    const stateFile = path.join(path.resolve(stateDirectory), STATE_FILENAME);
    const minimum = positiveInteger(minimumTurns, 15), interval = positiveInteger(everyTurns, 15);
    const jobs = new Map(), checks = new Map();
    const state = readState(stateFile);
    if (state.operation && ['queued', 'running'].includes(state.operation.status)) {
        state.operation = { ...state.operation, status: 'unknown', code: 'REFLECTION_OUTCOME_UNKNOWN', error: '上次复盘结果尚未确认，请先查看已保存结果或手动恢复。' };
    }
    let queue = Promise.resolve();
    let active = false;
    function save() { writeFileAtomicSync(stateFile, JSON.stringify(state, null, 2) + '\n'); }
    function currentFor(key, progress) {
        const session = String(progress?.session_id || '');
        const previous = normalizedStatus(state.worlds[key]);
        const remembered = state.sessions[key]?.[session];
        let current = normalizedStatus(remembered || (previous.session_id === session ? previous : {}));
        if (current.reflected_at_turns > progress.user_turns) current = normalizedStatus({ session_id: session });
        return reconcileJob(stateDirectory, key, { ...current, session_id: session, revision: String(progress?.revision || '') });
    }
    function retain(key, value) {
        state.worlds[key] = value;
        (state.sessions[key] ||= {})[String(value.session_id || '')] = value;
    }
    function status(worldId, progress = null) {
        const key = String(worldId || '').trim();
        const current = progress ? currentFor(key, progress) : reconcileJob(stateDirectory, key, normalizedStatus(state.worlds[key]));
        if (jobs.has(key)) { current.status = state.worlds[key]?.status || 'queued'; }
        return { world_id: key, ...current, running: jobs.has(key),
            running_session_id: jobs.has(key) ? String(state.worlds[key]?.session_id || '') : '' };
    }
    function statuses() { return { worlds: Object.keys(state.worlds).map(key => status(key)), running: active || jobs.size > 0, operation: state.operation }; }
    function serialized(kind, worldId, runner, automatic = false) {
        const execute = async () => {
            if (automatic && !loadSettings().auto_enabled) return { ok: false, status: 'disabled', stage: 'admission', code: 'AUTO_REFLECTION_DISABLED', extraction_complete: false };
            active = true;
            state.operation = { kind, world_id: worldId, status: 'running', started_at: now() }; save();
            try {
                const result = await runner();
                state.operation = { kind, world_id: worldId, status: result?.status || (result?.ok === false ? 'failed' : 'completed'),
                    stage: result?.stage || '', code: result?.code || '', finished_at: now() }; save();
                return result;
            } catch (cause) {
                state.operation = { kind, world_id: worldId, status: cause.result?.status || (/^NORA_MODEL_/.test(cause.code || '') ? 'failed' : 'unknown'), code: cause.code || 'REFLECTION_OUTCOME_UNKNOWN', finished_at: now() }; save();
                throw cause;
            } finally { active = false; }
        };
        const result = queue.catch(() => {}).then(execute);
        queue = result.catch(() => {});
        return result;
    }
    function applyResult(key, current, result) {
        if (!result || typeof result.extraction_complete !== 'boolean') result = { ok: false, status: 'unknown', extraction_complete: false, code: 'REFLECTION_RESULT_INVALID', error: '复盘没有返回可核验结果。' };
        const next = { ...current, status: result.status || (result.ok === false ? 'failed' : 'completed'), stage: result.stage || '',
            summary_status: result.summary_status || '', extraction_complete: result.extraction_complete === true,
            review_required: result.review_required === true, candidate_ids: Array.isArray(result.candidate_ids) ? result.candidate_ids : [], job_id: result.job_id || current.job_id,
            last_error: safeError(result.error), last_code: result.code || '', retryable: result.retryable === true,
            attempts: (current.attempts || 0) + 1 };
        if (result.extraction_complete && Number.isSafeInteger(result.processed?.to_user_turn) && result.processed.to_user_turn >= 0) {
            next.reflected_at_turns = Math.max(current.reflected_at_turns, result.processed.to_user_turn);
            next.processed = result.processed;
        }
        if (result.extraction_complete && result.ok !== false) { next.last_success_at = now(); next.attempts = 0; }
        if (next.retryable) next.retry_after = new Date(new Date(now()).getTime() + 60_000).toISOString();
        const reconciled = reconcileJob(stateDirectory, key, next);
        retain(key, reconciled); save();
        if (reconciled.extraction_complete && result.status === 'unknown') {
            return { ...result, ok: reconciled.status === 'completed', status: reconciled.status,
                stage: reconciled.stage, extraction_complete: true, summary_status: reconciled.summary_status,
                job_id: reconciled.job_id, processed: reconciled.processed,
                error: reconciled.last_error, code: reconciled.last_code, retryable: false };
        }
        return result;
    }
    async function contextFor(key, progress, current, retry, manual = false) {
        const context = await loadContext(key);
        if (!context || String(context.world_id || '') !== key || context.session_id !== progress.session_id || context.revision !== progress.revision || userTurnCount(context.story) !== progress.user_turns) return null;
        const prepared = { ...context, after_user_turns: current.reflected_at_turns, retry: retry === true };
        const pendingOutput = current.resume_available || (current.extraction_complete && current.summary_status && current.summary_status !== 'current');
        if (manual && !pendingOutput && current.status === 'completed' && current.reflected_at_turns >= progress.user_turns) {
            if (current.processed?.revision === progress.revision && /^reflect_[a-f0-9]{32}$/.test(current.job_id)) {
                return { ...prepared, resume_job_id: current.job_id };
            }
            // An explicit review of edited history uses the bounded recent window;
            // automatic checks and uncovered newly appended turns keep their cursor.
            prepared.after_user_turns = 0;
        }
        const sameSource = current.job_id === reflectionJobId(prepared);
        // Persisted extracted text is reused even after new chat messages arrive.
        // An unknown extraction may only reuse its ID for the exact old source;
        // an explicitly approved retry against changed source gets a new ID.
        prepared.resume_job_id = pendingOutput || (retry && sameSource && current.status === 'unknown') ? current.job_id : '';
        return prepared;
    }
    async function executeReflection(key, current, context, automatic) {
        current = { ...current, job_id: context.resume_job_id || reflectionJobId(context) };
        retain(key, { ...current, status: 'queued', last_attempt_at: now() }); save();
        return serialized('reflect', key, async () => {
            retain(key, { ...current, status: 'running', last_attempt_at: now() }); save();
            try { return applyResult(key, current, await runReflection(context, { automatic })); }
            catch (cause) { return applyResult(key, current, cause.result || { ok: false, status: /^NORA_MODEL_/.test(cause.code || '') ? 'failed' : 'unknown', extraction_complete: false, code: cause.code || 'REFLECTION_OUTCOME_UNKNOWN', error: String(cause.message || cause), retryable: false }); }
        }, automatic).then(result => {
            if (result?.status === 'disabled') { retain(key, { ...current, status: 'disabled' }); save(); }
            return result;
        });
    }
    async function evaluate(worldId) {
        const key = String(worldId || '').trim();
        if (!key) throw new TypeError('World ID is required.');
        if (!loadSettings().auto_enabled) return { scheduled: false, reason: 'auto_disabled', ...status(key) };
        if (state.operation?.status === 'unknown' && state.operation.kind === 'reflect' && state.operation.world_id) {
            const previousKey = state.operation.world_id;
            const known = reconcileJob(stateDirectory, previousKey, normalizedStatus(state.worlds[previousKey]));
            if (known.status === 'completed' || known.extraction_complete || known.resume_available) {
                retain(previousKey, known);
                state.operation = { ...state.operation, status: known.status, stage: known.stage, code: known.last_code };
                save();
            }
        }
        if (state.operation?.status === 'unknown') return { scheduled: false, reason: 'previous_outcome_unknown', ...status(key) };
        if (jobs.has(key)) return { scheduled: false, reason: 'already_running', ...status(key) };
        const progress = await loadProgress(key);
        if (!progress || String(progress.world_id || '') !== key) throw failure('WORLD_NOT_FOUND', '找不到指定世界。');
        if (!Number.isSafeInteger(progress.user_turns) || progress.user_turns < 0) throw new TypeError('Invalid reflection turn count.');
        const current = currentFor(key, progress);
        retain(key, current);
        if (['partial', 'unknown'].includes(current.status) || (current.last_error && (!current.retryable || current.attempts >= 2))) return { scheduled: false, reason: 'manual_retry_required', ...status(key) };
        if (current.retry_after && new Date(current.retry_after).getTime() > new Date(now()).getTime()) return { scheduled: false, reason: 'retry_backoff', ...status(key) };
        if (progress.user_turns < minimum || progress.user_turns - current.reflected_at_turns < interval) return { scheduled: false, reason: 'not_due', user_turns: progress.user_turns, ...status(key) };
        const context = await contextFor(key, progress, current, false);
        if (!context) return { scheduled: false, reason: 'history_changed', user_turns: progress.user_turns, ...status(key) };
        const job = executeReflection(key, current, context, true);
        jobs.set(key, job);
        job.finally(() => { if (jobs.get(key) === job) jobs.delete(key); }).catch(() => {});
        return { scheduled: true, reason: 'checkpoint_due', user_turns: progress.user_turns, ...status(key) };
    }
    function checkpoint(worldId) {
        const key = String(worldId || '').trim(), previous = checks.get(key) || Promise.resolve();
        const check = previous.catch(() => {}).then(() => evaluate(key)); checks.set(key, check);
        return check.finally(() => { if (checks.get(key) === check) checks.delete(key); });
    }
    async function reflect(worldId, { retry = false } = {}) {
        const key = String(worldId || '').trim();
        if (!key) throw new TypeError('World ID is required.');
        // Admission reads share the automatic-check chain; do not await model I/O
        // while holding admission, otherwise a second submit cannot join the job.
        const previous = checks.get(key) || Promise.resolve();
        const admission = previous.catch(() => {}).then(async () => {
            if (jobs.has(key)) return { job: jobs.get(key) };
            const progress = await loadProgress(key);
            if (!progress || String(progress.world_id || '') !== key) throw failure('WORLD_NOT_FOUND', '找不到指定世界。');
            const current = currentFor(key, progress), context = await contextFor(key, progress, current, retry, true);
            if (!context) throw failure('STORY_PROFILE_HISTORY_CHANGED', '故事在准备期间发生变化，请重新检查。');
            const job = executeReflection(key, current, context, false); jobs.set(key, job);
            job.finally(() => { if (jobs.get(key) === job) jobs.delete(key); }).catch(() => {});
            return { job };
        });
        checks.set(key, admission);
        try { const { job } = await admission; return await job; }
        finally { if (checks.get(key) === admission) checks.delete(key); }
    }
    function summaryRecovered() {
        for (const [key, recorded] of Object.entries(state.worlds)) {
            const current = reconcileJob(stateDirectory, key, normalizedStatus(recorded));
            if (current.status === 'partial' && current.extraction_complete === true && current.stage === 'summary' && ['pending', 'failed', 'stale'].includes(current.summary_status)) {
                retain(key, { ...current, status: 'completed', stage: 'complete', summary_status: 'current', summary_recovered_job_id: current.job_id, last_error: '', last_code: '', last_success_at: now() });
            }
        }
        save();
    }
    async function runAction(kind, runner) { return serialized(kind, '', runner); }
    async function waitForIdle(worldId) { const job = jobs.get(String(worldId || '').trim()); if (job) await job; return status(worldId); }
    return Object.freeze({ checkpoint, reflect, runAction, status, statuses, summaryRecovered, waitForIdle });
}
