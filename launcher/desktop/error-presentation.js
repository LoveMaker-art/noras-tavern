// User guidance uses positive technical evidence. It never changes diagnostics
// or infers a root cause from an arbitrary subprocess/provider message.
const { describeError } = require('./launcher-errors');

const operations = { install: '安装', update: '更新', repair: '修复', start: '启动', stop: '停止', restart: '重启',
  pair: '配对', model: '模型配置', list_models: '获取模型列表', check_update: '检查更新',
  status: '服务状态检查', open: '打开页面', uninstall: '卸载', settings: '打开安装目录' };
const guidance = {
  permission_denied: ['系统未允许访问所需文件。', '请检查安装目录的读写权限；若安全软件有明确拦截提示，核实被拦截文件后再处理。'],
  file_not_found: ['所需文件或目录没有找到。', '请确认安装盘已连接、安装目录可访问；若安装包缺少文件，请重新下载完整安装包。'],
  disk_full: ['磁盘空间不足。', '请清理安装盘和系统临时目录所在磁盘的空间，再重试。'],
  dns_failed: ['无法找到服务地址。', '请检查网络、接口地址及代理设置，再重试。'],
  connection_refused: ['目标服务没有接受连接。', '本地模型请先启动服务；其他连接请核对地址、端口和代理设置。'],
  network: ['连接中断了。', '请确认网络和代理可用，稍后重试。'],
  tls_failed: ['无法验证连接的安全证书。', '请检查系统日期、时间和代理证书；保留证书校验，不要关闭安全校验。'],
  timeout: ['等待后台响应超时。', '请先检查当前运行状态，再重试；安装或更新请保留现有目录和备份。'],
  cancelled: ['操作已取消。', '请确认当前状态后，再决定是否继续。'],
  http_unauthorized: ['服务未接受身份验证。', '请核对 API Key 和接口地址，勿把 Key 发给他人。'],
  http_forbidden: ['服务拒绝了这次请求。', '请检查服务账号、模型访问权限和接口地址；权限问题需联系对应服务方。'],
  rate_limited: ['请求过于频繁，或服务配额受限。', '请稍后重试，并检查对应服务的配额说明。'],
  http_error: ['服务返回了异常响应。', '请稍后重试；若持续出现，请查看对应服务的运行状态。'],
  invalid_response: ['后台返回的内容无法识别。', '请核对接口地址；更新服务持续异常时，请保留日志。'],
  empty_response: ['后台没有返回可用内容。', '请核对接口和模型名称，稍后重试。'],
  response_too_large: ['后台返回的内容超出了启动器可处理的范围。', '请核对接口地址；若仍出现，请保留日志。'],
  verification_failed: ['组件的完整性或兼容性检查未通过。', '请使用适合当前系统的完整安装包；保留现有安装、数据和备份。'],
  renderer_gone: ['启动器窗口意外关闭了。', '请重新打开启动器，先检查后台任务和服务状态。'],
};
const business = {
  TAVERN_OWNERSHIP: ['无法确认酒馆进程归属。', '启动器没有接管或结束这个进程。', '请保留当前进程和日志，勿按提示中的 PID 强行结束程序。'],
  GATEWAY_IDENTITY: ['无法确认诺拉后台进程。', '启动器未启动第二个后台进程。', '请重启电脑后重试；若仍出现，请保留日志，勿强行结束提示中的 PID。'],
  TAVERN_PORT_OCCUPIED: ['酒馆端口已被占用。', '当前无法在预定端口启动酒馆。', '请先检查是否已有酒馆运行；不要随意结束占用端口的未知程序。'],
  TAVERN_UNHEALTHY: ['酒馆启动检查未通过。', '尚未确认酒馆能够正常使用。', '请查看日志确认启动失败原因，再决定如何恢复。'],
  UPDATE_RECOVERY_REQUIRED: ['上次更新仍需恢复。', '启动器暂时阻止继续启动或更新。', '请保留安装目录、日志和备份，通过启动器的恢复提示处理，勿清空重装。'],
  MODEL_SYNC_PENDING: ['模型已验证，酒馆同步未完成。', '配置已保存，尚需完成酒馆同步。', '请选择“继续同步”，无需重新填写 API Key。'],
  PAIR_CODE_REJECTED: ['ClawChat 配对未完成。', '本次配对码未能完成激活。', '请在 ClawChat 重新获取配对码再填写；不要反复提交同一个配对码。'],
  NODE_UNAVAILABLE: ['Nora 自带的运行环境不可用。', '酒馆启动尚未完成。', '请使用对应系统的完整启动器安装包修复运行环境，保留现有数据。'],
  RELEASE_COMPATIBILITY: ['该发布暂时无法安装。', '完整性或兼容性检查未通过，本次未开始安装该版本。', '请核对版本要求，使用对应系统的完整发布包；需要时先升级启动器。'],
  LOG_OPEN_FAILED: ['无法打开日志文件。', '系统未能打开已有日志。', '请在“更多”的安装信息中打开安装目录，或检查系统的文件打开方式。'],
};

function readableLocalMessage(error) {
  const message = String(error?.message || (typeof error === 'string' ? error : '')).trim();
  return /[\u3400-\u9fff]/.test(message) && message.length <= 360
    && !/Traceback|\bat\s+\S+\s*\(|\b\w*Error:|\b(?:WinError|Errno|pid|syscall)\b|\n|[\\/][^\s]*[\\/]/i.test(message)
    && error?.source !== 'model_service' ? message.slice(0,200) : '';
}

function presentError(error, context = {}) {
  const operation = operations[context.action] || '本次操作';
  const chain = []; const seen = new Set();
  for (let value = error; value && typeof value === 'object' && !seen.has(value) && chain.length < 4; value = value.cause) {
    seen.add(value); chain.push(value);
  }
  const userCode = chain.map(value => value.userCode || value.code).find(code => Object.hasOwn(business, code));
  const readable = chain.map(readableLocalMessage).find(Boolean) || readableLocalMessage(error);
  if (userCode) {
    const [title, fallback, next] = business[userCode];
    const detail = userCode === 'RELEASE_COMPATIBILITY' ? readable || fallback : fallback;
    return { title, detail, next };
  }
  const technical = describeError(error, context);
  const known = guidance[technical.error_code];
  if (known) {
    const [title, recommendation] = known;
    let next = recommendation;
    const model = technical.error_source === 'model_service';
    if (technical.error_code === 'http_unauthorized' && !model)
      next = '请重新检查更新；若仍出现，请保留日志并反馈更新服务的访问问题，无需修改模型 Key。';
    if (technical.error_code === 'http_forbidden' && !model)
      next = technical.error_source === 'release_service'
        ? '更新服务拒绝访问，请检查网络或代理的访问限制，稍后重新检查更新；持续出现时反馈发布服务访问问题。'
        : '请检查对应服务的访问权限和网络设置，持续出现时联系服务方。';
    if (technical.error_code === 'connection_refused' && !model)
      next = '请检查对应服务是否启动，以及网络、地址和代理设置。';
    if (technical.error_code === 'http_error' && technical.http_status >= 500)
      next = '对应服务暂时异常，请稍后重试；持续出现时查看服务方的运行状态。';
    return { title, detail: `${operation}尚未确认完成。`, next };
  }
  // Preserve short, already-readable Chinese guidance from existing business
  // guards. Technical dumps and provider text never become the main guidance.
  return { title: `${operation}未完成。`,
    detail: technical.error_source !== 'model_service' && readable
      || '原因尚未确认，具体诊断已尽力记录在本机日志中。',
    next: '请保留现有安装和数据，在“更多”中查看日志；不要反复卸载重装。' };
}

function formatUserError(error, context) {
  const problem = presentError(error, context);
  return [problem.title, problem.detail, problem.next].join('\n');
}

module.exports = { presentError, formatUserError };
