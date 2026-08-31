module.exports = {
    root: true,
    extends: ['eslint:recommended'],
    env: { browser: true, node: true, es2022: true, jquery: true },
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }] },
};
