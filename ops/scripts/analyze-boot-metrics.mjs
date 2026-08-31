#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const MARKER = '[NORA_BOOT_METRICS]';

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
        p90: percentile(valid, 0.9),
        max: percentile(valid, 1),
    };
}

function latestMilestone(metrics, name) {
    return (metrics.milestones || []).filter(item => item.name === name).at(-1);
}

function initialWorldReadyAt(metrics) {
    const milestone = (metrics.milestones || [])
        .find(item => item.name === 'world-selected' && item.interactionId === 'initial-world');
    if (Number.isFinite(milestone?.at)) return milestone.at;
    const completedSteps = (metrics.steps || [])
        .filter(step => step.name.startsWith('nora.world-select.initial-world.') && Number.isFinite(step.endedAt));
    return completedSteps.length ? Math.max(...completedSteps.map(step => step.endedAt)) : undefined;
}

function navigationOffset(metrics) {
    return Number.isFinite(Number(metrics?.startedAt)) ? Number(metrics.startedAt) : 0;
}

function userPerceivedAt(metrics, value) {
    return Number.isFinite(Number(value)) ? navigationOffset(metrics) + Number(value) : undefined;
}

export function parseBootMetrics(logText) {
    const events = [];
    for (const line of String(logText || '').split('\n')) {
        const markerAt = line.indexOf(MARKER);
        try {
            const event = JSON.parse(markerAt >= 0 ? line.slice(markerAt + MARKER.length).trim() : line.trim());
            if (event?.kind === 'server-span' && event.traceId) events.push(event);
            else if (event?.metrics?.sessionId) events.push(event);
        } catch {
            // A partial final log line is expected when the process is still writing.
        }
    }
    return events;
}

function sum(values) {
    return values.filter(Number.isFinite).reduce((total, value) => total + value, 0);
}

function max(values) {
    const valid = values.filter(Number.isFinite);
    return valid.length ? Math.max(...valid) : 0;
}

export function diagnoseBootSession(event, serverSpans = []) {
    const metrics = event?.metrics || {};
    const resources = Array.isArray(metrics.resources) ? metrics.resources : [];
    const steps = Array.isArray(metrics.steps) ? metrics.steps : [];
    const longTasks = Array.isArray(metrics.longTasks) ? metrics.longTasks : [];
    const usableAtBootMs = Number(latestMilestone(metrics, 'nora-usable')?.at) || Number(metrics.capturedAt) || 0;
    const totalMs = navigationOffset(metrics) + usableAtBootMs;
    const isBackgroundStep = step => /(?:^|\.)background(?:\.|$)/i.test(String(step.name || ''));
    const blockingSteps = steps.filter(step => !isBackgroundStep(step)
        && Number.isFinite(Number(step.endedAt)) && Number(step.endedAt) <= usableAtBootMs);
    const backgroundSteps = steps.filter(step => isBackgroundStep(step)
        || (Number.isFinite(Number(step.startedAt)) && Number(step.startedAt) >= usableAtBootMs));
    const blockingResources = resources.filter(resource => {
        const end = Number(resource.responseEnd);
        return Number.isFinite(end) && end <= usableAtBootMs;
    });
    const blockingPaths = new Set(blockingResources.map(resource => String(resource.name || '')));
    const blockingServerSpans = serverSpans.filter(span => blockingPaths.has(String(span.path || '')));
    const backendMaxMs = max(blockingServerSpans.map(span => Number(span.durationMs)));
    const compatibilityMaxMs = max(blockingSteps
        .filter(step => /(?:mvu|regex|tavern.helper|capabilit|extension)/i.test(step.name || ''))
        .map(step => Number(step.duration)));
    const longTaskTotalMs = sum(longTasks.map(task => Number(task.duration)));
    const longTaskMaxMs = max(longTasks.map(task => Number(task.duration)));
    const transferMaxMs = max(blockingResources.map(resource => Number(resource.downloadDuration)).filter(value => value >= 0));
    const resourceMaxMs = max(blockingResources.map(resource => Number(resource.duration)));
    const decodedBytes = sum(blockingResources.map(resource => Number(resource.decodedBodySize)));
    const cacheHits = blockingResources.filter(resource => resource.source === 'cache').length;
    const networkLoads = blockingResources.filter(resource => resource.source === 'network').length;
    const measuredLoads = cacheHits + networkLoads;
    const signals = {
        totalMs,
        navigationToBootMs: navigationOffset(metrics),
        usableAtBootMs,
        backendMaxMs,
        compatibilityMaxMs,
        longTaskTotalMs,
        longTaskMaxMs,
        transferMaxMs,
        resourceMaxMs,
        decodedBytes,
        cacheHits,
        networkLoads,
        cacheHitRate: measuredLoads ? cacheHits / measuredLoads : null,
        blockingStepCount: blockingSteps.length,
        backgroundStepCount: backgroundSteps.length,
        backgroundMaxMs: max(backgroundSteps.map(step => Number(step.duration))),
    };

    let primaryCause = totalMs <= 5_000 ? 'within-budget' : 'unclassified-client';
    if (totalMs > 5_000 && backendMaxMs >= 1_500) primaryCause = 'backend';
    else if (totalMs > 5_000 && compatibilityMaxMs >= 1_500) primaryCause = 'compatibility-runtime';
    else if (totalMs > 5_000 && (longTaskTotalMs >= 1_500 || longTaskMaxMs >= 500)) primaryCause = 'main-thread';
    else if (totalMs > 5_000 && transferMaxMs >= 1_500 && decodedBytes >= 1_000_000) primaryCause = 'payload-transfer';
    else if (totalMs > 5_000 && resourceMaxMs >= 1_000 && networkLoads > cacheHits) primaryCause = 'cache-miss-network';
    return { traceId: event?.traceId || metrics.sessionId || '', primaryCause, signals };
}

export function summarizeBootMetrics(events) {
    const sessions = new Map();
    const serverSpans = new Map();
    for (const event of events) {
        if (event?.kind === 'server-span') {
            if (!serverSpans.has(event.traceId)) serverSpans.set(event.traceId, []);
            serverSpans.get(event.traceId).push(event);
            continue;
        }
        const sessionId = event?.metrics?.sessionId;
        if (!sessionId) continue;
        const current = sessions.get(sessionId);
        if (!current || Number(event.metrics.capturedAt) >= Number(current.metrics.capturedAt)) {
            sessions.set(sessionId, event);
        }
    }

    const snapshots = [...sessions.values()].map(event => event.metrics);
    const usableAtBoot = snapshots.map(metrics => latestMilestone(metrics, 'nora-usable')?.at);
    const usableAt = snapshots.map((metrics, index) => userPerceivedAt(metrics, usableAtBoot[index]));
    const usableSamples = usableAt.filter(Number.isFinite);
    const usableTargetMs = 5_000;
    const usablePassed = usableSamples.filter(value => value <= usableTargetMs).length;
    const usableFailed = usableSamples.length - usablePassed;
    const initialWorldCounts = snapshots.map(metrics => (metrics.milestones || [])
        .filter(item => item.name === 'world-selected' && item.interactionId === 'initial-world').length);
    const firstGeneration = snapshots.map(metrics => latestMilestone(metrics, 'first-generation-settled')).filter(Boolean);
    const stepDurations = new Map();
    const backgroundStepDurations = new Map();
    for (const metrics of snapshots) {
        const perSession = new Map();
        const perSessionBackground = new Map();
        const usable = Number(latestMilestone(metrics, 'nora-usable')?.at);
        for (const step of metrics.steps || []) {
            if (!Number.isFinite(step.duration)) continue;
            if (step.name.startsWith('nora.world-select.') && !step.name.startsWith('nora.world-select.initial-world.')) continue;
            const explicitBackground = /(?:^|\.)background(?:\.|$)/i.test(String(step.name || ''));
            const target = explicitBackground || (Number.isFinite(usable) && Number(step.startedAt) >= usable)
                ? perSessionBackground : perSession;
            if (target === perSession && Number.isFinite(usable) && Number(step.endedAt) > usable) continue;
            target.set(step.name, Math.max(target.get(step.name) || 0, step.duration));
        }
        for (const [name, duration] of perSession) {
            if (!stepDurations.has(name)) stepDurations.set(name, []);
            stepDurations.get(name).push(duration);
        }
        for (const [name, duration] of perSessionBackground) {
            if (!backgroundStepDurations.has(name)) backgroundStepDurations.set(name, []);
            backgroundStepDurations.get(name).push(duration);
        }
    }

    const diagnoses = [...sessions.values()].map(event => diagnoseBootSession(
        event,
        serverSpans.get(event.traceId || event.metrics.sessionId) || [],
    ));
    return {
        sessions: snapshots.length,
        timings: {
            bootClockStarted: distribution(snapshots.map(metrics => Number(metrics.startedAt))),
            navigationConnect: distribution(snapshots.map(metrics => metrics.navigation?.connectDuration)),
            navigationTtfb: distribution(snapshots.map(metrics => metrics.navigation?.ttfb)),
            navigationDownload: distribution(snapshots.map(metrics => metrics.navigation?.downloadDuration)),
            shellRendered: distribution(snapshots.map(metrics => latestMilestone(metrics, 'shell-rendered')?.at)),
            appReady: distribution(snapshots.map(metrics => metrics.readyAt)),
            initialWorldReady: distribution(snapshots.map(initialWorldReadyAt)),
            userInitialWorldReady: distribution(snapshots.map(metrics => userPerceivedAt(metrics, initialWorldReadyAt(metrics)))),
            runtimeReady: distribution(snapshots.map(metrics => latestMilestone(metrics, 'nora-runtime-ready')?.at)),
            usableAfterBootClock: distribution(usableAtBoot),
            usable: distribution(usableAt),
            firstGeneration: distribution(firstGeneration.map(item => item.duration)),
        },
        usableBudget: {
            targetMs: usableTargetMs,
            passed: usablePassed,
            failed: usableFailed,
            missing: snapshots.length - usableSamples.length,
            passRate: usableSamples.length ? usablePassed / usableSamples.length : 0,
        },
        firstGenerationStatus: firstGeneration.reduce((counts, item) => {
            counts[item.status || 'unknown'] = (counts[item.status || 'unknown'] || 0) + 1;
            return counts;
        }, {}),
        duplicateInitialWorldSessions: initialWorldCounts.filter(count => count > 1).length,
        diagnoses,
        causeCounts: diagnoses.reduce((counts, diagnosis) => {
            counts[diagnosis.primaryCause] = (counts[diagnosis.primaryCause] || 0) + 1;
            return counts;
        }, {}),
        slowSteps: [...stepDurations.entries()]
            .map(([name, values]) => ({ name, ...distribution(values) }))
            .sort((left, right) => right.p50 - left.p50)
            .slice(0, 12),
        slowBackgroundSteps: [...backgroundStepDurations.entries()]
            .map(([name, values]) => ({ name, ...distribution(values) }))
            .sort((left, right) => right.p50 - left.p50)
            .slice(0, 12),
    };
}

export function selectRecentBootSessions(events, limit = 20) {
    if (!Number.isInteger(limit) || limit <= 0) return events;
    const latestByTrace = new Map();
    for (const event of events) {
        if (event?.kind === 'server-span') continue;
        const traceId = event?.traceId || event?.metrics?.sessionId;
        if (!traceId) continue;
        const order = Date.parse(event.receivedAt || '') || Number(event.metrics?.startedEpoch) || Number(event.metrics?.capturedAt) || 0;
        latestByTrace.set(traceId, Math.max(latestByTrace.get(traceId) || 0, order));
    }
    const selected = new Set([...latestByTrace.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, limit)
        .map(([traceId]) => traceId));
    return events.filter(event => selected.has(event?.traceId || event?.metrics?.sessionId));
}

function formatDistribution(label, value) {
    if (!value) return `${label}: no samples`;
    return `${label}: n=${value.samples} min=${value.min.toFixed(1)}ms p50=${value.p50.toFixed(1)}ms p90=${value.p90.toFixed(1)}ms max=${value.max.toFixed(1)}ms`;
}

export function formatBootSummary(summary) {
    const lines = [
        `Nora boot sessions: ${summary.sessions}`,
        formatDistribution('Navigation to Nora clock', summary.timings.bootClockStarted),
        formatDistribution('Navigation connect', summary.timings.navigationConnect),
        formatDistribution('Navigation HTML TTFB', summary.timings.navigationTtfb),
        formatDistribution('Navigation HTML download', summary.timings.navigationDownload),
        formatDistribution('Shell rendered', summary.timings.shellRendered),
        formatDistribution('App ready', summary.timings.appReady),
        formatDistribution('Initial world ready', summary.timings.initialWorldReady),
        formatDistribution('Initial world ready from navigation', summary.timings.userInitialWorldReady),
        formatDistribution('Runtime ready', summary.timings.runtimeReady),
        formatDistribution('Usable after Nora clock', summary.timings.usableAfterBootClock),
        formatDistribution('Usable', summary.timings.usable),
        `Usable <= ${summary.usableBudget.targetMs}ms: ${summary.usableBudget.passed}/${summary.usableBudget.passed + summary.usableBudget.failed} (${(summary.usableBudget.passRate * 100).toFixed(1)}%), missing=${summary.usableBudget.missing}`,
        formatDistribution('First generation', summary.timings.firstGeneration),
        `Duplicate initial-world sessions: ${summary.duplicateInitialWorldSessions}`,
        `Measured causes: ${Object.entries(summary.causeCounts).map(([name, count]) => `${name}=${count}`).join(', ') || 'none'}`,
        'Recent session diagnoses:',
        ...summary.diagnoses.slice(-10).map(diagnosis => {
            const signals = diagnosis.signals;
            const cache = signals.cacheHitRate === null ? 'unknown' : `${(signals.cacheHitRate * 100).toFixed(0)}%`;
            return `  ${diagnosis.traceId}: ${diagnosis.primaryCause} total=${signals.totalMs.toFixed(1)}ms backend-max=${signals.backendMaxMs.toFixed(1)}ms long-tasks=${signals.longTaskTotalMs.toFixed(1)}ms cache-hit=${cache} blocking-steps=${signals.blockingStepCount} background-max=${signals.backgroundMaxMs.toFixed(1)}ms`;
        }),
        'Slow blocking startup steps:',
        ...summary.slowSteps.map(step => `  ${step.name}: p50=${step.p50.toFixed(1)}ms p90=${step.p90.toFixed(1)}ms max=${step.max.toFixed(1)}ms`),
        'Slow post-usable background steps:',
        ...summary.slowBackgroundSteps.map(step => `  ${step.name}: p50=${step.p50.toFixed(1)}ms p90=${step.p90.toFixed(1)}ms max=${step.max.toFixed(1)}ms`),
    ];
    return lines.join('\n');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    const argumentsList = process.argv.slice(2);
    const logPath = argumentsList.find(argument => !argument.startsWith('-') && !/^\d+$/.test(argument));
    const lastIndex = argumentsList.indexOf('--last');
    const lastArgument = argumentsList.find(argument => argument.startsWith('--last='));
    const requestedLimit = lastIndex >= 0 ? Number(argumentsList[lastIndex + 1]) : Number(lastArgument?.split('=')[1]);
    const limit = process.argv.includes('--all') ? 0 : (Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : 20);
    if (!logPath) {
        console.error('Usage: node ops/scripts/analyze-boot-metrics.mjs <performance.ndjson|native.log> [--last 20|--all] [--json]');
        process.exitCode = 1;
    } else {
        const events = parseBootMetrics(fs.readFileSync(logPath, 'utf8'));
        const summary = summarizeBootMetrics(selectRecentBootSessions(events, limit));
        console.log(process.argv.includes('--json') ? JSON.stringify(summary, null, 2) : formatBootSummary(summary));
    }
}
