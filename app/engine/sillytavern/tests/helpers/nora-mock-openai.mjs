import http from 'node:http';

const port = Number(process.env.NORA_MOCK_PORT || 18880);
const responseText = process.env.NORA_MOCK_RESPONSE || 'NORA_PHASE1_OK';

async function readJson(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function writeJson(response, status, body) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
}

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === 'GET' && url.pathname.endsWith('/models')) {
        writeJson(response, 200, {
            object: 'list',
            data: [{ id: 'nora-test-model', object: 'model' }],
        });
        return;
    }

    if (request.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
        const body = await readJson(request);
        console.log(JSON.stringify({
            event: 'generation-request',
            model: body.model,
            messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
            stream: Boolean(body.stream),
        }));

        if (body.stream) {
            response.writeHead(200, {
                'cache-control': 'no-cache',
                connection: 'keep-alive',
                'content-type': 'text/event-stream',
            });
            response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: responseText } }] })}\n\n`);
            response.end('data: [DONE]\n\n');
            return;
        }

        writeJson(response, 200, {
            id: 'nora-phase1-completion',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: responseText }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
        return;
    }

    writeJson(response, 404, { error: `Unhandled mock route: ${request.method} ${url.pathname}` });
});

server.listen(port, '127.0.0.1', () => {
    console.log(JSON.stringify({ event: 'mock-ready', port }));
});

