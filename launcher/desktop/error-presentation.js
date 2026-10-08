// User guidance uses positive technical evidence. It never changes diagnostics
// or infers a root cause from an arbitrary subprocess/provider message.
const { describeError, isProxyConnectionFailure } = require('./launcher-errors');

const operations = { install: '安装', update: '更新', repair: '修复', start: '启动', stop: '停止', restart: '重启',
  pair: '配对', model: '模型配置', list_models: '获取模型列表', check_update: '检查更新',
  status: '服务状态检查', open: '打开页面', uninstall: '卸载', settings: '打开安装目录',
  recover: '恢复旧版本', recoverLauncher: '恢复旧启动器' };
const guidance = {
  permission_denied: ['无法访问安装文件。', '请检查目录权限；安全软件拦截时，核实文件后再处理。'],
  file_not_found: ['缺少必要的文件。', '请检查安装目录；安装包缺文件时，重新下载完整包。'],
  disk_full: ['磁盘空间不足。', '请清理安装盘和系统临时目录所在磁盘，再重新检查。'],
  dns_failed: ['无法找到服务地址。', '请检查网络、接口地址和代理。'],
  connection_refused: ['服务未接受连接。', '请确认服务已启动，并核对地址和端口。'],
  network: ['连接中断了。', '请检查网络或代理后重新检查。'],
  tls_failed: ['连接证书检查失败。', '请检查系统时间和代理证书，勿关闭证书校验。'],
  timeout: ['等待响应超时。', '请先查询任务状态，保留安装目录和备份。'],
  cancelled: ['操作已取消。', '请确认当前状态后再继续。'],
  http_unauthorized: ['服务验证失败。', '请核对 API Key 和接口地址。'],
  http_forbidden: ['服务拒绝了请求。', '请检查账号、模型访问权限和接口地址。'],
  rate_limited: ['请求过于频繁，或配额受限。', '请检查服务配额，等待限制解除。'],
  http_error: ['服务返回异常。', '请稍后重新检查；持续失败时联系服务方。'],
  invalid_response: ['服务返回的内容无法识别。', '请核对接口地址；持续失败时复制日志反馈。'],
  empty_response: ['模型未返回可用内容。', '请核对接口地址和模型名称。'],
  response_too_large: ['服务响应超出大小限制。', '请核对接口地址；仍失败时复制日志反馈。'],
  verification_failed: ['安装文件检查未通过。', '请查看校验日志，暂勿使用此安装包。'],
  process_failed: ['后台任务未完成。', '请复制本次日志反馈，保留现有安装和数据。'],
  renderer_gone: ['启动器窗口意外关闭了。', '请重新打开启动器，检查任务状态。'],
};
const business = {
  MODEL_KEY_INVALID: ['API Key 格式不正确。', '', '请从服务商后台重新复制 API Key；本地免鉴权服务请选择“无需鉴权”。'],
  MODEL_SETUP_REQUIRED: ['模型尚未配置完成。', '', '请在启动器中配置并验证模型，再启动诺拉。'],
  CLAWCHAT_PAIR_REQUIRED: ['ClawChat 尚未连接。', '', '请在启动器中连接 ClawChat，再启动诺拉。'],
  CLAWCHAT_CONNECT_TIMEOUT: ['诺拉已启动，ClawChat 尚未连通。', '', '请检查网络和代理；配对码失效时重新获取并配对。'],
  MODEL_CONFIG_PARTIAL: ['模型配置已保存，后续检查未完成。', '', '请先重新查询状态，无需再次提交配置。'],
  INSTALLER_STATE_WRITE_FAILED: ['操作记录未能保存。', '部分步骤可能已执行。', '请先重新查询状态，勿重复更新或删除安装目录。'],
  TAVERN_OWNERSHIP: ['无法确认酒馆进程归属。', '启动器没有接管或结束这个进程。', '请保留当前进程和日志，勿按提示中的 PID 强行结束程序。'],
  GATEWAY_IDENTITY: ['无法确认诺拉后台进程。', '', '请重启电脑后重新检查；仍失败时复制日志，勿强行结束未知进程。'],
  TAVERN_PORT_OCCUPIED: ['酒馆端口已被占用。', '', '请检查是否已有酒馆运行，勿强行结束未知程序。'],
  TAVERN_UNHEALTHY: ['酒馆启动检查未通过。', '', '请复制本次日志反馈，暂勿重复安装。'],
  TAVERN_START_TIMEOUT: ['酒馆启动超时。', '等待120秒后，酒馆仍未就绪。', '请查看并复制本次日志，暂勿重复安装。'],
  TAVERN_PROCESS_EXITED: ['酒馆进程启动后退出了。', '', '请查看并复制本次日志，保留现有安装和数据。'],
  UPDATE_RECOVERY_REQUIRED: ['上次更新仍需恢复。', '', '请按恢复提示处理，保留安装目录和备份，勿清空重装。'],
  MODEL_SYNC_PENDING: ['酒馆配置同步未完成。', '模型配置已保存。', '请选择“继续同步”，无需重新填写 API Key。'],
  PAIR_CODE_REJECTED: ['ClawChat 配对码未被接受。', '', '请重新获取配对码，不要反复提交同一个配对码。'],
  NODE_UNAVAILABLE: ['酒馆运行环境不可用。', '', '请用对应系统的完整启动器安装包修复，保留原数据目录。'],
  RUNTIME_EXTRACTOR_UNAVAILABLE: ['Windows 解压工具不可用。', 'tar 和 PowerShell 均无法启动。', '请修复 Windows 系统组件或处理安全软件拦截，再重新检查。'],
  RELEASE_COMPATIBILITY: ['该发布暂时无法安装。', '安装包检查未通过，本次未开始安装。', '请核对版本要求，使用对应系统的完整发布包。'],
  RESOURCE_INCOMPLETE: ['安装包缺少程序组件。', '', '请重新下载对应系统的完整安装包，保留原数据目录。'],
  CONDITIONS_CHANGED: ['安装条件已变化。', '配置或程序文件已变化，本次停止替换。', '请退出操作同一目录的其他程序，再重新检查。'],
  LEGACY_RUNTIME_UNSUPPORTED: ['旧版运行方式需要升级。', '当前进程不支持安全接管。', '请正常退出旧版诺拉和酒馆再检查，勿强行结束未知进程。'],
  LEGACY_RECOVERY_UNSUPPORTED: ['旧版本恢复记录无法确认。', '', '请复制日志反馈，保留安装目录和备份，勿重复恢复。'],
  OPERATION_CAPABILITY_REQUIRED: ['需要更换新版启动器。', '', '请保留原数据目录，覆盖安装最新版启动器。'],
  OPERATION_CAPABILITY_INVALID: ['启动器程序身份无法确认。', '', '请保留原数据目录，覆盖安装最新版启动器。'],
  OPERATION_ENTRY_UNSUPPORTED: ['此维护入口不能直接运行。', '', '请使用新版启动器；无法打开时，保留数据并覆盖安装。'],
  OPERATION_EXECUTOR_UNCONFIRMED: ['上次任务状态尚未确认。', '', '请等待任务结束后查询状态，勿重复启动任务。'],
  OPERATION_SNAPSHOT_CHANGED: ['操作状态已变化。', '', '请重新查询状态。'],
  OPERATION_BUSY: ['另一个任务正在进行。', '', '请等待当前任务结束。'],
  OPERATION_RECORD_INVALID: ['操作记录无法读取或确认。', '', '请复制日志反馈，勿删除安装目录或恢复记录。'],
  OPERATION_HISTORY_CAPACITY: ['诊断与操作记录容量已满。', '新任务未开始；恢复记录、待发送诊断和备份仍保留。', '请复制日志反馈。'],
  RELEASE_EXECUTOR_INCOMPATIBLE: ['线上发布与当前启动器不兼容。', '当前安装和数据未修改。', '请等待兼容版本发布，勿反复重试。'],
  UNINSTALL_PARENT_UNCONFIRMED: ['卸载暂未开始。', '无法确认启动器进程身份，文件未删除。', '请重新打开新版启动器后再卸载。'],
  UNINSTALL_RECOVERY_REQUIRED: ['请先处理未完成的恢复。', '卸载尚未开始。', '请先恢复旧版本；无法恢复时复制日志反馈。'],
  RETRY_CONDITIONS_UNCHANGED: ['连续失败，已暂停重试。', '', '请先处理失败原因，再点击“重新检查”。'],
  RUNTIME_PARTIAL_UNCONFIRMED: ['上次诺拉安装尚未完成确认。', '', '请先处理恢复提示，保留安装目录和备份。'],
  RUNTIME_IDENTITY_UNKNOWN: ['诺拉程序目录身份无法确认。', '', '请重新检查原安装目录，保留文件和备份。'],
  LAUNCHER_RECOVERY_REQUIRED: ['启动器更新仍需恢复。', '', '请先按提示恢复旧启动器。'],
  LOG_OPEN_FAILED: ['无法打开日志。', '', '请重新打开启动器后查看，保留原始日志。'],
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
    if (userCode === 'GATEWAY_IDENTITY' && context.action === 'status') return {
      title:'诺拉后台状态暂时无法确认。',
      detail:'后台进程信息暂时无法读取。',
      next:'正在自动查询；持续失败时复制日志，勿强行结束未知进程。',
    };
    const [title, fallback, defaultNext] = business[userCode];
    const safetyCause = userCode === 'MODEL_CONFIG_PARTIAL' && chain.map(value => value.userCode || value.code)
      .find(code => code !== userCode && Object.hasOwn(business, code));
    const next = safetyCause ? business[safetyCause][2] : defaultNext;
    const detail = userCode === 'RELEASE_COMPATIBILITY' ? readable || fallback : fallback;
    return { title, detail, next };
  }
  const technical = describeError(error, context);
  if (technical.error_code === 'network' && isProxyConnectionFailure(error, context)) return {
    title:'无法连接系统代理。',
    detail:'',
    next:'请检查系统代理设置和代理程序，再重新检查。',
  };
  const known = guidance[technical.error_code];
  if (known) {
    let [title, recommendation] = known;
    let next = recommendation;
    const model = technical.error_source === 'model_service';
    const release = technical.error_source === 'release_service';
    const releaseName = context.action === 'install' || technical.error_site === 'release.download' ? '下载服务' : '更新服务';
    if (technical.error_code === 'timeout') {
      title = model ? '模型响应超时。' : release ? context.action === 'check_update' ? '检查更新超时。'
        : technical.error_site === 'release.download' ? '资源下载超时。' : '安装资源请求超时。' : `${operation}等待超时。`;
      if (release) next = '请检查网络或代理后重新检查。';
    }
    if (model && ['dns_failed','network','timeout','tls_failed'].includes(technical.error_code))
      next = '请核对模型接口地址、网络和代理；本地模型需先启动服务。';
    if (technical.error_code === 'http_unauthorized') {
      title = model ? '模型服务验证失败（401）。' : `${release ? releaseName : '服务'}验证失败（401）。`;
      next = model ? '请核对 API Key 和接口地址后重新测试。'
        : '请重新检查；仍失败时复制日志反馈。无需修改模型 Key。';
    }
    if (technical.error_code === 'http_forbidden' && !model) {
      if (release) title = `${releaseName}拒绝了请求（403）。`;
      next = technical.error_source === 'release_service'
        ? '请检查网络或代理；仍失败时复制日志反馈。'
        : '请检查服务访问权限；仍失败时联系服务方。';
    }
    if (technical.error_code === 'connection_refused' && !model)
      next = '请确认服务已启动，并检查地址和代理。';
    if (technical.error_code === 'http_error' && technical.http_status >= 500)
      next = '服务暂时异常，请稍后重新检查。';
    if(technical.error_code==='rate_limited'&&!model){
      const delays=chain.flatMap(value=>[value.retryAfterMs,Number.isSafeInteger(value.rateLimitReset*1000)?Math.max(0,value.rateLimitReset*1000-Date.now()):undefined])
        .filter(value=>Number.isFinite(value)&&value>=0);
      const delay=delays.length?Math.max(...delays):undefined;
      title = '下载或更新服务限制了请求。';
      next=delay===undefined?'服务暂时限流，请稍后重新检查。'
        :`服务暂时限流，请在约 ${Math.max(1,Math.ceil(delay/60000))} 分钟后重新检查。`;
    }
    if (technical.error_code === 'process_failed') title = `${operation}未完成。`;
    return { title, detail: technical.error_code === 'process_failed' ? '具体原因尚未确认。' : '', next };
  }
  // Preserve short, already-readable Chinese guidance from existing business
  // guards. Technical dumps and provider text never become the main guidance.
  return { title: `${operation}未完成。`,
    detail: technical.error_source !== 'model_service' && readable || '具体原因尚未确认。',
    next: readable && technical.error_source !== 'model_service' ? '' : '请复制本次日志反馈，保留现有安装和数据。' };
}

function formatUserError(error, context) {
  const problem = presentError(error, context);
  return [...new Set([problem.title, problem.detail, problem.next].filter(Boolean))].join('\n');
}

module.exports = { presentError, formatUserError };
