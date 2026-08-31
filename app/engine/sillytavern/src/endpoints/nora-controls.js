import path from 'node:path';
import express from 'express';
import { createControlBroker } from '../nora-control-broker.js';
import { CONTROL_ACTIONS } from '../../public/scripts/nora-controls/contract.js';
const brokers = new Map();
export function createNoraControlsRouter({ resolveBroker = request => {
    const root = path.resolve(request.user.directories.root);
    if (!brokers.has(root)) brokers.set(root, createControlBroker(root));
    return brokers.get(root);
} } = {}) {
    const router = express.Router();
    router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
    const handler = fn => async (request, response) => {
        try { return await fn(request, response, resolveBroker(request)); } catch (error) { return response.status(409).json({ code: error.code || 'NORA_CONTROL_FAILED', error: 'Control request rejected; inspect code and current client state.' }); }
    };
    router.get('/catalog', (_request, response) => response.json({ actions: CONTROL_ACTIONS, backendTools: ['nora.ledger.status', 'nora.ledger.configure', 'nora.ledger.compress', 'nora.story.card', 'nora.story.checkpoint', 'nora.story.learn', 'nora.story.refresh'] }));
    router.get('/clients', handler((_req, res, broker) => res.json({ clients: broker.list() })));
    router.get('/operations/:id', handler((req, res, broker) => res.json(broker.inspect(req.params.id))));
    router.post('/hello', handler((req, res, broker) => res.json(broker.hello(req.body))));
    router.post('/read', handler((req, res, broker) => res.status(202).json(broker.submit(req.body, { readOnly: true }))));
    router.post('/execute', handler((req, res, broker) => res.status(202).json(broker.submit(req.body))));
    router.post('/ack', handler((req, res, broker) => res.json(broker.ack(req.body))));
    router.post('/poll', handler(async (req, res, broker) => {
        const abort = new AbortController(); res.once('close', () => abort.abort());
        const command = await broker.poll(req.body, abort.signal);
        if (!res.destroyed) res.json({ command });
    }));
    return router;
}
export const router = createNoraControlsRouter();
