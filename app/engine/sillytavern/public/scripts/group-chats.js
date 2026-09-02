/**
 * ST compatibility boundary for extensions that prepare chat-completion requests.
 * Nora worlds currently contain one active character rather than ST group chats.
 *
 * @returns {string[]}
 */
export function getGroupNames() {
    return [];
}
