import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpack from 'webpack';

const root = path.dirname(fileURLToPath(import.meta.url));

export default {
    mode: 'production',
    context: root,
    entry: {
        entry: './public/nora-entry.js',
        'lib-core': './public/lib-core.js',
    },
    devtool: false,
    experiments: {
        outputModule: true,
    },
    output: {
        path: path.join(root, 'public', 'dist', 'nora'),
        filename: '[name].js',
        module: true,
        library: { type: 'module' },
        clean: true,
    },
    plugins: [
        new webpack.IgnorePlugin({ resourceRegExp: /^\.\/locale$/, contextRegExp: /moment$/ }),
    ],
};
