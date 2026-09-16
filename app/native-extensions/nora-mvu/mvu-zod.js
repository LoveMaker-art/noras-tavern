const READ_ONLY_PREFIX = '_';

function traceSchema(stage, detail = {}) {
    try { globalThis.parent?.NoraMvu?.trace?.record(stage, { scriptId: globalThis.getScriptId?.(), ...detail }); } catch { /* Diagnostics only. */ }
}
traceSchema('schema-module-loaded');

function runtime(name) {
    const value = globalThis[name];
    if (value === undefined || value === null) {
        throw new Error(`Nora MVU schema runtime requires Tavern Helper global: ${name}`);
    }
    return value;
}

function clone(value) {
    if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function trimQuotes(value) {
    return String(value ?? '').replace(/^[\\"'` ]*(.*?)[\\"'` ]*$/, '$1');
}

function parsePath(value) {
    return trimQuotes(value).replace(/^(?:stat_data|status_current_variables)\./, '');
}

function parseValue(value) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed === 'null') return null;
    if (trimmed === 'undefined') return undefined;
    try {
        return JSON.parse(trimmed);
    } catch {
        try {
            return globalThis.YAML?.parse(trimmed) ?? trimQuotes(value);
        } catch {
            return trimQuotes(value);
        }
    }
}

function normalizedValue(value) {
    const parsed = parseValue(value);
    if (parsed instanceof Date) return parsed.toISOString();
    if (Array.isArray(parsed)) return parsed.map(item => item instanceof Date ? item.toISOString() : item);
    return parsed;
}

function schemaError(zod, error) {
    if (typeof zod.prettifyError === 'function') return zod.prettifyError(error);
    return String(error?.message || error || 'Unknown schema error');
}

function report(level, content, title) {
    const message = String(content || 'Unknown error');
    const toast = globalThis.toastr;
    toast?.[level === 'warn' ? 'warning' : 'error']?.(
        message.replaceAll('\n', '<br>'),
        `[MVU zod]${title}`,
        { escapeHtml: false },
    );
    console[level](`${title}\n${message}`);
}

function notificationEnabled() {
    try {
        return Boolean(globalThis.$?.('#mvu_notification_error')?.prop?.('checked'));
    } catch {
        return false;
    }
}

function writablePath(lodash, value) {
    const path = lodash.toPath(value);
    return !path.some(part => String(part).startsWith(READ_ONLY_PREFIX));
}

function applyCommand(data, command, validate, lodash, notify) {
    const args = [...(command?.args || [])];
    switch (command?.type) {
        case 'set': {
            if (args.length === 3) args.splice(1, 1);
            const path = parsePath(args[0]);
            if (!writablePath(lodash, path)) return null;
            if (path) lodash.set(data, path, normalizedValue(args[1]));
            else data = normalizedValue(args[1]);
            return validate(data, command, true);
        }
        case 'add': {
            const path = parsePath(args[0]);
            if (!path || !writablePath(lodash, path)) return null;
            const previous = lodash.get(data, path);
            if (typeof previous !== 'number') {
                if (notify) report('warn', `Cannot add to non-numeric path: ${path}`, `变量更新失败: ${command.full_match || ''}`);
                return null;
            }
            lodash.set(data, path, previous + Number(normalizedValue(args[1])));
            return validate(data, command, true);
        }
        case 'insert': {
            const path = parsePath(args[0]);
            if (!writablePath(lodash, path)) return null;
            const key = normalizedValue(args[1]);
            const value = normalizedValue(args.at(-1));
            let collection = path ? lodash.get(data, path) : data;
            if (collection === undefined || collection === null) {
                collection = args.length === 2 ? [] : {};
                if (path) lodash.set(data, path, collection);
                else data = collection;
            }
            if (Array.isArray(collection)) {
                if (args.length === 2) collection.push(value);
                else collection.splice(key === '-' ? collection.length : Number(key), 0, value);
            } else if (lodash.isPlainObject(collection)) {
                if (args.length === 2 && lodash.isPlainObject(value)) Object.assign(collection, value);
                else collection[String(key)] = value;
            } else {
                return null;
            }
            return validate(data, command, true);
        }
        case 'delete': {
            const path = args.map(parsePath).join('.');
            if (!writablePath(lodash, path)) return null;
            const parts = lodash.toPath(path);
            const parent = lodash.get(data, parts.slice(0, -1));
            if (Array.isArray(parent)) parent.splice(Number(parts.at(-1)), 1);
            else lodash.unset(data, parts);
            return validate(data, command, true);
        }
        default:
            return null;
    }
}

function looseSchema(zod, schema) {
    if (!schema?.shape) return schema;
    if (typeof zod.looseObject === 'function') return zod.looseObject(schema.shape);
    if (typeof schema.passthrough === 'function') return schema.passthrough();
    return schema;
}

export function registerMvuSchema(input) {
    traceSchema('schema-register-start', { globals: ['z', '_', 'eventOn', 'registerVariableSchema'].map(name => ({ name, present: globalThis[name] != null })) });
    const zod = runtime('z');
    const lodash = runtime('_');
    const eventOn = runtime('eventOn');
    const registerVariableSchema = globalThis.registerVariableSchema;
    const unwrapSchema = () => {
        const original = typeof input === 'function' ? input() : input;
        const schema = looseSchema(zod, original);
        if (typeof registerVariableSchema === 'function') {
            registerVariableSchema(zod.object({ stat_data: schema }), { type: 'message' });
        }
        return schema;
    };

    unwrapSchema();

    // Pull-based evidence follows the script listener lifecycle; no persistent registry.
    eventOn('nora_mvu_schema_query', (query) => {
        traceSchema('schema-query-received');
        const schema = unwrapSchema();
        let fields = null;
        try {
            if (typeof zod.toJSONSchema === 'function') {
                fields = zod.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
                if (JSON.stringify(fields).length > 12000) fields = null;
            }
        } catch { /* Arbitrary transforms remain runtime-only checks. */ }
        query.schemas.push({ fields });
        traceSchema('schema-query-answered', { count: query.schemas.length, fieldsAvailable: fields !== null });
    });

    eventOn('mag_variable_initialized', (variables, swipeId) => {
        try {
            const parsed = unwrapSchema().safeParse(lodash.get(variables, 'stat_data', {}), { reportInput: true });
            if (!parsed.success) {
                report('error', schemaError(zod, parsed.error), `第 ${Number(swipeId) + 1} 条开场白的变量初始化失败`);
                return;
            }
            variables.stat_data = { ...variables.stat_data, ...parsed.data };
        } catch (error) {
            report('error', error?.stack || error?.message || error, `第 ${Number(swipeId) + 1} 条开场白的变量初始化失败`);
        }
    });

    eventOn('mag_command_parsed_for_zod', (variables, commands, _content, diagnostics) => {
        const schema = unwrapSchema();
        const notify = notificationEnabled();
        let rejectionReason = '';
        const validate = (data, command, shouldNotify) => {
            try {
                const parsed = schema.safeParse(data, { reportInput: true });
                if (parsed.success) return parsed.data;
                rejectionReason = schemaError(zod, parsed.error);
                if (notify && shouldNotify) report('warn', schemaError(zod, parsed.error), `变量更新失败: ${command.full_match || ''}`);
            } catch (error) {
                rejectionReason = String(error?.message || error);
                if (notify && shouldNotify) report('warn', error?.stack || error?.message || error, `变量更新失败: ${command.full_match || ''}`);
            }
            return null;
        };
        const consumed = [];

        commands.forEach((command, index) => {
            rejectionReason = '';
            const reject = () => diagnostics?.errors?.push({
                command: command.type,
                content: (rejectionReason || 'Command rejected: unsupported operation, invalid path or incompatible value.').slice(0, 800),
            });
            let next = clone(variables.stat_data);
            if (command.nora) {
                try { globalThis.parent.NoraMvu.protocol.validateNoraOperation(command.nora, next); }
                catch (error) { rejectionReason = String(error); reject(); return; }
            }
            const removed = [];
            if (command.type === 'move') {
                const from = parsePath(command.args?.[0]);
                const to = parsePath(command.args?.[1]);
                if (!lodash.has(next, from) || !writablePath(lodash, from) || !writablePath(lodash, to)) {
                    reject();
                    return;
                }
                const value = clone(lodash.get(next, from));
                next = applyCommand(next, { ...command, type: 'delete', args: [from] }, validate, lodash, notify);
                if (next !== null) next = applyCommand(next, { ...command, type: 'set', args: [to, value] }, validate, lodash, notify);
                removed.push(lodash.toPath(from));
            } else {
                next = applyCommand(next, command, validate, lodash, notify);
                if (command.type === 'delete') removed.push(lodash.toPath(command.args.map(parsePath).join('.')));
            }
            if (next === null) {
                reject();
                return;
            }
            removed.forEach(path => {
                if (!lodash.has(next, path)) lodash.unset(variables.stat_data, path);
            });
            variables.stat_data = { ...variables.stat_data, ...next };
            consumed.push(index);
            if (diagnostics) diagnostics.accepted_count = (diagnostics.accepted_count || 0) + 1;
        });

        lodash.pullAt(commands, consumed);
    });

    eventOn('mag_command_parsed_ended_for_zod', (_variables, commands) => {
        commands.length = 0;
    });

    eventOn('mag_variable_update_ended_for_zod', (variables) => {
        lodash.set(variables, 'schema', 'managed-by-nora');
        lodash.unset(variables, 'display_data');
        lodash.unset(variables, 'delta_data');
    });

    console.info('[Nora MVU] Variable schema registered locally.');
    traceSchema('schema-register-complete');
    // Announce only after all validation handlers are installed. Consumers still
    // query the live listener, so an unloaded card never leaves a cached schema.
    void globalThis.eventEmit?.('nora_mvu_schema_ready');
}
