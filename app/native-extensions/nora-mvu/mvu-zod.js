const READ_ONLY_PREFIX = '_';

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

function applyCommand(data, command, lodash, notify) {
    const args = [...(command?.args || [])];
    switch (command?.type) {
        case 'set': {
            if (args.length === 3) args.splice(1, 1);
            const path = parsePath(args[0]);
            if (!writablePath(lodash, path)) return null;
            if (command?.reason === 'nora-mvu/1' && path && !lodash.has(data, path)) return null;
            if (path) lodash.set(data, path, normalizedValue(args[1]));
            else data = normalizedValue(args[1]);
            return data;
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
            return data;
        }
        case 'insert': {
            const path = parsePath(args[0]);
            if (!writablePath(lodash, path)) return null;
            const key = normalizedValue(args[1]);
            const value = normalizedValue(args.at(-1));
            let collection = path ? lodash.get(data, path) : data;
            if (command?.reason === 'nora-mvu/1' && !Array.isArray(collection)) return null;
            if (collection === undefined || collection === null) {
                collection = args.length === 2 ? [] : {};
                if (path) lodash.set(data, path, collection);
                else data = collection;
            }
            if (Array.isArray(collection)) {
                if (args.length === 2) collection.push(value);
                else {
                    const index = key === '-' ? collection.length : Number(key);
                    if (command?.reason === 'nora-mvu/1' && index > collection.length) return null;
                    collection.splice(index, 0, value);
                }
            } else if (lodash.isPlainObject(collection)) {
                if (args.length === 2 && lodash.isPlainObject(value)) Object.assign(collection, value);
                else collection[String(key)] = value;
            } else {
                return null;
            }
            return data;
        }
        case 'delete': {
            const path = args.map(parsePath).join('.');
            if (!writablePath(lodash, path) || (command?.reason === 'nora-mvu/1' && !lodash.has(data, path))) return null;
            const parts = lodash.toPath(path);
            const parent = lodash.get(data, parts.slice(0, -1));
            if (Array.isArray(parent)) parent.splice(Number(parts.at(-1)), 1);
            else lodash.unset(data, parts);
            return data;
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

    eventOn('mag_command_parsed_for_zod', (variables, commands) => {
        const schema = unwrapSchema();
        const notify = notificationEnabled();
        let candidate = clone(variables.stat_data);
        let valid = true;
        let failedCommand = null;

        for (const command of commands) {
            let next = candidate;
            if (command.type === 'move') {
                const from = parsePath(command.args?.[0]);
                const to = parsePath(command.args?.[1]);
                if (!lodash.has(next, from) || !writablePath(lodash, from) || !writablePath(lodash, to)) {
                    valid = false;
                    failedCommand = command;
                    break;
                }
                const value = clone(lodash.get(next, from));
                next = applyCommand(next, { ...command, type: 'delete', args: [from] }, lodash, notify);
                if (next !== null) lodash.set(next, to, value);
            } else {
                next = applyCommand(next, command, lodash, notify);
            }
            if (next === null) {
                valid = false;
                failedCommand = command;
                break;
            }
            candidate = next;
        }

        // Zod owns these commands, so the upstream executor must never run a
        // rejected remainder. Commit the whole candidate or preserve the whole
        // previous snapshot.
        commands.length = 0;
        if (!valid) {
            if (notify) {
                report(
                    'warn',
                    'The command cannot be applied to the current variable state.',
                    `变量更新失败: ${failedCommand?.full_match || ''}`,
                );
            }
            return;
        }

        try {
            const parsed = schema.safeParse(candidate, { reportInput: true });
            if (parsed.success) {
                variables.stat_data = parsed.data;
            } else if (notify) {
                report('warn', schemaError(zod, parsed.error), '整批变量更新校验失败');
            }
        } catch (error) {
            if (notify) report('warn', error?.stack || error?.message || error, '整批变量更新校验失败');
        }
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
}
