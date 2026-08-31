import fs from 'node:fs';
import path from 'node:path';
import webpack from 'webpack';
import getPublicLibConfig from '../../webpack.config.js';
import { IMMUTABLE_ASSET_CACHE_CONTROL, REVALIDATED_ASSET_CACHE_CONTROL } from '../nora-static-assets.js';

export default function getWebpackServeMiddleware(assetBasePath = '', dependencies = {}) {
    const getConfig = dependencies.getPublicLibConfig ?? getPublicLibConfig;
    const fileExists = dependencies.fileExists ?? fs.existsSync;
    const createCompiler = dependencies.webpack ?? webpack;
    const bundledConfig = getConfig({ bundled: true });
    const bundledOutput = getOutputFile(bundledConfig);
    const hasBundledOutput = Boolean(bundledOutput && fileExists(bundledOutput));

    function getOutputFile(configuration) {
        const outputPath = configuration.output?.path;
        const outputFile = configuration.output?.filename;
        return typeof outputPath === 'string' && typeof outputFile === 'string'
            ? path.join(outputPath, outputFile)
            : '';
    }

    function getActiveConfig({ forceDist = false, pruneCache = false } = {}) {
        if (!forceDist && hasBundledOutput) {
            return bundledConfig;
        }

        return getConfig({ forceDist, pruneCache });
    }

    /**
     * A very spartan recreation of webpack-dev-middleware.
     * @param {import('express').Request} req Request object.
     * @param {import('express').Response} res Response object.
     * @param {import('express').NextFunction} next Next function.
     * @type {import('express').RequestHandler}
     */
    function devMiddleware(req, res, next) {
        const publicLibConfig = getActiveConfig();
        const outputPath = publicLibConfig.output?.path;
        const outputFile = publicLibConfig.output?.filename;
        const unversionedPath = `/${outputFile}`;
        const versionedPath = `${assetBasePath}/${outputFile}`;
        const isVersionedRequest = Boolean(assetBasePath) && req.path === versionedPath;

        if (req.method === 'GET' && (req.path === unversionedPath || isVersionedRequest)) {
            return res.sendFile(outputFile, {
                root: outputPath,
                etag: true,
                lastModified: true,
                headers: {
                    'Cache-Control': isVersionedRequest
                        ? IMMUTABLE_ASSET_CACHE_CONTROL
                        : REVALIDATED_ASSET_CACHE_CONTROL,
                },
            });
        }

        next();
    }

    /**
     * Wait until Webpack is done compiling.
     * @param {object} param Parameters.
     * @param {boolean} [param.forceDist=false] Whether to force the use the /dist folder.
     * @param {boolean} [param.pruneCache=false] Whether to prune old cache directories before compiling.
     * @returns {Promise<void>}
     */
    devMiddleware.runWebpackCompiler = ({ forceDist = false, pruneCache = false } = {}) => {
        console.log();
        console.log('Compiling frontend libraries...');

        const publicLibConfig = getActiveConfig({ forceDist, pruneCache });
        const cachedOutput = getOutputFile(publicLibConfig);
        // Nora pinned build output v4: releases own the production bundle; runtime compilation is fallback only.
        if (!forceDist && cachedOutput && fileExists(cachedOutput)) {
            console.log(hasBundledOutput
                ? 'Using bundled frontend libraries.'
                : 'Using cached frontend libraries.');
            return Promise.resolve();
        }
        const compiler = createCompiler(publicLibConfig);

        return new Promise((resolve) => {
            compiler.run((_error, stats) => {
                const output = stats?.toString(publicLibConfig.stats);
                if (output) {
                    console.log(output);
                    console.log();
                }
                compiler.close(() => {
                    resolve();
                });
            });
        });
    };

    return devMiddleware;
}
