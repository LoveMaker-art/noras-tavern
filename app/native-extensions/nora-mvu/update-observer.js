function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function digest(value) {
    return JSON.stringify(stableValue(value));
}

function emptyStatus() {
    return {
        updateOperational: null,
        updatePhase: 'unobserved',
        lastUpdateAt: null,
        lastUpdateError: null,
        lastUpdateCommandCount: null,
        stateChanged: null,
    };
}

export function createMvuUpdateObserver({ eventSource, events, identity = () => '', now = () => Date.now() } = {}) {
    if (typeof eventSource?.on !== 'function') throw new TypeError('MVU update observer requires an event source.');
    const startedEvent = events?.VARIABLE_UPDATE_STARTED;
    const commandEvent = events?.COMMAND_PARSED;
    const endedEvent = events?.VARIABLE_UPDATE_ENDED;
    if (!startedEvent || !commandEvent || !endedEvent) throw new TypeError('MVU update observer requires the upstream event contract.');

    let current = emptyStatus();
    let observedIdentity = '';
    let commandCount = 0;
    const bindings = [];
    const on = (event, handler) => {
        eventSource.on(event, handler);
        bindings.push([event, handler]);
    };

    on(startedEvent, () => {
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
        const hasCommands = commandCount > 0;
        const stateChanged = digest(variables?.stat_data) !== digest(before?.stat_data);
        const updateOperational = hasCommands && stateChanged;
        current = {
            updateOperational,
            updatePhase: updateOperational ? 'completed' : hasCommands ? 'no-change' : 'no-command',
            lastUpdateAt: now(),
            lastUpdateError: updateOperational ? null : hasCommands ? 'NO_STATE_CHANGE' : 'NO_UPDATE_COMMAND',
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
