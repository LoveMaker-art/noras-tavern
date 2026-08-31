import { NO_STORE_CACHE_CONTROL, REVALIDATED_ASSET_CACHE_CONTROL } from './nora-static-assets.js';

// Bind the Story Profile app to this upstream path. The Tunnel Agent prepends
// it to every request; the public app still uses ordinary root-relative URLs.
export const STORY_PROFILE_UPSTREAM_PATH = '/_liveware/story-profile';
const storyProfileEntry = Symbol('storyProfileEntry');

/**
 * Select the page entry without relying on Host (the tunnel rewrites it).
 * Only normalizes the URL; all requests still pass through shared auth, CSRF,
 * API and asset middleware. This is presentation routing, not access control.
 * @returns {import('express').RequestHandler}
 */
export function createLivewareEntryMiddleware() {
    return (request, response, next) => {
        const queryIndex = request.url.indexOf('?');
        const pathname = queryIndex < 0 ? request.url : request.url.slice(0, queryIndex);
        if (pathname === STORY_PROFILE_UPSTREAM_PATH || pathname.startsWith(`${STORY_PROFILE_UPSTREAM_PATH}/`)) {
            response.locals[storyProfileEntry] = true;
            const suffix = pathname.slice(STORY_PROFILE_UPSTREAM_PATH.length) || '/';
            request.url = suffix + (queryIndex < 0 ? '' : request.url.slice(queryIndex));
        }
        next();
    };
}

/**
 * Return each app's own title/icon in the initial HTML, without a redirect or JS.
 * @param {{tavernHtml: string, storyProfileHtml: string}} pages Initial HTML.
 * @returns {import('express').RequestHandler}
 */
export function createLivewareIndexHandler({ tavernHtml, storyProfileHtml }) {
    return (_request, response) => {
        const isStoryProfile = response.locals[storyProfileEntry] === true;
        response.setHeader('Cache-Control', isStoryProfile ? NO_STORE_CACHE_CONTROL : REVALIDATED_ASSET_CACHE_CONTROL);
        return response.type('html').send(isStoryProfile ? storyProfileHtml : tavernHtml);
    };
}
