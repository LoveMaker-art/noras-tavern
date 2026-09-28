function clean(value) {
    return String(value ?? '').trim();
}

/**
 * Build the original Story Profile handoff: open the current Hermes curator
 * chat with a review draft. The draft is deliberately not sent automatically.
 */
export function buildCuratorReviewLink({ agentUserId, worldName } = {}) {
    const userId = clean(agentUserId);
    if (!userId) return '';
    const world = clean(worldName) || '最近一场';
    const query = new URLSearchParams({
        chat: '1',
        draft: `整理「${world}」这场故事`,
    });
    return `clawchat://u/${encodeURIComponent(userId)}?${query.toString()}`;
}

/**
 * Story Profile is a separate lightweight page served by the current Nora
 * process, not a modal backed by browser-local settings.
 */
export function storyProfileHref(returnUrl = '') {
    const query = new URLSearchParams({ from: 'console' });
    const target = clean(returnUrl);
    if (target) query.set('return', target);
    return `/actor?${query.toString()}`;
}

export function createStoryProfileCheckpoint({ activeWorldModel, requestHeaders, fetchImpl = (...args) => fetch(...args) }) {
    return (requestedWorldId = '') => {
        const worldId = String(requestedWorldId || activeWorldModel()?.id || '').trim();
        if (!worldId) return;
        void fetchImpl('/api/nora-story-profile/checkpoint', {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify({ world_id: worldId }),
        }).then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
        }).catch((error) => {
            console.warn('[Nora Story Profile] Background checkpoint failed:', error);
        });
    };
}
