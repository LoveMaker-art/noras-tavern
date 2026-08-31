// Host-specific transport for the otherwise unchanged Story Profile frontend.
// Only that frontend opts in; this does not replace global fetch or disable CSRF.
globalThis.noraProfileRequest = async function noraProfileRequest(input, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const csrf = await fetch('/csrf-token', { credentials: 'same-origin', cache: 'no-store' });
        if (!csrf.ok) throw new Error('无法取得安全令牌，请刷新后重试。');
        const payload = await csrf.json();
        if (typeof payload?.token !== 'string' || !payload.token) throw new Error('安全令牌无效，请刷新后重试。');
        headers.set('X-CSRF-Token', payload.token);
    }
    return fetch(input, { ...options, credentials: 'same-origin', headers });
};
