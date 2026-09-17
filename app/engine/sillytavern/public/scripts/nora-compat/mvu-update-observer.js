function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function digest(value) {
    return JSON.stringify(stableValue(value));
}

const bounded = (value, length) => String(value ?? '').slice(0, length);

function validationErrors(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 12).map(item => ({
        commandType: bounded(item?.command || item?.commandType || 'unknown', 80),
        reason: bounded(item?.content || item?.reason || 'validation failed', 400),
    }));
}

/** One terminal-event projection for both UI feedback and bounded diagnostics. */
export function projectMvuTransaction(detail = {}, terminal = 'committed', fallbackCommandCount) {
    const count = detail.diagnostics?.command_count ?? fallbackCommandCount;
    // Legacy events may lack `modified`; only the observer has a captured command count.
    const changed = detail.diagnostics?.modified ?? (fallbackCommandCount === undefined || count > 0);
    const committed = terminal === 'committed';
    const skipped = committed && detail.outcome === 'skipped';
    const interrupted = !committed && ['cancelled', 'stale'].includes(detail.outcome);
    return {
        status: committed ? (skipped ? 'skipped' : changed ? 'committed' : 'no-change') : interrupted ? detail.outcome : 'failed',
        updateOperational: skipped || interrupted ? null : committed,
        updatePhase: committed ? (skipped ? 'no-command' : changed ? 'completed' : 'no-change') : interrupted || detail.outcome === 'partial' ? detail.outcome : 'failed',
        lastUpdateCode: committed ? (skipped ? 'MVU_NO_UPDATE_COMMAND' : changed ? null : 'MVU_NO_STATE_CHANGE') : bounded(detail.error_code || 'MVU_UPDATE_FAILED', 100),
        lastUpdateStage: committed ? (changed ? null : 'update') : bounded(detail.stage || 'update', 80),
        lastUpdateError: committed ? null : bounded(detail.error || 'MVU update failed.', 800),
        lastUpdateCommandCount: count,
        ...(!committed ? { lastUpdateValidationErrors: validationErrors(detail.diagnostics?.errors) } : {}),
        stateChanged: committed ? changed : detail.outcome === 'persistence-unknown' ? null : detail.persisted ? Boolean(detail.diagnostics?.modified) : false,
        transactionDurationMs: detail.duration_ms ?? null,
        transactionAttempt: detail.attempt ?? null,
        ...(detail.protocol ? { updateProtocol: bounded(detail.protocol, 40) } : {}),
        ...(detail.mode ? { updateMode: bounded(detail.mode, 40) } : {}),
        ...(detail.fallback_reason ? { fallbackReason: bounded(detail.fallback_reason, 200) } : {}),
    };
}

function emptyStatus() {
    return {
        updateOperational: null,
        updatePhase: 'unobserved',
        lastUpdateAt: null,
        lastUpdateCode: null,
        lastUpdateStage: null,
        lastUpdateError: null,
        lastUpdateCommandCount: null,
        lastUpdateValidationErrors: [],
        stateChanged: null,
        transactionDurationMs: null,
        transactionAttempt: null,
        hasPreviousSnapshot: false,
    };
}

export function createMvuUpdateObserver({ eventSource, events, identity = () => '', now = () => Date.now(), report = () => {} } = {}) {
    if (typeof eventSource?.on !== 'function') throw new TypeError('MVU update observer requires an event source.');
    const startedEvent = events?.VARIABLE_UPDATE_STARTED;
    const commandEvent = events?.COMMAND_PARSED;
    const endedEvent = events?.VARIABLE_UPDATE_ENDED;
    if (!startedEvent || !commandEvent || !endedEvent) throw new TypeError('MVU update observer requires the upstream event contract.');

    let current = emptyStatus();
    let observedIdentity = '';
    let commandCount = 0;
    let transactionActive = false;
    const bindings = [];
    const on = (event, handler) => {
        eventSource.on(event, handler);
        bindings.push([event, handler]);
    };
    const publishFailure = () => {
        const diagnostic = Object.freeze({
            kind: 'mvu-update-failed',
            identity: observedIdentity,
            occurredAt: current.lastUpdateAt,
            code: current.lastUpdateCode,
            stage: current.lastUpdateStage,
            summary: current.lastUpdateError,
            commandCount: current.lastUpdateCommandCount,
            validationErrors: current.lastUpdateValidationErrors,
            attempt: current.transactionAttempt,
            durationMs: current.transactionDurationMs,
            protocol: current.updateProtocol,
            mode: current.updateMode,
            fallbackReason: current.fallbackReason,
        });
        try {
            void Promise.resolve(report(diagnostic)).catch(error => {
                console.warn('[Nora MVU] Failed to report update diagnostics', error);
            });
        } catch (error) {
            console.warn('[Nora MVU] Failed to report update diagnostics', error);
        }
    };

    const transactionStartedEvent = events?.TRANSACTION_STARTED;
    const transactionCommittedEvent = events?.TRANSACTION_COMMITTED;
    const transactionFailedEvent = events?.TRANSACTION_FAILED;

    if (transactionStartedEvent && transactionCommittedEvent && transactionFailedEvent) {
        on(transactionStartedEvent, (detail = {}) => {
            observedIdentity = String(identity() || '');
            transactionActive = true;
            commandCount = 0;
            current = {
                ...emptyStatus(),
                updatePhase: 'updating',
                lastUpdateAt: now(),
                hasPreviousSnapshot: Boolean(detail.had_snapshot),
            };
        });
        for (const [event, terminal] of [[transactionCommittedEvent, 'committed'], [transactionFailedEvent, 'failed']]) {
            on(event, (detail = {}) => {
                transactionActive = false;
                if (observedIdentity !== String(identity() || '')) return;
                const { status, ...observation } = projectMvuTransaction(detail, terminal, commandCount);
                current = { ...current, ...observation, lastUpdateAt: now() };
                if (status === 'failed') publishFailure();
            });
        }
    }

    on(startedEvent, () => {
        if (transactionActive) return;
        observedIdentity = String(identity() || '');
        commandCount = 0;
        current = {
            ...emptyStatus(),
            updatePhase: 'updating',
            lastUpdateAt: now(),
        };
    });
    on(commandEvent, (_variables, commands) => {
        commandCount = Array.isArray(commands) ? commands.length : 0;
    });
    on(endedEvent, (variables, before) => {
        if (transactionActive) return;
        const hasCommands = commandCount > 0;
        const stateChanged = digest(variables?.stat_data) !== digest(before?.stat_data);
        current = {
            ...emptyStatus(),
            // Upstream ENDED precedes final hooks and persistence. It is an
            // observation only, never proof of success or failure.
            updateOperational: null,
            updatePhase: hasCommands ? 'unverified' : 'no-command',
            lastUpdateAt: now(),
            lastUpdateCode: hasCommands ? 'MVU_EXECUTION_UNVERIFIED' : 'MVU_NO_UPDATE_COMMAND',
            lastUpdateStage: hasCommands ? 'update' : 'parsing',
            lastUpdateError: null,
            lastUpdateCommandCount: commandCount,
            stateChanged,
        };
    });

    return Object.freeze({
        status() {
            return observedIdentity && observedIdentity === String(identity() || '')
                ? { ...current }
                : emptyStatus();
        },
        dispose() {
            bindings.forEach(([event, handler]) => eventSource.off?.(event, handler));
        },
    });
}
