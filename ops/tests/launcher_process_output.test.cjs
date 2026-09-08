const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { consumeLines, externalUrl } = require('../installer/desktop/process-output');

test('buffers fragmented JSON and UTF-8, including final unterminated line', async () => {
  const stream = new PassThrough();
  const rows = [];
  consumeLines(stream, value => rows.push(JSON.parse(value)));
  const done = new Promise(resolve => stream.on('end', resolve));
  const bytes = Buffer.from('{"task":"诺拉"}\r\n{"event":"result","ok":true}');
  for (const byte of bytes) stream.write(Buffer.from([byte]));
  stream.end(); await done;
  assert.deepEqual(rows, [{ task: '诺拉' }, { event: 'result', ok: true }]);
});

test('external navigation allows HTTPS and loopback, rejects executable and credential URLs', () => {
  assert.equal(externalUrl('https://github.com/LoveMaker-art/noras-tavern'), 'https://github.com/LoveMaker-art/noras-tavern');
  assert.equal(externalUrl('http://127.0.0.1:8799'), 'http://127.0.0.1:8799/');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'http://example.com', 'https://user:secret@example.com']) assert.throws(() => externalUrl(url));
});
