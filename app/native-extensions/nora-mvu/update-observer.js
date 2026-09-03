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
        on(transactionCommittedEvent, (detail = {}) => {
            transactionActive = false;
            const committedCommandCount = detail.diagnostics?.command_count ?? commandCount;
            const stateChanged = detail.diagnostics?.modified ?? committedCommandCount > 0;
            current = {
                ...current,
                updateOperational: true,
                updatePhase: stateChanged ? 'completed' : 'no-change',
                lastUpdateAt: now(),
                lastUpdateCode: stateChanged ? null : 'MVU_NO_STATE_CHANGE',
                lastUpdateStage: stateChanged ? null : 'update',
                lastUpdateError: null,
                lastUpdateCommandCount: committedCommandCount,
                stateChanged,
                transactionDurationMs: detail.duration_ms ?? null,
                transactionAttempt: detail.attempt ?? null,
            };
        });
        on(transactionFailedEvent, (detail = {}) => {
            transactionActive = false;
            const errors = validationErrors(detail.diagnostics?.errors);
            current = {
                ...current,
                updateOperational: false,
                updatePhase: 'failed',
                lastUpdateAt: now(),
                lastUpdateCode: bounded(detail.error_code || 'MVU_UPDATE_FAILED', 100),
                lastUpdateStage: bounded(detail.stage || 'update', 80),
                lastUpdateError: bounded(detail.error || 'MVU update failed.', 800),
                lastUpdateCommandCount: detail.diagnostics?.command_count ?? commandCount,
                lastUpdateValidationErrors: errors,
                stateChanged: false,
                transactionDurationMs: detail.duration_ms ?? null,
                transactionAttempt: detail.attempt ?? null,
            };
            publishFailure();
        });
    }

    on(startedEvent, () => {
        observedIdentity = String(identity() || '');
        commandCount = 0;
        if (transactionActive) return;
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
        const hasCommands = commandCount > 0;
        const stateChanged = digest(variables?.stat_data) !== digest(before?.stat_data);
        const updateOperational = hasCommands && stateChanged;
        if (transactionActive) return;
        current = {
            ...emptyStatus(),
            updateOperational,
            updatePhase: updateOperational ? 'completed' : hasCommands ? 'no-change' : 'no-command',
            lastUpdateAt: now(),
            lastUpdateCode: updateOperational ? null : hasCommands ? 'MVU_NO_STATE_CHANGE' : 'MVU_NO_UPDATE_COMMAND',
            lastUpdateStage: updateOperational ? null : hasCommands ? 'validation' : 'parsing',
            lastUpdateError: updateOperational ? null : hasCommands ? 'NO_STATE_CHANGE' : 'NO_UPDATE_COMMAND',
            lastUpdateCommandCount: commandCount,
            stateChanged,
        };
        if (!updateOperational) publishFailure();
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
