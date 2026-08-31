export function createPerformanceReporter({
    getMetrics = () => globalThis.__NORA_BOOT_METRICS__,
    reportPhase = phase => globalThis.__NORA_REPORT_BOOT_METRICS__?.(phase),
    now = () => performance.now(),
} = {}) {
    let firstGenerationRecorded = false;
    let usableRecorded = false;
    const round = value => Math.round(value * 10) / 10;

    function milestone(value) {
        const metrics = getMetrics();
        if (!metrics) return;
        metrics.milestones ??= [];
        metrics.milestones.push(value);
    }

    function elapsedAt() {
        const metrics = getMetrics();
        return metrics ? round(now() - metrics.startedAt) : 0;
    }

    function timedMilestone(name, startedAt, details = {}) {
        milestone({ name, ...details, at: elapsedAt(), duration: round(now() - startedAt) });
    }

    function phase(name, startedAt, details = {}) {
        timedMilestone(name, startedAt, details);
        reportPhase(name);
    }

    async function step(name, operation) {
        const metrics = getMetrics();
        const rawStartedAt = now();
        const startedAt = metrics ? round(rawStartedAt - metrics.startedAt) : 0;
        let status = 'ok';
        try {
            return await operation();
        } catch (error) {
            status = 'error';
            throw error;
        } finally {
            if (metrics) {
                metrics.steps ??= [];
                metrics.steps.push({
                    name,
                    startedAt,
                    endedAt: elapsedAt(),
                    duration: round(now() - rawStartedAt),
                    status,
                });
            }
        }
    }

    function firstGeneration(metric) {
        if (firstGenerationRecorded) return;
        firstGenerationRecorded = true;
        milestone({
            name: 'first-generation-settled',
            at: elapsedAt(),
            duration: round(metric.duration),
            mode: metric.mode || metric.type,
            status: metric.status,
        });
        reportPhase('first-interaction');
    }

    function usable(details = {}) {
        if (usableRecorded) return;
        usableRecorded = true;
        milestone({ name: 'nora-usable', at: elapsedAt(), ...details });
        reportPhase('nora-usable');
    }

    return Object.freeze({ milestone, timedMilestone, phase, step, firstGeneration, usable });
}
