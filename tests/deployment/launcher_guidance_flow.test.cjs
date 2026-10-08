const {test} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '../installer');
const source = fs.readFileSync(path.join(root, 'launcher-controller.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'launcher-conversation-prototype.html'), 'utf8');
const {parse} = require(path.join(root, 'desktop/node_modules/acorn'));
const {formatUserError} = require(path.join(root, 'desktop/error-presentation.js'));
const statements = parse(source, {ecmaVersion:'latest'}).body[0].expression.callee.body.body;
function definition(name) {
  const node = statements.find(n => n.id?.name === name || n.expression?.left?.name === name || n.declarations?.some(d => d.id.name === name));
  assert.ok(node, `actual source definition exists: ${name}`);
  return source.slice(node.start, node.end);
}
function descendants(node) {
  return (node?.children || []).flatMap(child => typeof child === 'object' ? [child, ...descendants(child)] : []);
}
function element(tag='div') {
  const n = {tagName:tag.toUpperCase(), children:[], value:'', dataset:{}, hidden:false, disabled:false, style:{}, className:'',
    append(...items){for(const i of items)if(i&&typeof i==='object')i.parentElement=this;this.children.push(...items);}, prepend(...items){for(const i of items)if(i&&typeof i==='object')i.parentElement=this;this.children.unshift(...items);},
    replaceChildren(...items){this.children=[...items];}, setAttribute(name,value){this[name]=String(value);},
    querySelectorAll(selector){return descendants(this).filter(c => selector.split(',').some(part => part[0]==='.' ? c.classList.contains(part.slice(1)) : part[0]==='#' ? c.id===part.slice(1) : part==='button[type="submit"]' ? c.tagName==='BUTTON' && c.type==='submit' : c.tagName===part.toUpperCase()));},
    closest(selector){for(let c=this;c;c=c.parentElement)if(selector[0]==='.'&&c.classList.contains(selector.slice(1)))return c;return null;},
    querySelector(selector){return this.querySelectorAll(selector)[0] || null;}};
  n.classList = {contains(name){return n.className.split(/\s+/).includes(name);},
    add(...names){n.className=[...new Set([...n.className.split(/\s+/).filter(Boolean),...names])].join(' ');},
    remove(...names){n.className=n.className.split(/\s+/).filter(name=>!names.includes(name)).join(' ');},
    toggle(name,force){const add=force??!this.contains(name);this[add?'add':'remove'](name);return add;}};
  let text='';
  Object.defineProperty(n,'textContent',{get(){return text+n.children.map(c=>typeof c==='string'?c:c.textContent||'').join('');},set(value){text=String(value);n.children=[];}});
  Object.defineProperty(n,'innerHTML',{set(value){
    n.children=[];const stack=[n];
    for(const token of String(value).match(/<[^>]+>|[^<]+/g)||[]){
      if(token.startsWith('</')){if(stack.length>1)stack.pop();continue;}
      if(token.startsWith('<')){
        const tag=token.match(/^<([a-z]+)/i)?.[1];if(!tag)continue;const child=element(tag);
        for(const a of token.matchAll(/([a-z][a-z0-9-]*)=(?:"([^"]*)"|'([^']*)')/gi)){const key=a[1],val=a[2]??a[3];if(key==='class')child.className=val;else child[key]=val;}
        child.hidden=/\shidden(?:\s|>)/.test(token);stack.at(-1).append(child);
        if(!['input','img','br','hr','meta','link'].includes(tag))stack.push(child);
      }else stack.at(-1).append(token);
    }
  }});
  return n;
}
function fixture(extra={}) {
  const elements=new Map(), copies=[], calls=[];
  const inline=element();elements.set('inline',inline);
  const menuHtml=html.slice(html.indexOf('<div class="management"'),html.indexOf('<div class="launchbar"'));
  const menu=[...menuHtml.matchAll(/<button([^>]*)>(.*?)<\/button>/gs)].map(m=>{
    const n=element('button');n.textContent=m[2].replace(/<[^>]+>/g,'');
    const action=m[1].match(/data-action="([^"]+)"/);if(action)n.dataset.action=action[1];
    const id=m[1].match(/id="([^"]+)"/);if(id){n.id=id[1];elements.set(n.id,n);}return n;
  });
  const $=id=>{
    const nested=descendants(inline).find(n=>n.id===id);if(nested)return nested;
    if(['versionNotice','logFeedback','recoverUpdate'].includes(id))return null;
    if(!elements.has(id)){const n=element();if(id==='launch')n.append(element('span'));elements.set(id,n);}return elements.get(id);
  };
  const button=(text,onclick,primary=true)=>Object.assign(element('button'),{textContent:text,onclick,className:primary?'button primary':'button'});
  const context=vm.createContext({snapshot:{},view:'daily',busy:false,statusUnknown:false,launcherRecoveryConfirmed:false,daily:false,running:false,stage:0,
    activeAction:'',activeService:'all',lastFailure:null,lastStatusError:'',lastStatusAt:0,taskTimer:null,logsOpen:false,operationCancelled:false,versionInfo:null,autoVersionChecked:false,
    versionChecking:false,modelFormGeneration:0,pageReturnFocus:null,firstCompletionPending:false,sawIncompleteSetup:false,autoStartAttempted:true,bundledUpgradeAttempted:false,
    launchHint:element(),labels:['Nora','酒馆','模型','ClawChat','检查'],milestoneStates:[],currentTask:'',startedAt:0,lastEvent:0,taskStage:'',stageStartedAt:0,taskProgress:null,lastProgressAt:0,alive:true,refreshing:false,pollTimer:null,launchHint:element(),api:{openLogs:async()=>{calls.push(['logs']);return {ok:true};}},$,button,
    document:{createElement:element,createTextNode:value=>String(value),querySelector:selector=>inline.querySelector(selector),querySelectorAll:selector=>{
      if(selector==='#management [data-action]')return menu.filter(n=>n.dataset.action);
      if(selector.includes('[data-action]'))return menu;
      return descendants(inline).filter(n=>n.tagName==='BUTTON');
    }},
    clearInline(){inline.replaceChildren();},say:(...args)=>copies.push(args),setupStage(){},
    taskView(action){context.view='task';},dailyHome(){context.view='daily';},poll(){calls.push(['poll']);},
    editHeader(){},install(){calls.push(['install']);},pendingModel(){context.view='model-pending';},modelForm(){context.view='model';},clawForm(){context.view='claw';},
    onEvent(){},updateTask(){},clearInterval(){},setInterval:()=>1,clearTimeout(){},setTimeout:()=>1,wait:async()=>{},matchMedia:()=>({matches:true}),...extra});
  const definitions=statements.filter(n=>n.type==='FunctionDeclaration'||n.declarations?.some(d=>d.id.name==='textError')||['modelForm','clawForm','install','closeEdit'].includes(n.expression?.left?.name));
  vm.runInContext(definitions.map(n=>source.slice(n.start,n.end)).join('\n'),context);
  for(const n of statements){
    const call=n.expression;
    if(call?.type==='CallExpression'&&call.callee.property?.name==='forEach'&&call.callee.object?.callee?.property?.name==='querySelectorAll'&&call.callee.object.arguments[0]?.value==='[data-action]')vm.runInContext(source.slice(n.start,n.end),context);
  }
  return {context,menu,elements,copies,calls,inline,async invoke(expression){return await vm.runInContext(expression,context);},
    output(){return {view:context.view,statusUnknown:context.statusUnknown,copy:copies.at(-1)||[],inlineText:inline.textContent,
      buttons:descendants(inline).filter(n=>n.tagName==='BUTTON').map(n=>({text:n.textContent,disabled:n.disabled})),
      managementVisible:!$('management').hidden,menu:menu.map(n=>({text:n.textContent,action:n.dataset.action||null,hidden:n.hidden,disabled:n.disabled}))};}};
}

const ready={installed:true,hermesInstalled:true,setupCompleted:true,systemReady:true,version:'2.4.2',running:true,gatewayRunning:true,clawchatConnected:true};
const network=formatUserError({code:'TIMEOUT',source:'release_service'},{action:'update'});
const updateResult={state:'available',available:true,updateSupported:true,current:'2.4.2',latest:'v2.4.3',channel:'stable'};
function action(h,label){return descendants(h.inline).find(n=>n.tagName==='BUTTON'&&n.textContent===label);}
test('unknown process failure reaches actual logs without clearing the error page',async()=>{
  const h=fixture({snapshot:{...ready}});h.context.original=formatUserError({source:'launcher_process',exitCode:1},{action:'update'});
  await h.invoke('fail(original,"update",()=>{})');const logs=action(h,'查看日志');assert.ok(logs);const before=h.output().copy;
  await logs.onclick({currentTarget:logs});assert.deepEqual(h.calls,[['logs']]);assert.deepEqual(h.output().copy,before);assert.equal(h.context.view,'error');
  const menu=h.menu.find(n=>n.dataset.action==='logs');assert.ok(menu);assert.equal(menu.hidden,false);await menu.onclick();assert.equal(h.calls.length,2);
});

test('history capacity explains preserved transactions and offers logs without an ineffective retry',async()=>{
  const {presentError}=require(path.join(root,'desktop/error-presentation.js'));
  const guidance=presentError({code:'OPERATION_HISTORY_CAPACITY'},{action:'install'});
  assert.match(guidance.title,/记录.*容量已满/);assert.match(guidance.detail,/未开始.*恢复记录.*待发送诊断.*备份/);
  assert.match(guidance.next,/复制日志反馈/);assert.doesNotMatch(guidance.next,/重试|清空|删除/);
  const h=fixture({snapshot:{...ready}});
  h.context.capacity=Object.assign(new Error('technical fixture'),{guidance,userCode:'OPERATION_HISTORY_CAPACITY',allowedActions:['logs']});
  await h.invoke('fail(capacity,"install",()=>{})');
  assert.equal(action(h,'重试'),undefined);const logs=action(h,'查看日志');assert.ok(logs);
  await logs.onclick({currentTarget:logs});assert.deepEqual(h.calls,[['logs']]);
});
test('unknown-version repair has a working log action while repair remains disabled',async()=>{
  const h=fixture({snapshot:{installed:true,hermesInstalled:true,systemReady:false,version:''}});await h.invoke('route()');
  assert.equal(action(h,'修复当前安装').disabled,true);const logs=action(h,'查看日志');assert.ok(logs);await logs.onclick({currentTarget:logs});assert.deepEqual(h.calls,[['logs']]);
});
test('unavailable check gives matching failure title, direct retry, and leaves running services untouched',async()=>{
  let checks=0;const h=fixture({snapshot:{...ready},api:{openLogs:async()=>({ok:true}),checkUpdate:async()=>{checks++;return {state:'unavailable',available:false,current:'2.4.2',latest:'v2.4.3',error:network};}}});
  await h.invoke('checkUpdates()');assert.match(h.output().copy[0],/超时/);assert.ok(action(h,'重新检查更新'));await action(h,'重新检查更新').onclick();assert.equal(checks,2);assert.equal(h.context.snapshot.running,true);
});
test('update-query network guidance requires the actual failure class and an available Nora',async()=>{
  for(const [snapshot,failureCode,expected] of [
    [{...ready,modelConfigured:true},'timeout',true],
    [{...ready,modelConfigured:true},'verification_failed',false],
    [{...ready,modelConfigured:true,gatewayRunning:false},'timeout',false],
    [{...ready,modelConfigured:true,updateRecovery:{canRecover:true}},'timeout',false],
    [{...ready,modelConfigured:false},'timeout',false]]){
    const h=fixture({snapshot,api:{checkUpdate:async()=>({state:'unavailable',error:network,failureCode})}});
    await h.invoke('checkUpdates()');
    assert.equal(h.output().copy.join('\n').includes('网络恢复后，也可对诺拉说'),expected);
  }
});
test('a release failure log button opens the readonly check identity instead of the prior installation',async()=>{
  const checkId='22222222-2222-4222-8222-222222222222';let requested;
  const h=fixture({snapshot:{...ready,operation:{operationId:'11111111-1111-4111-8111-111111111111',state:'succeeded'}},
    api:{operationLogs:async()=>({}),checkUpdate:async()=>({state:'blocked',available:false,logOperationId:checkId,
      compatibilityError:'线上发布与当前启动器不兼容。\n请等待兼容版本发布。'})}});
  h.context.openLogs=async(event,id)=>{requested=id;};await h.invoke('checkUpdates()');
  const logs=action(h,'查看日志');await logs.onclick({currentTarget:logs});assert.equal(requested,checkId);
  assert.equal(action(h,'安装更新'),undefined);assert.equal(action(h,'重新检查更新'),undefined);
});
test('background notice reports unavailable check rather than incompatible release',async()=>{
  const h=fixture({snapshot:{...ready},api:{checkUpdate:async()=>({state:'unavailable',available:false,error:network})}});await h.invoke('renderServices(); checkVersionsInBackground()');assert.match(h.inline.textContent,/检查更新未完成/);assert.doesNotMatch(h.inline.textContent,/不可用于完整安装/);
});
test('a failed update and failed status preserve the primary cause and cannot replay or recover from stale facts',async()=>{
  let updates=0,recoveries=0;const h=fixture({snapshot:{...ready},api:{openLogs:async()=>({ok:true}),update:async()=>{updates++;h.context.snapshot.updateRecovery={canRecover:true,backup:'/fixture/backup'};throw Error('组件校验失败，更新没有完成。');},status:async()=>{throw Error('状态查询暂时失败。');},recover:async()=>{recoveries++;}}});
  await h.invoke('run("update",{tag:"v2.4.3"})');assert.match(h.output().copy.join('\n')+h.inline.textContent,/组件校验失败/);assert.match(h.output().copy.join('\n')+h.inline.textContent,/状态/);assert.equal(h.context.statusUnknown,true);
  assert.equal(action(h,'重试'),undefined);assert.equal(action(h,'恢复旧版本'),undefined);assert.ok(action(h,'重新查询状态'));assert.ok(action(h,'查看日志'));
  await h.invoke('run("update",{tag:"v2.4.3"})');await h.invoke('run("recover")');assert.equal(updates,1);assert.equal(recoveries,0);
});
function structuredFailure({title='任意清晰错误。',actions=['recheck','logs'],attempt=2,kind='update',code='NETWORK'}={}) {
  const operation={operationId:'fixture-operation',snapshotSequence:attempt,state:'failed',kind,attempt,
    effectState:'untouched',verification:'failed',allowedActions:actions,primaryFailure:{code,guidance:{title,detail:'本次操作没有完成，数据已保留。',next:'请先检查当前条件。'}}};
  return Object.assign(new Error('raw fixture must not be displayed'),{guidance:operation.primaryFailure.guidance,
    failureCode:'timeout',userCode:code,allowedActions:actions,operation});
}
test('typed setup blockers open the existing configuration forms instead of repeating startup',async()=>{
  for(const [code,label,handler] of [['MODEL_SETUP_REQUIRED','配置模型','modelForm'],
    ['CLAWCHAT_PAIR_REQUIRED','连接 ClawChat','clawForm']]){
    const {failureResult}=require(path.join(root,'desktop/operation-result.js'));
    const operation={operationId:'setup-operation',snapshotSequence:2,kind:'start',state:'failed',effectState:'untouched',allowedActions:[]};
    const result=failureResult({code},{action:'start',operation});
    const h=fixture({snapshot:{...ready,setupCompleted:false,operation:result.error.operation}});
    let opened=0;h.context[handler]=()=>{opened++;};h.context.original=result.error;
    await h.invoke('fail(original,"start",()=>{throw new Error("blind retry")})');
    assert.equal(action(h,'重试'),undefined);assert.ok(action(h,label));
    await action(h,label).onclick();assert.equal(opened,1);
    h.context.statusUnknown=true;await h.invoke('fail(original,"start",()=>{})');
    assert.equal(action(h,label),undefined);
  }
});
test('backend actions alone control retry; readable title changes and a reopened window do not release it',async()=>{
  for(const title of ['等待后台响应超时。','组件校验失败。','这是全新的清晰文案。']) {
    const original=structuredFailure({title});
    const h=fixture({snapshot:{...ready,operation:original.operation},api:{openLogs:async()=>({ok:true}),status:async()=>({...ready,operation:original.operation})}});
    h.context.original=original;await h.invoke('route()');
    assert.equal(h.output().copy[0],title);assert.equal(action(h,'重试'),undefined);
    assert.ok(action(h,'重新检查'));assert.ok(action(h,'查看日志'));
    assert.equal(h.elements.get('status').textContent,'需要处理');
    assert.doesNotMatch(h.output().copy.join('\n'),/raw fixture/);
  }
});
test('recheck cannot release retry until backend returns that action and resume uses persistent identity',async()=>{
  const original=structuredFailure();let resumes=0,rechecks=0,authorized=false;
  const h=fixture({snapshot:{...ready,operation:original.operation},api:{openLogs:async()=>({ok:true}),
    status:async()=>({...ready,operation:h.context.snapshot.operation}),
    recheckOperation:async request=>{rechecks++;assert.equal(request.operationId,original.operation.operationId);
      return {operation:{...original.operation,snapshotSequence:3,allowedActions:authorized?['retry','recheck','logs']:['recheck','logs']}};},
    resumeOperation:async request=>{resumes++;assert.equal(request.operationId,original.operation.operationId);assert.equal(request.snapshotSequence,3);
      return {operation:{...original.operation,state:'succeeded',snapshotSequence:4,allowedActions:['recheck','logs']}};}}});
  await h.invoke('route()');await action(h,'重新检查').onclick();assert.equal(action(h,'重试'),undefined);
  authorized=true;await action(h,'重新检查').onclick();assert.ok(action(h,'重新尝试更新'));await action(h,'重新尝试更新').onclick();
  assert.equal(resumes,1);assert.equal(rechecks,2);
});
test('legacy or unknown errors only offer safe query and log actions even if their Chinese title sounds retryable',async()=>{
  const h=fixture({snapshot:{...ready}});h.context.original=Error(network);
  await h.invoke('fail(original,"update",()=>{throw Error("unsafe replay")})');
  assert.equal(action(h,'重试'),undefined);assert.ok(action(h,'重新查询状态'));assert.ok(action(h,'查看日志'));
});
test('recover rechecks current canRecover before calling the actual recovery IPC',async()=>{
  let recoveries=0;const h=fixture({snapshot:{...ready,systemReady:false,updateRecovery:{canRecover:true,backup:'/fixture/backup'}},api:{openLogs:async()=>({ok:true}),status:async()=>({...ready,systemReady:false,updateRecovery:{canRecover:false,reason:'备份检查未通过。'}}),recover:async()=>{recoveries++;}}});
  await h.invoke('route()');await action(h,'恢复旧版本').onclick();assert.equal(recoveries,0);assert.equal(action(h,'恢复旧版本'),undefined);assert.ok(action(h,'查看日志'));
});
test('recovery reason has readable guidance and retains raw evidence only in labelled details',async()=>{
  const raw='[WinError 5] Access is denied: /fixture/backup';const h=fixture({snapshot:{...ready,systemReady:false,updateRecovery:{canRecover:false,reason:raw}},api:{openLogs:async()=>({ok:true})}});await h.invoke('route()');
  assert.doesNotMatch(h.output().copy.join('\n'),/WinError/);assert.match(h.inline.textContent,/恢复检查尚未通过|恢复条件尚未确认/);assert.match(h.inline.textContent,/技术记录/);assert.ok(h.inline.textContent.includes(raw));
});
test('installer state write failure offers status verification and logs without replaying uncertain work',async()=>{
  let calls=0;const h=fixture({snapshot:{...ready},api:{openLogs:async()=>({ok:true}),update:async()=>{calls++;throw Error(formatUserError({userCode:'INSTALLER_STATE_WRITE_FAILED',code:'EPERM'},{action:'update'}));},status:async()=>({...ready})}});await h.invoke('run("update",{tag:"v2.4.3"})');
  assert.match(h.output().copy.join('\n'),/操作记录未能保存/);assert.match(h.output().copy.join('\n'),/部分步骤/);assert.equal(action(h,'重试'),undefined);assert.ok(action(h,'重新查询状态'));assert.ok(action(h,'查看日志'));assert.equal(calls,1);
});
test('structured guidance and business codes survive a model partial commit without exposing the credential',async()=>{
  const h=fixture({snapshot:{...ready}});h.context.original=Object.assign(new Error('private raw model fixture'),{
    guidance:{title:'模型设置已保存。',detail:'最后检查没有完成。',next:'重新查询状态，避免重复提交。'},userCode:'MODEL_CONFIG_PARTIAL',allowedActions:['recheck','logs']});
  await h.invoke('fail(original,"model",()=>{})');assert.equal(h.output().copy[0],'模型设置已保存。');
  assert.match(h.output().copy[1],/重新查询状态/);assert.equal(action(h,'重试'),undefined);
});

test('model partial commit uses userCode despite changed wording and prevents blind resubmission',async()=>{
  let submissions=0;const original=Object.assign(new Error('raw credential fixture'),{
    userCode:'MODEL_CONFIG_PARTIAL',guidance:{title:'模型已保存。',detail:'当前同步尚未确认。',next:'请重新查询状态。'},allowedActions:['recheck','logs']});
  const h=fixture({snapshot:{...ready,modelConfigured:true},api:{modelProviders:async()=>({ok:true,providers:[{id:'deepseek',label:'DeepSeek'}]}),
    saveAndTestModel:async()=>{submissions++;throw original;},status:async()=>({...ready,modelConfigured:true})}});
  await h.invoke('modelForm()');h.inline.querySelector('#key').value='secret-fixture';h.inline.querySelector('#model').value='deepseek-v4-flash';
  const form=descendants(h.inline).find(node=>node.tagName==='FORM');await form.onsubmit({preventDefault(){}});
  const submit=form.querySelectorAll('button').find(node=>node.type==='submit');assert.equal(submit.disabled,true);
  assert.ok(action(h,'重新查询状态'));assert.equal(submissions,1);assert.doesNotMatch(h.inline.textContent,/secret-fixture|raw credential/);
});
test('a harmless failed update does not block a separate service action or a trusted launcher recovery',async()=>{
  const original=structuredFailure();let starts=0,restores=0;
  const h=fixture({snapshot:{...ready,operation:original.operation},api:{start:async()=>{starts++;return {...ready};},
    recoverLauncher:async()=>{restores++;return {restored:true};},status:async()=>({...ready,operation:original.operation,launcherRecovery:{canRecover:true},busy:false})}});
  await h.invoke('run("start",{service:"tavern"})');assert.equal(starts,1);
  h.context.snapshot.launcherRecovery={canRecover:true};await h.invoke('route()');assert.ok(action(h,'恢复旧启动器'));
  await action(h,'恢复旧启动器').onclick();assert.equal(restores,1);
});

test('backend can revoke recovery after reload without changing a trusted backup record',async()=>{
  const original=structuredFailure({actions:['recover','recheck','logs']});let permitted=true;
  const h=fixture({snapshot:{...ready,updateRecovery:{canRecover:true,backup:'/fixture/backup'},operation:original.operation},api:{
    recover:async()=>{},recoverOperation:async()=>{},openLogs:async()=>({ok:true}),
    status:async()=>({...ready,updateRecovery:{canRecover:true,backup:'/fixture/backup'},operation:{...original.operation,snapshotSequence:3,allowedActions:permitted?['recover','recheck','logs']:['recheck','logs']}})}});
  await h.invoke('route()');assert.ok(action(h,'恢复旧版本'));
  permitted=false;await h.invoke('poll()');assert.equal(action(h,'恢复旧版本'),undefined);assert.ok(action(h,'重新检查'));
});
test('a succeeded operation retains historical failures without presenting a failed workflow',async()=>{
  const original=structuredFailure();const h=fixture({snapshot:{...ready,operation:{...original.operation,state:'succeeded',snapshotSequence:10}}});
  await h.invoke('route()');assert.equal(h.context.view,'daily');assert.doesNotMatch(h.output().copy.join('\n'),/没有完成|错误/);
});

test('a confirmed explicit recovery retains the original failure and returns to usable UI after reopening',async()=>{
  const original=structuredFailure();
  const restored={...original.operation,state:'rolled-back',effectState:'restored',verification:'confirmed',
    recoveryOutcome:'restored-and-verified',currentFailure:null,snapshotSequence:10};
  const h=fixture({snapshot:{...ready,operation:restored},api:{checkUpdate:async()=>updateResult}});
  await h.invoke('route()');assert.equal(h.context.view,'daily');
  assert.equal(h.context.snapshot.operation.primaryFailure.code,original.operation.primaryFailure.code);
  await h.invoke('checkUpdates()');assert.ok(action(h,'安装更新'));
  assert.doesNotMatch(h.inline.textContent,/上次操作尚未确认/);
});

test('automatic rollback and files-only recovery still show the failed operation',async()=>{
  const original=structuredFailure();
  for(const patch of [{verification:'confirmed',recoveryOutcome:'restored-and-verified',currentFailure:original.operation.primaryFailure},
    {verification:'failed',recoveryOutcome:'files-restored-start-failed',currentFailure:null}]){
    const h=fixture({snapshot:{...ready,operation:{...original.operation,state:'rolled-back',effectState:'restored',...patch}}});
    await h.invoke('route()');assert.equal(h.context.view,'error');
    assert.equal(action(h,'重试'),undefined);
  }
});

test('a reused version result is not presented as a fresh confirmation of the latest release',async()=>{
  const h=fixture({snapshot:{...ready},api:{checkUpdate:async()=>({state:'current',current:'2.4.2',latest:'v2.4.2',latestConfirmed:false,checkedAt:1,metadataSource:'cache'})}});
  await h.invoke('checkUpdates()');assert.doesNotMatch(h.output().copy[0],/已是最新/);assert.match(h.output().copy.join('\n'),/上次|最近/);
});

test('a recovery action is the only primary button and its click keeps the persisted operation identity',async()=>{
  const original=structuredFailure({actions:['recover','recheck','logs']});let recovered;
  const h=fixture({snapshot:{...ready,operation:original.operation},api:{openLogs:async()=>({ok:true}),recoverOperation:async request=>{recovered=request;return {...ready};},status:async()=>({...ready,operation:original.operation})}});
  h.context.original=original;await h.invoke('fail(original,"update")');
  assert.deepEqual(descendants(h.inline).filter(n=>n.classList.contains('primary')).map(n=>n.textContent),['恢复旧版本']);
  assert.ok(action(h,'重新检查'));assert.ok(action(h,'查看日志'));assert.equal(h.elements.get('launchbar').hidden,true);
  await action(h,'恢复旧版本').onclick();assert.equal(recovered.operationId,original.operation.operationId);assert.equal(recovered.snapshotSequence,2);
});

test('files-only recovery exposes startup facts and a start action without replaying file restoration',async()=>{
  const original=structuredFailure({actions:['start-restored','recheck','logs']});
  original.operation.effectState='restored';original.operation.recoveryOutcome='files-restored-start-failed';
  const h=fixture({snapshot:{...ready,operation:original.operation},api:{recoverOperation:async()=>{}}});
  await h.invoke('route()');assert.match(h.output().copy[1],/文件已恢复.*启动检查未通过/);
  assert.equal(action(h,'恢复旧版本'),undefined);assert.ok(action(h,'启动旧版本'));
  assert.deepEqual(descendants(h.inline).filter(n=>n.classList.contains('primary')).map(n=>n.textContent),['启动旧版本']);
});

test('launcher and system recovery render one blocking recovery first and retain the first cause',async()=>{
  const original=structuredFailure({actions:['recover','recheck','logs']});
  original.operation.primaryFailure.guidance.title='下载组件校验未通过。';
  original.operation.currentFailure={guidance:{title:'后续恢复检查未完成。'}};
  const h=fixture({snapshot:{...ready,operation:original.operation,updateRecovery:{canRecover:true},launcherRecovery:{canRecover:true}},
    api:{recoverOperation:async()=>{},recoverLauncher:async()=>{}}});
  await h.invoke('route()');assert.equal(action(h,'恢复旧版本'),undefined);assert.ok(action(h,'恢复旧启动器'));
  assert.deepEqual(descendants(h.inline).filter(n=>n.classList.contains('primary')).map(n=>n.textContent),['恢复旧启动器']);
  assert.doesNotMatch(h.output().copy[1],/最初失败/);
  assert.match(h.inline.querySelector(".recovery-details").textContent,/最初失败.*下载组件校验未通过/);
  assert.equal(original.operation.primaryFailure.guidance.title,'下载组件校验未通过。');
});

test('a failed status query retains confirmed facts and their observation time without a mutation action',async()=>{
  let failed=false;const h=fixture({snapshot:{...ready},api:{status:async()=>{if(failed)throw Error('query failed');return {...ready};}}});
  await h.invoke('readStatus()');const confirmedAt=h.context.lastStatusAt;assert.ok(confirmedAt>0);
  failed=true;await assert.rejects(h.invoke('readStatus()'));h.context.original=structuredFailure({actions:['retry','recheck','logs']});
  await h.invoke('fail(original,"update")');assert.equal(h.context.lastStatusAt,confirmedAt);assert.equal(h.context.snapshot.running,true);
  assert.match(h.output().copy[1],/运行状态未知.*重新查询/);assert.doesNotMatch(h.output().copy[1],/上次成功查询/);
  assert.equal(descendants(h.inline).some(n=>/重新尝试|继续更新|恢复旧版本/.test(n.textContent)),false);
  assert.ok(action(h,'重新查询状态'));
});

test('version view separates launcher and system versions, dates cached facts and has one primary action',async()=>{
  const h=fixture({snapshot:{...ready},api:{openLogs:async()=>({ok:true}),checkUpdate:async()=>({...updateResult,latestConfirmed:false,checkedAt:'2026-10-05T01:00:00Z',launcherVersion:'2.0.2',releaseUrl:'https://example.invalid/release'})}});
  await h.invoke('checkUpdates()');const content=h.output().copy.join('\n');
  assert.match(content,/酒馆：当前 2\.4\.2[\s\S]*启动器：当前 2\.0\.2/);assert.match(content,/上次检查结果：.*2026/);assert.doesNotMatch(content,/GitHub|已是最新/);
  assert.deepEqual(descendants(h.inline).filter(n=>n.classList.contains('primary')).map(n=>n.textContent),['安装更新']);
  assert.ok(action(h,'重新检查更新'));assert.ok(action(h,'查看日志'));
});

test('unknown runtime state cannot offer installation from a successful readonly release query',async()=>{
  const h=fixture({snapshot:{...ready},statusUnknown:true,api:{checkUpdate:async()=>updateResult}});
  await h.invoke('checkUpdates()');assert.equal(action(h,'安装更新'),undefined);assert.ok(action(h,'重新查询状态'));
});

test('model authentication failure gives a direct log button without losing input or resubmitting',async()=>{
  let submissions=0;const h=fixture({snapshot:{...ready,modelConfigured:true},api:{openLogs:async()=>({ok:true}),modelProviders:async()=>({ok:true,providers:[{id:'deepseek',label:'DeepSeek'}]}),
    saveAndTestModel:async()=>{submissions++;throw Object.assign(Error('raw credential fixture'),{guidance:{title:'模型身份验证未通过。',detail:'请核对 API Key。'}});},status:async()=>({...ready,modelConfigured:true})}});
  await h.invoke('modelForm()');const key=h.inline.querySelector('#key');key.value='secret-fixture';h.inline.querySelector('#model').value='chosen-model';
  const form=descendants(h.inline).find(n=>n.tagName==='FORM');await form.onsubmit({preventDefault(){}});
  const logs=action(h,'查看日志');assert.ok(logs);assert.equal(logs.hidden,false);assert.equal(logs.type,'button');
  await logs.onclick({currentTarget:logs});await h.invoke('poll()');
  assert.equal(submissions,1);assert.equal(key.value,'secret-fixture');assert.equal(h.inline.querySelector('#model').value,'chosen-model');
  assert.equal(h.context.view,'model');assert.doesNotMatch(h.inline.textContent,/secret-fixture|raw credential/);
});

test('successful model save followed by an unavailable status cannot re-enable configuration submission',async()=>{
  let submissions=0;const h=fixture({snapshot:{...ready,modelConfigured:true},api:{openLogs:async()=>({ok:true}),modelProviders:async()=>({ok:true,providers:[{id:'deepseek',label:'DeepSeek'}]}),
    saveAndTestModel:async()=>{submissions++;},status:async()=>{throw Error('query lost after save');}}});
  await h.invoke('modelForm()');h.inline.querySelector('#key').value='secret-fixture';h.inline.querySelector('#model').value='chosen-model';
  const form=descendants(h.inline).find(n=>n.tagName==='FORM');await form.onsubmit({preventDefault(){}});
  assert.equal(form.querySelector('button[type="submit"]').disabled,true);assert.ok(action(h,'重新查询状态'));
  h.inline.querySelector('#key').value='secret-fixture';await form.onsubmit({preventDefault(){}});assert.equal(submissions,1);
});

test('a model form pauses submission during a status outage and preserves input when the query recovers',async()=>{
  let failed=true,submissions=0;const h=fixture({snapshot:{...ready},api:{modelProviders:async()=>({ok:true,providers:[{id:'deepseek',label:'DeepSeek'}]}),
    saveAndTestModel:async()=>{submissions++;},status:async()=>{if(failed)throw Error('status unavailable');return {...ready};}}});
  await h.invoke('modelForm()');const form=descendants(h.inline).find(n=>n.tagName==='FORM'),key=h.inline.querySelector('#key');
  key.value='secret-fixture';h.inline.querySelector('#model').value='chosen-model';await h.invoke('poll()');
  assert.equal(form.querySelector('button[type="submit"]').disabled,true);assert.equal(action(h,'重新查询状态').hidden,false);
  await form.onsubmit({preventDefault(){}});assert.equal(submissions,0);
  failed=false;await action(h,'重新查询状态').onclick();assert.equal(form.querySelector('button[type="submit"]').disabled,false);
  assert.equal(h.context.view,'model');assert.equal(key.value,'secret-fixture');assert.equal(h.inline.querySelector('#model').value,'chosen-model');
  assert.equal(h.inline.querySelector('#feedback').classList.contains('error'),false);
});

test('a successful query of partially saved model settings offers synchronization without submitting again',async()=>{
  let submissions=0;const h=fixture({snapshot:{...ready},api:{modelProviders:async()=>({ok:true,providers:[{id:'deepseek',label:'DeepSeek'}]}),
    saveAndTestModel:async()=>{submissions++;throw Object.assign(Error('partial save'),{userCode:'MODEL_CONFIG_PARTIAL',guidance:{title:'配置已保存。',detail:'同步未确认。'}});},
    status:async()=>({...ready,modelSyncPending:true}),resumeModelSetup:async()=>({...ready})}});
  await h.invoke('modelForm()');h.inline.querySelector('#key').value='secret-fixture';h.inline.querySelector('#model').value='chosen-model';
  await descendants(h.inline).find(n=>n.tagName==='FORM').onsubmit({preventDefault(){}});
  await action(h,'重新查询状态').onclick();assert.ok(action(h,'继续同步'));assert.equal(submissions,1);
  assert.equal(action(h,'验证并继续'),undefined);
});

test('the More log entry uses the actual console capability and stays readonly during another task',async()=>{
  let reads=0;const h=fixture({snapshot:{...ready},busy:true,api:{operationLogs:async()=>({})}});
  h.context.openLogs=async()=>{reads++;};await h.menu.find(n=>n.dataset.action==='logs').onclick();
  assert.equal(reads,1);assert.equal(h.calls.some(call=>['install','start','update'].includes(call[0])),false);
});

test('a pairing form preserves its single-use code and makes no request when current status is unknown',async()=>{
  let requests=0;const h=fixture({snapshot:{...ready},statusUnknown:true,api:{pair:async()=>{requests++;}}});
  await h.invoke('clawForm()');h.inline.querySelector('#pairCode').value='single-use-fixture';
  const form=descendants(h.inline).find(n=>n.tagName==='FORM');await form.onsubmit({preventDefault(){}});
  assert.equal(requests,0);assert.equal(h.inline.querySelector('#pairCode').value,'single-use-fixture');
});

test('failure navigation requires confirmed usable files and keeps normal controls off the error page',async()=>{
  for(const [effectState,verification,permitted] of [['unknown','unconfirmed',false],['changed','unconfirmed',false],
    ['restored','unconfirmed',false],['untouched','failed',true],['restored','confirmed',true]]){
    const operation={operationId:'22222222-2222-4222-8222-222222222222',kind:'update',state:'failed',
      effectState,verification,recoveryOutcome:'not-required',snapshotSequence:1,allowedActions:['recheck','logs'],
      primaryFailure:{guidance:{title:'更新未完成。',detail:'请查看本次日志。'}}};
    const h=fixture({snapshot:{...ready,operation}});await h.invoke('route()');
    assert.equal(Boolean(action(h,'返回酒馆')),permitted,`${effectState}/${verification}`);
    assert.equal(h.output().managementVisible,false);
    assert.ok(action(h,'查看日志'));
  }
});

test('a fresh no-update result prioritizes return and a failed first check does not invent cache evidence',async()=>{
  const h=fixture({snapshot:{...ready},api:{openLogs:async()=>({ok:true}),checkUpdate:async()=>({
    state:'current',latestConfirmed:true,current:'2.4.2',latest:'v2.4.2',launcherVersion:'2.0.2',launcherLatest:'2.0.2'})}});
  await h.invoke('checkUpdates()');
  assert.deepEqual(descendants(h.inline).filter(n=>n.classList.contains('primary')).map(n=>n.textContent),['返回酒馆']);
  assert.ok(action(h,'查看日志'));
  h.context.api.checkUpdate=async()=>({state:'unavailable',latestConfirmed:false,checkedAt:null});
  await h.invoke('checkUpdates()');assert.doesNotMatch(h.output().copy.join('\n'),/上次检查的结果/);
  assert.deepEqual(descendants(h.inline).filter(n=>n.classList.contains('primary')).map(n=>n.textContent),['重新检查更新']);
});

test('a model-list authentication failure preserves input and never recommends manual naming as its remedy',async()=>{
  const h=fixture({snapshot:{...ready,modelConfigured:true},api:{openLogs:async()=>({ok:true}),
    modelProviders:async()=>({ok:true,providers:[{id:'deepseek',label:'DeepSeek'}]}),
    modelOptions:async()=>{throw Object.assign(Error('private provider text'),{technical:{http_status:401},
      guidance:{title:'模型服务验证失败（401）。',next:'请核对 API Key 和接口地址后重新测试。'}});}}});
  await h.invoke('modelForm()');h.inline.querySelector('#key').value='private-key';
  assert.ok(action(h,'验证并保存'));
  await action(h,'获取模型列表').onclick();
  assert.match(h.inline.querySelector('#feedback').textContent,/核对 API Key/);
  assert.doesNotMatch(h.inline.querySelector('#feedback').textContent,/手动输入|private/);
  assert.equal(h.inline.querySelector('#key').value,'private-key');
});

test('the model failure log entry stays bound to the submitted operation instead of an old install',async()=>{
  const submitted={operationId:'22222222-2222-4222-8222-222222222222',kind:'model',state:'failed',snapshotSequence:2};
  const old={operationId:'11111111-1111-4111-8111-111111111111',kind:'install',state:'succeeded',snapshotSequence:5};
  let requested;const h=fixture({snapshot:{...ready,operation:old},api:{operationLogs:async()=>({}),modelProviders:async()=>({ok:true,providers:[{id:'deepseek',label:'DeepSeek'}]}),
    saveAndTestModel:async()=>{throw Object.assign(Error('model failed'),{operation:submitted,guidance:{title:'模型验证未完成。'}});},status:async()=>({...ready,operation:old})}});
  h.context.openLogs=async(event,id)=>{requested=id;};await h.invoke('modelForm()');h.inline.querySelector('#key').value='secret-fixture';h.inline.querySelector('#model').value='chosen-model';
  await descendants(h.inline).find(n=>n.tagName==='FORM').onsubmit({preventDefault(){}});
  const logs=action(h,'查看日志');assert.equal(logs.hidden,false);await logs.onclick({currentTarget:logs});
  assert.equal(requested,submitted.operationId);
});
