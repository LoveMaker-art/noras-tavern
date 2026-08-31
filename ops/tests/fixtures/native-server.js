// Non-generating process for lifecycle tests, never a replacement application.
const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ token: 'fixture-only', ok: true }));
}).listen(port, '127.0.0.1');
