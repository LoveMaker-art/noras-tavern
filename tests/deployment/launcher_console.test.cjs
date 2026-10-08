const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const assert=require('node:assert/strict'),{test}=require('node:test');
const {createDiagnostics}=require('../installer/desktop/diagnostics');

// Exercise the real controller's console handlers against its real readonly
// logger. The DOM adapter does not establish rendered layout/visual acceptance.
test('console follows actual records, pauses history, copies all and returns without executing maintenance',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-console-controller-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const diagnostics=createDiagnostics({primary:()=>path.join(root,'install.log')});
  const id=diagnostics.begin('install',{action:'install'});
  for(let i=0;i<40;i++)diagnostics.event({event:'log',line:`[INFO] actual entry ${i}`,uploadScope:'maintenance'});
  diagnostics.event({event:'log',stream:'stderr',line:'ExtractError: invalid archive\n  at unpack (archive.js:42:3)',uploadScope:'maintenance'});
  diagnostics.finish('failed');
  const nodes=new Map();let focused,clipboard='',requests=0;
  function node(id=''){
    const value={id,children:[],style:{},hidden:false,disabled:false,isConnected:true,scrollTop:0,clientHeight:100,offsetTop:0,listeners:{},
      setAttribute(){},focus(){focused=this;},addEventListener(name,fn){this.listeners[name]=fn;},
      append(child){child.parent=this;child.offsetTop=this.children.length*20;this.children.push(child);},
      replaceChildren(){this.children=[];},remove(){this.isConnected=false;if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}};
    const classes=new Set();value.classList={add:(...names)=>names.forEach(name=>classes.add(name)),remove:(...names)=>names.forEach(name=>classes.delete(name)),contains:name=>classes.has(name),toggle:(name,on)=>on?classes.add(name):classes.delete(name)};
    Object.defineProperty(value,'scrollHeight',{get:()=>value.children.length*20});
    Object.defineProperty(value,'innerHTML',{set:html=>{for(const match of html.matchAll(/id="([^"]+)"/g)){const child=node(match[1]);nodes.set(child.id,child);value.append(child);}}});
    return value;
  }
  const $=id=>{if(!nodes.has(id))nodes.set(id,node(id));return nodes.get(id);};
  const context=vm.createContext({$,document:{createElement:()=>node(),createTextNode:text=>({textContent:text})},
    api:{operationLogs:async(operation,cursor)=>{requests++;return diagnostics.readOperation(operation||id,cursor);}},
    navigator:{clipboard:{writeText:async text=>{clipboard=text;}}},
    view:'error',taskStage:'',taskProgress:null,currentTask:'准备中',snapshot:{operation:{operationId:id},busy:false},lastFailure:null,busy:false,alive:true,
    hideMenu(){},setTimeout:()=>1,clearTimeout(){}});
  const source=fs.readFileSync(path.join(__dirname,'../installer/launcher-controller.js'),'utf8');
  vm.runInContext(source.slice(source.indexOf('  let logsOpen ='),source.indexOf("  $('stop').remove();")),context);
  vm.runInContext(source.slice(source.indexOf('  async function openLogs('),source.indexOf('  function recoveredOperation(')),context);
  const control=node('originalLogsButton');await context.openLogs({currentTarget:control});
  const output=$('consoleOutput');
  assert.ok($('main').classList.contains('logs-open'));assert.equal(focused,output);
  assert.ok(output.children.some(line=>line.textContent.includes('\n  at unpack')));
  Object.assign(context,{firstCompletionPending:false,statusUnknown:false,say(){},renderServices(){},renderConversationEntry(){},controls(){},showVersionNotice(){}});
  vm.runInContext(source.slice(source.indexOf('  function allRunning('),source.indexOf('  function syncState(')),context);
  vm.runInContext(source.slice(source.indexOf('  function recoveredOperation('),source.indexOf('  function route(')),context);
  vm.runInContext(source.slice(source.indexOf('  dailyHome ='),source.indexOf('  function renderConversationEntry(')),context);
  context.dailyHome();assert.ok($('main').classList.contains('logs-open'),'a result refresh must retain the open console');
  output.scrollTop=10;output.listeners.wheel({deltaY:-1});
  diagnostics.event({event:'log',line:'new real output',uploadScope:'maintenance'});await context.readConsole();
  assert.equal(output.scrollTop,10);assert.equal($('consoleLatest').hidden,false);
  $('consoleLatest').onclick();assert.equal(output.scrollTop,output.scrollHeight);
  const nextId=diagnostics.begin('update',{action:'update'});diagnostics.event({event:'log',line:'[INFO] another actual operation',uploadScope:'maintenance'});
  diagnostics.finish('failed');context.snapshot.operation={operationId:nextId};await context.readConsole();
  assert.equal(output.children.some(line=>line.textContent.includes('another actual operation')),false);
  await $('consoleCopy').onclick();assert.match(clipboard,/actual entry 0/);assert.match(clipboard,/actual entry 39/);assert.match(clipboard,/new real output/);
  assert.doesNotMatch(clipboard,/another actual operation/);
  assert.equal($('consoleCopy').textContent,'已复制本次日志');
  $('consoleBack').onclick();assert.equal($('main').classList.contains('logs-open'),false);assert.equal(focused,control);
  await context.openLogs({currentTarget:control});control.isConnected=false;
  $('consoleBack').onclick();assert.equal(focused,$('main'));assert.equal($('main').tabIndex,-1);
  const menuLogs=node('menuLogs');menuLogs.dataset={action:'logs'};
  await context.openLogs({currentTarget:menuLogs});$('consoleBack').onclick();assert.equal(focused,$('moreButton'));
  const pending=diagnostics.begin('pending-render',{action:'install'});
  for(let i=0;i<30;i++)diagnostics.event({event:'log',line:`pending ${i}`,uploadScope:'maintenance'});
  diagnostics.event({event:'log',stream:'stderr',line:'pending error',uploadScope:'maintenance'});
  diagnostics.event({event:'log',line:'after error',uploadScope:'maintenance'});
  context.busy=true;context.snapshot={operation:{operationId:pending,state:'applying'},busy:true};
  await context.openLogs({currentTarget:control},pending);assert.equal(output.scrollTop,output.scrollHeight);
  diagnostics.finish('failed');context.busy=false;context.snapshot.busy=false;context.snapshot.operation.state='failed';
  await context.readConsole();assert.ok(output.scrollTop<output.scrollHeight,'a previously read error is located when completion arrives');
  assert.equal($('consoleStatus').textContent,'操作失败');
  const read=context.api.operationLogs;
  context.api.operationLogs=async(...args)=>({...await read(...args),missing:['retained record missing']});
  await $('consoleCopy').onclick();assert.equal($('consoleCopy').textContent,'已复制部分日志');
  context.api.operationLogs=read;
  const checkId=require('node:crypto').randomUUID();
  await diagnostics.scope(checkId,{action:'check_update'},async()=>({diagnosticError:new Error('actual release failure')}));
  context.snapshot.operation={operationId:id,state:'succeeded'};
  await context.openLogs({currentTarget:control},checkId);
  assert.equal($('consoleStatus').textContent,'操作失败');
  assert.ok(output.children.some(line=>line.textContent.includes('actual release failure')));
  assert.equal(output.children.some(line=>line.textContent.includes('actual entry 0')),false);
  assert.ok(requests>=3);
});
