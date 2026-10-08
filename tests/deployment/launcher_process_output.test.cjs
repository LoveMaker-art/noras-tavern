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

test('line callback failures are reported while remaining and final lines are consumed', async () => {
  const stream = new PassThrough();
  const rows = [], failures = [];
  const original = Object.assign(new Error('progress state write denied'), { code: 'EPERM' });
  consumeLines(stream, line => {
    rows.push(line);
    if (line !== 'result') throw original;
  }, error => failures.push(error));
  const done = new Promise(resolve => stream.on('end', resolve));
  assert.doesNotThrow(() => stream.write('progress\nresult\nfinal'));
  stream.end(); await done;
  assert.deepEqual(rows, ['progress', 'result', 'final']);
  assert.deepEqual(failures, [original, original]);
});

test('raw log readers retain blank lines and traceback indentation when explicitly requested',async()=>{
  const stream=new PassThrough(),rows=[];
  consumeLines(stream,line=>rows.push(line),undefined,{preserveBlankLines:true});
  const done=new Promise(resolve=>stream.on('end',resolve));
  stream.write('[ERROR] native failure\n\n  at unpack (archive.js:42:3)\n');stream.end();await done;
  assert.equal(rows.join('\n'),'[ERROR] native failure\n\n  at unpack (archive.js:42:3)');
});

test('external navigation allows HTTPS and loopback, rejects executable and credential URLs', () => {
  assert.equal(externalUrl('https://github.com/LoveMaker-art/noras-tavern'), 'https://github.com/LoveMaker-art/noras-tavern');
  assert.equal(externalUrl('http://127.0.0.1:8799'), 'http://127.0.0.1:8799/');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'http://example.com', 'https://user:secret@example.com']) assert.throws(() => externalUrl(url));
});

test('oversized unterminated output is drained with a bounded error and the next record remains readable',async()=>{
  const stream=new PassThrough(),rows=[],errors=[];
  consumeLines(stream,line=>rows.push(JSON.parse(line)),error=>errors.push(error));
  const done=new Promise(resolve=>stream.on('end',resolve));
  for(let i=0;i<20;i++)stream.write('x'.repeat(32768));
  stream.end('\n{"event":"result","ok":true}\n');await done;
  assert.equal(errors.length,1);assert.equal(errors[0].code,'PROCESS_OUTPUT_TOO_LARGE');
  assert.deepEqual(rows,[{event:'result',ok:true}]);
});
