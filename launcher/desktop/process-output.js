function consumeLines(stream, onLine, onError, {preserveBlankLines=false}={}) {
  let pending = '',dropping=false;
  const maximum=256*1024;
  const deliver = line => {
    try { onLine(line); }
    catch (error) {
      if (typeof onError !== 'function') throw error;
      onError(error);
    }
  };
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    for(const part of String(chunk).split(/(?<=\n)/)){
      if(!dropping&&pending.length+part.length>maximum){
        pending='';dropping=true;
        const error=Object.assign(new Error('程序单条输出超过诊断读取上限，已继续排空输出并保留错误。'),{code:'PROCESS_OUTPUT_TOO_LARGE'});
        if(typeof onError==='function')onError(error);else throw error;
      }
      if(!dropping)pending+=part;
      if(part.endsWith('\n')){
        if(!dropping&&(preserveBlankLines||pending.trim()))deliver(pending.replace(/\r?\n$/,''));
        pending='';dropping=false;
      }
    }
  });
  stream.on('end', () => { if (preserveBlankLines?pending.length:pending.trim()) deliver(pending); pending = ''; });
  if (typeof onError === 'function') stream.on('error', onError);
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
