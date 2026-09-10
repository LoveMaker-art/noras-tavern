import fs from 'node:fs';
import path from 'node:path';

function safePath(value) {
    return typeof value === 'string' && value.length > 0 && !value.startsWith('/')
        && !/[\\:\0]/.test(value) && value.replace(/\/$/, '').split('/').every(part => part && part !== '..' && part !== '.');
}

export function readLayout(root) {
    const file = path.join(root, 'tooling/source-layout.json');
    if (!fs.existsSync(file)) return [];
    const layout = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (layout.schema !== 1 || !Array.isArray(layout.rules)) throw new Error('Unsupported source layout');
    for (const rule of layout.rules) {
        if (!Array.isArray(rule) || rule.length !== 2 || !rule.every(safePath)
            || rule[0].endsWith('/') !== rule[1].endsWith('/')) throw new Error('Invalid source layout rule');
    }
    return layout.rules;
}

export function translatePath(relative, rules, reverse = false) {
    if (!safePath(relative)) throw new Error(`Unsafe source path: ${relative}`);
    const pairs = rules.map(rule => reverse ? [rule[1], rule[0]] : rule);
    // Exact ownership takes precedence over directory defaults in either direction.
    const match = pairs.find(([from]) => relative === from)
        || pairs.filter(([from]) => from.endsWith('/') && relative.startsWith(from))
            .sort((a, b) => b[0].length - a[0].length)[0];
    return match ? match[1] + relative.slice(match[0].length) : relative;
}

export function deliveryEntries(files, rules) {
    const targets = new Set();
    return files.map(source => {
        const target = translatePath(source, rules);
        if (rules.length && source.startsWith('ops/')) throw new Error(`Legacy authored source is forbidden: ${source}`);
        if (rules.length && source === target && /^(?:nora|launcher|deployment)\//.test(source)
            && !source.endsWith('/README.md')) throw new Error(`Missing delivery mapping: ${source}`);
        const portableTarget = target.normalize('NFC').toLowerCase();
        if (targets.has(portableTarget)) throw new Error(`Duplicate delivery path: ${target}`);
        targets.add(portableTarget);
        return [source, target];
    });
}

// Only operate on an isolated export, never on an installation or the checkout.
export function projectDelivery(stage, files) {
    const entries = deliveryEntries(files, readLayout(stage));
    const sources = new Set(files);
    for (const [source, target] of entries) {
        if (source !== target && sources.has(target)) throw new Error(`Source/delivery collision: ${target}`);
    }
    for (const [source, target] of entries) {
        if (source === target) continue;
        fs.mkdirSync(path.dirname(path.join(stage, target)), { recursive: true });
        fs.renameSync(path.join(stage, source), path.join(stage, target));
    }
    return entries.map(([, target]) => target).sort();
}
