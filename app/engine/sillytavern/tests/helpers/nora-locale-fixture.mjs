// Existing presentation fixtures assert Chinese text. Do not inherit the
// machine's ICU/browser locale; use NORA_TEST_LOCALE for explicit other locales.
globalThis.__NORA_LOCALE__ = process.env.NORA_TEST_LOCALE || 'zh-cn';
