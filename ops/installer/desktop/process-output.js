function consumeLines(stream, onLine) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) if (line.trim()) onLine(line);
  });
  stream.on('end', () => { if (pending.trim()) onLine(pending); pending = ''; });
}

function externalUrl(value) {
  const url = new URL(String(value));
  if (url.username || url.password || !(url.protocol === 'https:'
    || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('不允许打开这个地址。');
  }
  return url.href;
}

module.exports = { consumeLines, externalUrl };
