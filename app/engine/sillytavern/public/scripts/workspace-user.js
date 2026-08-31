/**
 * Stable browser-side identity for the single Nora workspace.
 * Storage-key consumers keep this interface without account UI or account APIs.
 */
export const currentUser = Object.freeze({
    handle: 'default-user',
    name: 'Nora',
    admin: true,
});

export const accountsEnabled = false;

export async function setUserControls() {
    // Account controls do not exist in the single-workspace product.
}

export function isAdmin() {
    return true;
}

export function getCurrentUserHandle() {
    return currentUser.handle;
}
