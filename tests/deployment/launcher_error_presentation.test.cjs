const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { parse } = require('../installer/desktop/node_modules/acorn');
const { presentError, formatUserError } = require('../installer/desktop/error-presentation');
const { describeError, launcherError } = require('../installer/desktop/launcher-errors');
const {successResult,failureResult}=require('../installer/desktop/operation-result');

test('known technical errors show evidence-based Chinese guidance without remote dumps', () => {
  for (const code of ['EACCES','EPERM','ENOENT','ENOSPC','ENOTFOUND','ECONNREFUSED','ECONNRESET',
    'CERT_HAS_EXPIRED','TIMEOUT','ABORT_ERR','VERIFICATION_FAILED','INVALID_RESPONSE','EMPTY_RESPONSE','RESPONSE_TOO_LARGE','RENDERER_GONE']) {
    const original = Object.assign(new Error('provider said secret-key /Users/private/path\nTraceback'), {code});
    const message = formatUserError(original, {action:'install'});
    assert.ok([2,3].includes(message.split("\n").length));
    assert.ok(message.split("\n").every(line=>line.trim()));
    assert.match(message, /[\u3400-\u9fff]/);
    assert.doesNotMatch(message, /secret-key|private\/path|Traceback/);
    assert.equal(original.message, 'provider said secret-key /Users/private/path\nTraceback');
    assert.equal(original.code, code);
  }
});

test('model authentication and release-service authentication have different remedies', () => {
  const model = formatUserError({status:401,source:'model_service'}, {action:'model'});
  const release = formatUserError({status:401,source:'release_service'}, {action:'check_update'});
  assert.match(model, /核对 API Key/);
  assert.match(release, /无需修改模型 Key/);
  assert.doesNotMatch(release, /核对 API Key/);
  const releaseForbidden = formatUserError({status:403,source:'release_service'}, {action:'check_update'});
  assert.doesNotMatch(releaseForbidden, /模型访问权限/);
  assert.match(releaseForbidden, /更新服务/);
  for (const status of [403,429,500,404]) {
    const message = formatUserError({status,source:'model_service',message:'vendor private reply'});
    assert.doesNotMatch(message, /vendor private reply/);
    if (status === 403) assert.match(message, /访问权限/);
    if (status === 429) assert.match(message, /配额/);
    if (status === 500) assert.match(message, /服务暂时异常/);
  }
});
test('proven release rate limit survives wrappers and has a bounded retry recommendation',()=>{
  const original=launcherError('opaque HTTP response',{status:403,source:'release_service',site:'release.request',rateLimited:true,retryAfterMs:120000,rateLimitRemaining:0});
  const wrapper=launcherError('query failed',{},original);
  assert.equal(wrapper.rateLimited,true);
  assert.equal(describeError(wrapper).error_code,'rate_limited');
  const text=formatUserError(wrapper,{action:'check_update'});
  assert.match(text,/请求过于频繁|限流/);
  assert.match(text,/2 分钟/);
  assert.doesNotMatch(text,/API Key|模型访问权限|opaque/);
  assert.equal(describeError({status:403,source:'release_service'}).error_code,'http_forbidden');
});

test('unknown errors do not assert permissions, missing dependencies or safe rollback', () => {
  for (const message of ['(pid=5560)', 'Tavern runtime ownership differs from the saved configuration',
    'PermissionError: opaque subprocess failed', 'Traceback\n磁盘故障 WinError 5', '供应商建议删除目录']) {
    const view = presentError({message,source:'model_service',exitCode:1}, {action:'update'});
    assert.match(view.detail, /原因尚未确认/);
    assert.doesNotMatch(JSON.stringify(view), /权限不足|缺少依赖|已回滚|5560|供应商建议|WinError/);
    assert.match(view.next, /保留现有安装/);
  }
});

test('business safeguards override generic permission errors and preserve model progress', () => {
  const gateway = {code:'EACCES',userCode:'GATEWAY_IDENTITY'};
  assert.match(formatUserError(gateway), /无法确认诺拉后台进程/);
  assert.match(formatUserError(gateway), /勿强行结束/);
  assert.equal(describeError(gateway).error_code, 'permission_denied');
  const cause = Object.assign(new Error('service connection refused'), {code:'ECONNREFUSED'});
  assert.match(formatUserError({userCode:'MODEL_SYNC_PENDING',cause}), /继续同步/);
  assert.match(formatUserError({userCode:'MODEL_SYNC_PENDING',cause}), /无需重新填写/);
  assert.match(formatUserError({code:'TAVERN_PORT_OCCUPIED'}), /未知程序/);
  assert.match(formatUserError({code:'TAVERN_OWNERSHIP'}), /没有接管或结束/);
  assert.match(formatUserError({userCode:'RUNTIME_EXTRACTOR_UNAVAILABLE',code:'ENOENT'}), /Windows 解压工具不可用/);
  assert.match(formatUserError({userCode:'UPDATE_RECOVERY_REQUIRED'}), /勿清空重装/);
  assert.match(formatUserError({userCode:'PAIR_CODE_REJECTED'}), /不要反复提交/);
  assert.match(formatUserError({code:'NODE_UNAVAILABLE'}), /完整启动器安装包/);
});

test('a proven Tavern process exit is explained without guessing its cause', () => {
  const message = formatUserError({code:'TAVERN_PROCESS_EXITED',message:'opaque native traceback'}, {action:'install'});
  assert.match(message, /酒馆进程启动后退出/);
  assert.match(message, /保留现有安装和数据/);
  assert.doesNotMatch(message, /opaque|traceback|网络故障|权限不足|缺少依赖|已经回滚/);
});

test('IPC boundary formats before Electron drops fields, preserving original diagnostic error', async () => {
  const source = fs.readFileSync(path.join(__dirname,'../installer/desktop/main.js'),'utf8');
  let declaration;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclarator' && node.id.name === 'handle') declaration = node;
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
  }
  visit(parse(source,{ecmaVersion:'latest'}));
  const handlers = new Map(), reports = [], localErrors = [];
  const root = '/fixture';
  const context = vm.createContext({require,path,installerRoot:()=>root,MOCK_SCENARIO:false,
    uninstalling:false,quitting:false,selectingLocation:false,formatUserError,successResult,failureResult,
    ipcMain:{handle:(id,fn)=>handlers.set(id,fn)}, telemetry:{report:e=>reports.push(e)},
    diagnostics:{error:(event,error,fields)=>localErrors.push({event,error,fields})}});
  const register = vm.runInContext(`(${source.slice(declaration.init.start,declaration.init.end)})`,context);
  const original = Object.assign(new Error('raw system dump fixture'), {code:'ENOSPC'});
  register('nora:open-directory',async()=>{throw original;});
  const frame = {url:require('node:url').pathToFileURL(path.join(root,'launcher-conversation-prototype.html')).href};
  const response=await handlers.get('nora:open-directory')({senderFrame:frame,sender:{mainFrame:frame}});
  assert.equal(response.ok,false);assert.equal(response.error.failureCode,'disk_full');
  assert.match(response.error.guidance.title,/磁盘空间不足/);assert.doesNotMatch(JSON.stringify(response),/raw system dump/);
  assert.equal(reports[0], original);
  assert.equal(localErrors[0].error, original);
  assert.equal(localErrors[0].event, 'launcher.ui-failed');
  assert.deepEqual(localErrors[0].fields.channel, 'nora:open-directory');
  assert.equal(original.message,'raw system dump fixture');
});

test('timeout guidance distinguishes download, release checks and models without inventing a network cause',()=>{
  assert.equal(presentError({code:'TIMEOUT',source:'release_service',site:'release.download'},{action:'update'}).title,'资源下载超时。');
  assert.equal(presentError({code:'TIMEOUT',source:'release_service',site:'release.request'},{action:'check_update'}).title,'检查更新超时。');
  assert.equal(presentError({code:'TIMEOUT',source:'model_service'},{action:'model'}).title,'模型响应超时。');
  const unknown=formatUserError({code:'TIMEOUT',source:'launcher_process'},{action:'start'});
  assert.match(unknown,/启动等待超时/);assert.doesNotMatch(unknown,/GitHub|磁盘故障|已经回滚/);
});

test('Tavern readiness timeout survives a process wrapper and directs users to the current log',()=>{
  const original=Object.assign(new Error('native health check timed out after 120.0s; raw local health result'),
    {code:'TAVERN_START_TIMEOUT'});
  const wrapper=launcherError('maintenance failed',{exitCode:1},original);
  const view=presentError(wrapper,{action:'install'});
  assert.equal(view.title,'酒馆启动超时。');
  assert.equal(view.detail,'等待120秒后，酒馆仍未就绪。');
  assert.match(view.next,/本次日志/);
  assert.doesNotMatch(JSON.stringify(view),/GitHub|代理|Defender|raw local|具体原因尚未确认/);
  const result=failureResult(wrapper,{action:'install'});
  assert.equal(result.error.userCode,'TAVERN_START_TIMEOUT');
  assert.deepEqual(result.error.allowedActions,['recheck','logs']);
  const recovery={state:'failed',effectState:'unknown',allowedActions:['recover','logs']};
  assert.deepEqual(failureResult(wrapper,{action:'update',operation:recovery}).error.allowedActions,['recover','logs']);
});

test('renderer separates title from steps and suppresses legacy raw exceptions', () => {
  const source = fs.readFileSync(path.join(__dirname,'../installer/launcher-controller.js'),'utf8');
  const statements = parse(source,{ecmaVersion:'latest'}).body[0].expression.callee.body.body;
  const text = statements.find(n=>n.declarations?.some(d=>d.id.name==='textError'));
  const copy = statements.find(n=>n.id?.name==='errorCopy');
  const context = vm.createContext({});
  vm.runInContext(source.slice(text.start,text.end)+'\n'+source.slice(copy.start,copy.end),context);
  context.message = formatUserError({code:'ENOSPC'}, {action:'install'});
  const view = vm.runInContext('errorCopy({message})',context);
  assert.equal(view.title,'磁盘空间不足。'); assert.match(view.detail,/清理安装盘/);
  context.message = 'Error invoking remote method \'nora:run\': Error: Traceback opaque exception';
  assert.match(vm.runInContext('textError({message})',context),/原因尚未确认/);
  assert.doesNotMatch(vm.runInContext('textError({message})',context),/opaque|Traceback/);
});

test('short local validation guidance remains actionable and the new module ships', () => {
  assert.match(formatUserError(new Error('接口地址不能包含查询参数或片段，请填写基础地址。')),/填写基础地址/);
  assert.ok(require('../installer/desktop/package.json').build.files.includes('error-presentation.js'));
});

test('blocked release guidance retains the required version and suppresses English dumps', () => {
  const result = formatUserError({userCode:'RELEASE_COMPATIBILITY',source:'release_service',
    message:'请先升级启动器到 1.2.0 或更新版本。'}, {action:'check_update'});
  assert.match(result,/1\.2\.0/); assert.match(result,/该发布/); assert.match(result,/完整发布包/);
  const opaque = formatUserError({userCode:'RELEASE_COMPATIBILITY',message:'Traceback unknown manifest failure'});
  assert.doesNotMatch(opaque,/Traceback/); assert.match(opaque,/未开始安装/);
});

test('returned release failures retain the original local diagnosis before UI formatting', async () => {
  const source = fs.readFileSync(path.join(__dirname,'../installer/desktop/main.js'),'utf8');
  let callback;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee.name === 'handle' && node.arguments[0]?.value === 'nora:check-update') callback = node.arguments[1];
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
  }
  visit(parse(source,{ecmaVersion:'latest'}));
  const reports = [], result = {state:'blocked',compatibilityError:'请先升级启动器到 1.2.0 或更新版本。',
    diagnosticError:launcherError('', {userCode:'RELEASE_COMPATIBILITY',source:'release_service'},
      new Error('请先升级启动器到 1.2.0 或更新版本。'))};
  const original = result.diagnosticError;
  const context = vm.createContext({activeRun:false,modelBusy:false,trackLauncher:async(_action,_stage,fn)=>fn(),
    releases:{check:async()=>result},updateFetch:null,installRoot:()=>'/fixture',app:{getVersion:()=> '1.0.0'},
    CHANNEL:'stable',formatUserError,diagnostics:{error:(event,error)=>reports.push({event,error})}});
  const check = vm.runInContext(`(${source.slice(callback.start,callback.end)})`,context);
  const returned = await check();
  assert.equal(reports.length,0,'the tracked check must not append its error to an unrelated operation');
  assert.equal(returned.state,'blocked');
  assert.match(returned.compatibilityError,/该发布暂时无法安装/);
  assert.match(returned.compatibilityError,/1\.2\.0/);
  assert.equal(original.message,'');
  assert.equal(original.cause.message,'请先升级启动器到 1.2.0 或更新版本。');
  for (const evidence of [{status:403},{code:'TIMEOUT'}]) {
    result.compatibilityError = 'raw manifest request failure';
    result.diagnosticError = launcherError('raw manifest request failure', {source:'release_service',...evidence});
    const response = await check();
    assert.doesNotMatch(response.compatibilityError,/先升级启动器|核对版本要求/);
    assert.match(response.compatibilityError,evidence.status ? /更新服务拒绝了请求/ : /检查更新超时/);
  }
});

test('status polling preserves the first raw failure and avoids repeated log floods', () => {
  const source = fs.readFileSync(path.join(__dirname,'../installer/desktop/main.js'),'utf8');
  const declaration = parse(source,{ecmaVersion:'latest'}).body.find(n=>n.id?.name==='statusErrorMessage');
  const reports = [], context = vm.createContext({formatUserError,lastStatusError:'',
    diagnostics:{error:(event,error)=>reports.push({event,error})}});
  const format = vm.runInContext(`(${source.slice(declaration.start,declaration.end)})`,context);
  const original = Object.assign(new Error('opaque runtime ownership fixture'), {code:'TAVERN_OWNERSHIP'});
  assert.match(format(original),/无法确认酒馆进程归属/);
  format(original); assert.equal(reports.length,1); assert.equal(reports[0].error,original);
  context.lastStatusError = ''; // A successful status resets the warning episode.
  format(original); assert.equal(reports.length,2);
});

test('gateway status permission failures describe unknown state without asserting startup or shutdown', () => {
  const error = Object.assign(new Error('opaque permission fixture'), {code:'EACCES',userCode:'GATEWAY_IDENTITY'});
  const message = formatUserError(error,{action:'status'});
  assert.match(message,/状态.*无法确认/);
  assert.doesNotMatch(message,/已停止|本次未启动|未启动第二个|读写权限|opaque/);
});
test('partial model configuration states saved facts while retaining a more precise safety next step',()=>{
  const partial=launcherError('opaque final check failed',{userCode:'MODEL_CONFIG_PARTIAL'},Object.assign(new Error('opaque OS error'),{code:'EPERM',userCode:'INSTALLER_STATE_WRITE_FAILED'}));
  const text=formatUserError(partial,{action:'model'});assert.match(text,/模型配置已保存，后续检查未完成/);assert.match(text,/无需再次提交|先重新查询状态/);assert.match(text,/勿直接重复更新|先重新查询状态/);assert.doesNotMatch(text,/opaque|已回滚/);
  const ownership=launcherError('opaque',{userCode:'MODEL_CONFIG_PARTIAL'},launcherError('opaque',{userCode:'GATEWAY_IDENTITY'}));assert.match(formatUserError(ownership,{action:'model'}),/勿强行结束/);
});

test('proven Chromium proxy connection failure uses network guidance without inventing a system code',()=>{
  // Shape of the received v2.0.2 fault: check wrapper -> request wrapper -> Electron error.
  const native = new Error('net::ERR_PROXY_CONNECTION_FAILED');
  const request = launcherError(native.message,{source:'release_service',site:'release.request'},native);
  const fault = launcherError('',{source:'release_service',site:'release.request'},request);
  const technical = describeError(fault);
  assert.equal(technical.error_code,'network');
  assert.equal(technical.system_code,'');
  assert.equal(fault.cause,request);assert.equal(request.cause,native);
  const guidance = formatUserError(fault,{action:'check_update'});
  assert.match(guidance,/无法连接系统代理/);assert.match(guidance,/系统代理设置和代理程序/);
  assert.doesNotMatch(guidance,/net::|API Key|已回滚|关闭安全校验/);
  assert.equal(native.message,'net::ERR_PROXY_CONNECTION_FAILED');assert.equal(native.code,undefined);
  for (const error of [
    {message:native.message,source:'model_service',site:'model.test'},
    {message:native.message},
    {message:'provider response: '+native.message,source:'release_service',site:'release.request'},
    {message:native.message+' trailing response',source:'release_service',site:'release.request'},
    {message:native.message,source:'release_service',site:'release.verify'},
  ]) {
    assert.equal(describeError(error).error_code,'unknown');
    assert.doesNotMatch(formatUserError(error),/无法连接系统代理/);
  }
});

test('proven ClawChat connection timeout preserves the running Nora fact before generic child exit guidance',()=>{
  const child=Object.assign(new Error('Nora 已启动，但 ClawChat 未在一分钟内连通。请检查网络或重新配对。'),{userCode:'CLAWCHAT_CONNECT_TIMEOUT'});
  const wrapper=launcherError(child.message,{source:'launcher_process',site:'process.start',exitCode:1},child);
  assert.equal(describeError(wrapper).error_code,'process_failed');
  const text=formatUserError(wrapper,{action:'start'});
  assert.match(text,/诺拉已启动，ClawChat 尚未连通/);assert.equal(text.split("\n").length,2);
  assert.match(text,/检查网络和代理/);assert.match(text,/配对码失效时重新获取并配对/);assert.doesNotMatch(text,/请.*卸载重装/);
  assert.doesNotMatch(text,/具体原因尚未确认|已停止|已回滚|结束进程|必须重新配对/);
  assert.equal(wrapper.cause,child);assert.equal(wrapper.exitCode,1);
});
