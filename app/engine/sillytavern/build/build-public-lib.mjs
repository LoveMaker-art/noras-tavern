import fs from 'node:fs';
import path from 'node:path';

import webpack from 'webpack';

import getPublicLibConfig from '../webpack.config.js';

const configuration = getPublicLibConfig({ bundled: true });
const compiler = webpack(configuration);
const stats = await new Promise((resolve, reject) => {
    compiler.run((error, result) => {
        if (error) reject(error);
        else resolve(result);
    });
});

await new Promise((resolve, reject) => {
    compiler.close(error => error ? reject(error) : resolve());
});

fs.rmSync(path.resolve(configuration.output.path, '..', 'cache'), {
    recursive: true,
    force: true,
});

const output = stats?.toString(configuration.stats);
if (output) console.log(output);
if (!stats || stats.hasErrors()) {
    throw new Error('Public library compilation failed.');
}
