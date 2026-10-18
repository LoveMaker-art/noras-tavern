// Run with the pinned Electron binary in an isolated proof directory. Only
// activation responses and service facts are controlled; renderer, preload, controller and native
// writer are the production implementations. No external pairing is performed.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {app,BrowserWindow,ipcMain}=require('electron');
const installer=path.resolve(__dirname,'../installer');
const {createOperationController}=require(path.join(installer,'desktop/operation-state'));
const {successResult,failureResult}=require(path.join(installer,'desktop/operation-result'));
const lock=require(path.join(installer,'desktop/operation-lock'));
// Check the same real module path the native lock worker will use before UI.
require(require.resolve('fs-native-extensions',{paths:[path.join(installer,'desktop')]}));
const arguments_=process.argv.slice(1);
const root=path.resolve(arguments_[arguments_.indexOf('--proof-root')+1]||'');
const phase=Number(arguments_[arguments_.indexOf('--phase')+1]);
if(!arguments_.includes('--proof-root')||!path.isAbsolute(root)||![1,2].includes(phase))throw new Error('Explicit isolated --proof-root and --phase 1|2 required');
fs.mkdirSync(root,{recursive:true});
app.setPath('userData',path.join(root,'electron-profile'));
app.setName('Nora Pair Retry Acceptance');
const counter=path.join(root,'activation-count.json');
let count=fs.existsSync(counter)?JSON.parse(fs.readFileSync(counter)).count:0;
if(phase===1)assert.equal(count,0,'phase one needs a fresh proof directory');
if(phase===2)assert.equal(count,2,'phase two reopens the two real persisted failures');
const preserved=path.join(root,'user-data-preserved.json');
if(phase===1)fs.writeFileSync(preserved,'{"user":"preserved"}');
const state={installed:true,hermesInstalled:true,noraInstalled:true,systemReady:true,setupCompleted:false,
  modelConfigured:true,clawchatPaired:false,clawchatProfileReady:false,clawchatConnected:false,
  gatewayRunning:false,running:true,port:8799,version:'2.5.2',noraHome:root,installer:{setupCompleted:false}};
const controller=createOperationController({directory:path.join(root,'installer'),lock,
  verifyResult:result=>result.clawchatPaired===true&&result.clawchatProfileReady===true});
let window_;
const ipcFailures=[];
const current=async()=>({...state,operation:await controller.snapshot()});
const handle=(name,fn)=>ipcMain.handle(name,async(event,...args)=>{
  try{return successResult(await fn(event,...args));}
  catch(error){ipcFailures.push({channel:name,code:error.code,message:error.message,stack:error.stack});return failureResult(error,{operation:error.operation});}
});
handle('nora:status',current);
handle('nora:telemetry',()=>({available:false}));
handle('nora:check-update',()=>({state:'current',available:false,current:'2.5.2',latest:'2.5.2',launcherVersion:'2.2.2'}));
handle('nora:operation-snapshot',(_event,payload)=>controller.snapshot(payload.operationId));
handle('nora:operation-recheck',async(_event,payload)=>({operation:await controller.recheck(payload.operationId,{snapshotSequence:payload.snapshotSequence})}));
handle('nora:operation-logs',()=>({records:[{id:'controlled-failure',text:'[ERROR] Controlled activation response; no external account used.'}],missing:[],hasMore:false}));
handle('nora:run',async(_event,payload)=>{
  assert.equal(payload.action,'pair');
  const target={request:{action:'pair',port:payload.port}};
  const operation=await controller.start('pair',{target,execute:async context=>{
    await context.plan(target);count++;fs.writeFileSync(counter,JSON.stringify({count}));
    if(count<=2)throw Object.assign(new Error('验收注入：ClawChat 激活返回失败。'),{code:'PAIR_ACTIVATION_FAILED'});
    Object.assign(state,{clawchatPaired:true,clawchatProfileReady:true,clawchatConnected:true,
      running:true,gatewayRunning:true,setupCompleted:true,installer:{setupCompleted:true}});
    return {...state};
  }},payload.runId);
  if(operation.state!=='succeeded'){
    const error=Object.assign(new Error(operation.primaryFailure?.guidance?.title||'Pair failed'),{operation});
    throw error;
  }
  return current();
});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(expression,timeout=12000){
  const until=Date.now()+timeout;
  while(Date.now()<until){
    if(await window_.webContents.executeJavaScript('Boolean('+expression+')'))return;
    await delay(100);
  }
  throw new Error('Renderer condition timed out: '+expression);
}
async function click(label){
  const ok=await window_.webContents.executeJavaScript('(function(){const b=Array.from(document.querySelectorAll("button")).find(x=>x.textContent==='+JSON.stringify(label)+');if(!b||b.disabled)return false;b.click();return true;})()');
  assert.equal(ok,true,'visible button: '+label);
}
async function submit(code){
  await wait('document.getElementById("pairCode")');
  await window_.webContents.executeJavaScript('document.getElementById("pairCode").value='+JSON.stringify(code)+';document.querySelector(".pair-form button[type=submit]").click()');
}
async function waitFreshInput(){
  await wait('Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="重新输入配对码")');
  await click('重新输入配对码');
  await wait('document.getElementById("pairCode")');
}
async function run(){
  await app.whenReady();
  window_=new BrowserWindow({width:1120,height:760,show:true,title:'诺拉配对重试验收（隔离）',
    webPreferences:{preload:path.join(installer,'desktop/preload.js'),contextIsolation:true,sandbox:false,backgroundThrottling:false}});
  const errors=[];window_.webContents.on('render-process-gone',(_event,value)=>errors.push(value.reason));
  window_.webContents.on('did-fail-load',(_event,code,description)=>errors.push(code+':'+description));
  await window_.loadFile(path.join(installer,'launcher-conversation-prototype.html'),{query:{desktop:'1'}});
  if(phase===1){
    await submit('PAIR-TEST-ONE');await waitFreshInput();
    await submit('PAIR-TEST-TWO');await waitFreshInput();
    await wait('document.querySelector(".pair-form button[type=submit]").disabled');
    assert.equal(count,2);
  }else{
    await waitFreshInput();
    assert.equal(await window_.webContents.executeJavaScript('document.getElementById("pairCode").value'),'');
    await wait('!document.querySelector(".pair-form button[type=submit]").disabled',40000);
    await submit('PAIR-TEST-THREE');
    const deadline=Date.now()+12000;
    while(Date.now()<deadline&&(count!==3||(await controller.snapshot())?.state!=='succeeded'))await delay(100);
    await wait('!document.getElementById("pairCode")');
    assert.equal(count,3);assert.equal((await controller.snapshot()).state,'succeeded');
  }
  const operation=await controller.snapshot();
  assert.equal(operation.busy,false);
  assert.equal(fs.readFileSync(preserved,'utf8'),'{"user":"preserved"}');
  const records=fs.readdirSync(path.join(root,'installer/operations')).filter(value=>/^[a-f0-9-]{36}$/i.test(value));
  for(const id of records){
    const content=fs.readFileSync(path.join(root,'installer/operations',id,'operation.json'),'utf8');
    assert.doesNotMatch(content,/PAIR-TEST-(?:ONE|TWO|THREE)/);
  }
  const image=await window_.webContents.capturePage();fs.writeFileSync(path.join(root,'phase-'+phase+'.png'),image.toPNG());
  const sourceFiles=['launcher-controller.js','desktop/preload.js','desktop/operation-state.js','desktop/error-presentation.js'];
  const report={phase,platform:process.platform,electron:process.versions.electron,node:process.versions.node,
    controlledActivationResponses:true,externalPairingPerformed:false,activationCalls:count,
    state:operation.state,pairRetryAt:operation.pairRetryAt,writerBusy:operation.busy,privateInputAbsent:true,userDataPreserved:true,
    sourceHashes:Object.fromEntries(sourceFiles.map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(installer,name))).digest('hex')])),errors};
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(root,'phase-'+phase+'.json'),JSON.stringify(report,null,2));
  app.exit(0);
}
run().catch(async error=>{
  const report={error:error.stack,operation:await controller.snapshot(),ipcFailures};
  if(window_&&!window_.isDestroyed()){
    report.visibleText=await window_.webContents.executeJavaScript('document.body.innerText').catch(()=>null);
    const image=await window_.webContents.capturePage().catch(()=>null);
    if(image)fs.writeFileSync(path.join(root,'phase-'+phase+'-failed.png'),image.toPNG());
  }
  fs.writeFileSync(path.join(root,'phase-'+phase+'-failed.json'),JSON.stringify(report,null,2));app.exit(1);
});
