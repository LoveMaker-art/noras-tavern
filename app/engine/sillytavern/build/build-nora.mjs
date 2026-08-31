import process from 'node:process';

import webpack from 'webpack';

import config from '../webpack.nora.config.mjs';

function compile(configuration) {
    return new Promise((resolve, reject) => {
        webpack(configuration, (error, stats) => {
            if (error) {
                reject(error);
                return;
            }
            if (!stats) {
                reject(new Error('Webpack completed without compilation statistics.'));
                return;
            }
            const output = stats.toString({
                all: false,
                assets: true,
                errors: true,
                timings: true,
                warnings: true,
            });
            if (output) console.log(output);
            if (stats.hasErrors()) {
                reject(new Error('Nora Webpack compilation failed.'));
                return;
            }
            resolve();
        });
    });
}

await compile(config).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
