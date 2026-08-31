import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import isDocker from 'is-docker';
import webpack from 'webpack';
import { serverDirectory } from './src/server-directory.js';
import { getVersion, color } from './src/util.js';

/**
 * Generate a cache version string based on the application version, Git revision, and Webpack version.
 * @returns {string} The cache version string.
 */
function getWebpackCacheVersion() {
    return crypto.createHash('shake256', { outputLength: 8 })
        .update(JSON.stringify([appVersion.pkgVersion, appVersion.gitRevision, webpack.version]))
        .digest('hex');
}

/**
 * Prune old Webpack cache directories that do not match the current cache version.
 * @param {string} webpackRoot The root directory where Webpack caches are stored.
 * @param {string} currentCacheVersion The current cache version to keep.
 */
function pruneWebpackCache(webpackRoot, currentCacheVersion) {
    try {
        if (!fs.existsSync(webpackRoot)) {
            return;
        }

        const cacheDirectories = fs.readdirSync(webpackRoot, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        for (const dir of cacheDirectories) {
            const dirPath = path.join(webpackRoot, dir);
            if (dir !== currentCacheVersion) {
                try {
                    fs.rmSync(dirPath, { recursive: true, force: true });
                    console.debug(`Removed outdated cache directory: ${color.yellow(dir)}`);
                } catch (error) {
                    console.error(`Failed to remove Webpack cache directory: ${color.red(dir)}`, error);
                }
            }
        }
    } catch (error) {
        console.error('Failed to read Webpack cache directories for pruning.', error);
    }
}

const appVersion = await getVersion();

/**
 * Get the Webpack configuration for the public/lib.js file.
 * 1. Docker has got cache and the output file pre-baked.
 * 2. Non-Docker environments use the global DATA_ROOT variable to determine the cache and output directories.
 * @param {object} options Configuration options.
 * @param {boolean} [options.forceDist=false] Whether to force the use the versioned /dist cache.
 * @param {boolean} [options.bundled=false] Whether to build the release-owned runtime artifact.
 * @param {boolean} [options.pruneCache=false] Whether to prune old cache directories.
 * @returns {import('webpack').Configuration}
 * @throws {Error} If the DATA_ROOT variable is not set.
 * */
export default function getPublicLibConfig({ forceDist = false, bundled = false, pruneCache = false } = {}) {
    function getWebpackRoot() {
        if (bundled) {
            return path.resolve(process.cwd(), 'dist', '_webpack');
        }

        if (forceDist || isDocker()) {
            return path.resolve(process.cwd(), 'dist', '_webpack');
        }

        if (typeof globalThis.DATA_ROOT === 'string') {
            return path.resolve(globalThis.DATA_ROOT, '_webpack');
        }

        throw new Error('DATA_ROOT variable is not set.');
    }

    function getCacheDirectory() {
        if (bundled) {
            return path.join(webpackRoot, 'cache');
        }

        return path.join(webpackRoot, cacheVersion, 'cache');
    }

    function getOutputDirectory() {
        if (bundled) {
            return path.join(webpackRoot, 'output');
        }

        return path.join(webpackRoot, cacheVersion, 'output');
    }

    const webpackRoot = getWebpackRoot();
    const cacheVersion = getWebpackCacheVersion();
    const cacheDirectory = getCacheDirectory();
    const outputDirectory = getOutputDirectory();

    if (pruneCache) {
        pruneWebpackCache(webpackRoot, cacheVersion);
    }

    return {
        mode: 'production',
        entry: path.join(serverDirectory, 'public/lib.js'),
        cache: bundled ? false : {
            type: 'filesystem',
            cacheDirectory: cacheDirectory,
            version: cacheVersion,
            store: 'pack',
            compression: 'gzip',
        },
        devtool: false,
        watch: false,
        module: {},
        stats: {
            preset: 'minimal',
            assets: false,
            modules: false,
            colors: true,
            timings: true,
        },
        experiments: {
            outputModule: true,
        },
        performance: {
            hints: false,
        },
        plugins: [
            new webpack.IgnorePlugin({ resourceRegExp: /^\.\/locale$/, contextRegExp: /moment$/ }),
        ],
        output: {
            path: outputDirectory,
            filename: 'lib.js',
            libraryTarget: 'module',
            clean: bundled,
        },
    };
}
