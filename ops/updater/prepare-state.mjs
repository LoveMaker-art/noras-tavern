// Internal worker: writes only a reviewed transaction's prepared state copy.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { convertPythonState } from './python-state.mjs';
import { validateState } from './validate-state.mjs';

try {
    const [state, app] = process.argv.slice(2);
    if (!state || !app || !path.isAbsolute(state) || !path.isAbsolute(app)
        || path.basename(state) !== 'state' || path.basename(path.dirname(state)) !== 'prepared') throw new Error('A prepared state copy is required');
    const transaction = path.dirname(path.dirname(state));
    const home = await fs.realpath(path.dirname(path.dirname(transaction)));
    const plan = JSON.parse(await fs.readFile(path.join(transaction, 'plan.json'), 'utf8'));
    if (!plan.cleanTransaction || plan.home !== home || !path.basename(transaction).startsWith('review-')
        || path.dirname(transaction) !== path.join(home, 'tavern-updates-v2')
        || await fs.realpath(state) !== state || await fs.realpath(app) !== path.join(transaction, 'source/app')) throw new Error('Reviewed prepared-state transaction required');
    if (plan.testMode) {
        const marker = JSON.parse(await fs.readFile(path.join(home, '.tavern-isolated-update.json'), 'utf8'));
        const roots = await Promise.all([os.tmpdir(), '/tmp'].map(root => fs.realpath(root)));
        if (!roots.some(root => home.startsWith(root + path.sep)) || marker.schema !== 1 || marker.home !== home
            || marker.purpose !== 'isolated-update-test') throw new Error('Marked isolated transaction required');
    }
    const entries = await fs.readdir(state);
    if (entries.includes('productions')) {
        let options = {};
        try { options = JSON.parse(await fs.readFile(path.join(transaction, 'prepared/model-input.json'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (options.legacyApp !== path.join(home, 'apps/tavern-runtime')) throw new Error('Legacy source must match the reviewed installation');
        if (!plan.pythonSource || options.legacyWeb !== plan.pythonSource.web) throw new Error('Python web root must match the reviewed layout');
        const report = await convertPythonState(state, app, options);
        await validateState(state, app);
        console.log(JSON.stringify(report));
    } else console.log(JSON.stringify(await validateState(state, app)));
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
