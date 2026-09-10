#!/usr/bin/env node

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const MARKER = '[NORA_RUNTIME_PHASE]';

function percentile(values, ratio) {
    if (!values.length) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor((sorted.length - 1) * ratio)];
}

function distribution(values) {
    const valid = values.filter(Number.isFinite);
    if (!valid.length) return null;
    return {
        samples: valid.length,
        min: percentile(valid, 0),
        p50: percentile(valid, 0.5),
        p95: percentile(valid, 0.95),
        max: percentile(valid, 1),
    };
}

export function parseRuntimePhases(logText) {
    const events = [];
    for (const line of String(logText || '').split('\n')) {
        const markerAt = line.indexOf(MARKER);
        if (markerAt < 0) continue;
        try {
            const event = JSON.parse(line.slice(markerAt + MARKER.length).trim());
            if (event?.runId && event?.phase && Number.isFinite(event?.durationMs)) events.push(event);
        } catch {
            // Partial log lines are ignored while a runtime is still writing.
        }
    }
    return events;
}

export function summarizeRuntimePhases(events) {
    const runs = new Map();
    for (const event of events) {
        if (!runs.has(event.runId)) runs.set(event.runId, { mode: event.mode || 'unknown', events: [] });
        runs.get(event.runId).events.push(event);
    }
    const phases = new Map();
    for (const [runId, run] of runs) {
        for (const event of run.events) {
            const key = `${run.mode}\u0000${event.phase}`;
            if (!phases.has(key)) phases.set(key, []);
            phases.get(key).push({ runId, ...event });
        }
    }
    return {
        runs: runs.size,
        modes: [...new Set([...runs.values()].map(run => run.mode))].sort(),
        phases: [...phases.entries()].map(([key, values]) => {
            const [mode, phase] = key.split('\u0000');
            const statuses = values.reduce((result, event) => {
                const status = event.status || 'unknown';
                result[status] = (result[status] || 0) + 1;
                return result;
            }, {});
            return { mode, phase, ...distribution(values.map(event => event.durationMs)), statuses };
        }).sort((left, right) => left.mode.localeCompare(right.mode) || left.phase.localeCompare(right.phase)),
    };
}

export function formatRuntimePhaseSummary(summary) {
    const lines = [`Nora runtime runs: ${summary.runs}`, `Modes: ${summary.modes.join(', ') || 'none'}`];
    for (const phase of summary.phases) {
        lines.push(`${phase.mode} ${phase.phase}: n=${phase.samples} min=${phase.min.toFixed(1)}ms p50=${phase.p50.toFixed(1)}ms p95=${phase.p95.toFixed(1)}ms max=${phase.max.toFixed(1)}ms status=${JSON.stringify(phase.statuses)}`);
    }
    return lines.join('\n');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    const logPath = process.argv.slice(2).find(argument => !argument.startsWith('-'));
    if (!logPath) {
        console.error('Usage: node ops/scripts/analyze-runtime-phases.mjs <runtime.log> [--json]');
        process.exitCode = 1;
    } else {
        const summary = summarizeRuntimePhases(parseRuntimePhases(fs.readFileSync(logPath, 'utf8')));
        console.log(process.argv.includes('--json') ? JSON.stringify(summary, null, 2) : formatRuntimePhaseSummary(summary));
    }
}
