// Convert a private copy of Python state. Unsupported records are archived by
// python-state.mjs and do not block installation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { convertPythonState } from './python-state.mjs';

try {
    const [state, app, optionsFile] = process.argv.slice(2);
    if (!state || !app || !path.isAbsolute(state) || !path.isAbsolute(app)) {
        throw new Error('state and app must be absolute paths');
    }
    let options = {};
    if (optionsFile) options = JSON.parse(await fs.readFile(optionsFile, 'utf8'));
    const report = await convertPythonState(state, app, options);
    console.log(JSON.stringify(report));
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
