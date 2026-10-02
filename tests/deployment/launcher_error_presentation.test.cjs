const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { parse } = require('../installer/desktop/node_modules/acorn');
const { presentError, formatUserError } = require('../installer/desktop/error-presentation');
const { describeError, launcherError } = require('../installer/desktop/launcher-errors');

test('known technical errors show evidence-based Chinese guidance without remote dumps', () => {
  for (const code of ['EACCES','EPERM','ENOENT','ENOSPC','ENOTFOUND','ECONNREFUSED','ECONNRESET',
    'CERT_HAS_EXPIRED','TIMEOUT','ABORT_ERR','VERIFICATION_FAILED','INVALID_RESPONSE','EMPTY_RESPONSE','RESPONSE_TOO_LARGE','RENDERER_GONE']) {
    const original = Object.assign(new Error('provider said secret-key /Users/private/path\nTraceback'), {code});
    const message = formatUserError(original, {action:'install'});
    assert.equal(message.split('\n').length, 3);
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
    uninstalling:false,quitting:false,selectingLocation:false,formatUserError,
    ipcMain:{handle:(id,fn)=>handlers.set(id,fn)}, telemetry:{report:e=>reports.push(e)},
    diagnostics:{error:(event,error,fields)=>localErrors.push({event,error,fields})}});
  const register = vm.runInContext(`(${source.slice(declaration.init.start,declaration.init.end)})`,context);
  const original = Object.assign(new Error('raw system dump fixture'), {code:'ENOSPC'});
  register('nora:open-directory',async()=>{throw original;});
  const frame = {url:require('node:url').pathToFileURL(path.join(root,'launcher-conversation-prototype.html')).href};
  await assert.rejects(handlers.get('nora:open-directory')({senderFrame:frame,sender:{mainFrame:frame}}), e=>{
    assert.match(e.message,/磁盘空间不足/); assert.doesNotMatch(e.message,/raw system dump/); return true;
  });
  assert.equal(reports[0], original);
  assert.equal(localErrors[0].error, original);
  assert.equal(localErrors[0].event, 'launcher.ui-failed');
  assert.deepEqual(localErrors[0].fields.channel, 'nora:open-directory');
  assert.equal(original.message,'raw system dump fixture');
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
  assert.equal(reports[0].error, original);
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
    assert.match(response.compatibilityError,evidence.status ? /更新服务拒绝访问/ : /等待后台响应超时/);
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
