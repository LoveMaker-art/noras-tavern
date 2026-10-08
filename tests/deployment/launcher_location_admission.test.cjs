const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const desktop=path.join(__dirname,'../installer/desktop');
const lock=require(path.join(desktop,'operation-lock'));
const {acquireInspected}=require(path.join(desktop,'operation-inspection'));
const locations=require(path.join(desktop,'install-location'));
const {own}=require(path.join(desktop,'uninstall'));
const source=fs.readFileSync(path.join(desktop,'main.js'),'utf8');
const handler=source.slice(source.indexOf("  handle('nora:choose-directory'"),source.indexOf('  const executeAction'));

function fixture(t){
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-location-admission-')));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const home=path.join(base,'default/NoraTavern'),parent=path.join(base,'chosen');
  fs.mkdirSync(parent);own(home);fs.mkdirSync(path.join(home,'installer'));
  const oldReceipt=path.join(home,'installer/launcher-control.json');fs.writeFileSync(oldReceipt,'original');
  let choose,registrations=0;
  const context=vm.createContext({fs,path,process,Promise,__dirname:desktop,LOCATION_SCOPE:'stable',
    app:{isPackaged:false},BrowserWindow:{fromWebContents:()=>null},statusRequest:null,locations,operationLock:lock,acquireInspected,
    dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[parent]})},
    locationStatus:()=>({canChooseDirectory:locations.canChangeLocation(context.selectedHome||home)}),
    defaultNoraHome:()=>home,noraHome:()=>context.selectedHome||home,installerDirectory:()=>path.join(context.selectedHome||home,'installer'),
    installerRoot:()=>path.dirname(desktop),findPython:()=>null,telemetry:null,launcherError:(message,details)=>Object.assign(new Error(message),details),
    require:name=>name.startsWith('.')?require(path.join(desktop,name)):require(name),
    handle:(_name,fn)=>{choose=fn;},
    registerCapabilities:async()=>{
      registrations++;
      assert.equal((await lock.probe({directory:path.join(home,'installer')})).busy,true);
      assert.equal((await lock.probe({directory:path.join(context.selectedHome,'installer')})).busy,true);
      assert.equal(fs.existsSync(oldReceipt),false);
    },
  });
  vm.runInContext(handler,context);
  return {home,parent,oldReceipt,context,choose:()=>choose({sender:{}}),registrations:()=>registrations};
}

test('directory selection commits the pointer and revokes the old capability while both real native fences are held',async t=>{
  const f=fixture(t),result=await f.choose();
  assert.equal(result.noraHome,path.join(f.parent,'NoraTavern'));
  assert.equal(locations.readLocation(f.home,'stable'),result.noraHome);
  assert.equal(f.registrations(),1);
  for(const home of [f.home,result.noraHome])assert.equal((await lock.probe({directory:path.join(home,'installer')})).busy,false);
});

test('a destination writer blocks selection without changing the existing pointer or capability',async t=>{
  const f=fixture(t),target=locations.prepareLocation(f.parent,{currentHome:f.home,defaultHome:f.home,scope:'stable'});
  const lease=await lock.acquire({directory:path.join(target,'installer'),operationId:randomUUID(),ownerEpoch:1});
  try{
    await assert.rejects(f.choose(),{code:'OPERATION_BUSY'});
    assert.equal(locations.readLocation(f.home,'stable'),f.home);
    assert.equal(fs.readFileSync(f.oldReceipt,'utf8'),'original');assert.equal(f.registrations(),0);
    assert.equal((await lock.probe({directory:path.join(f.home,'installer')})).busy,false);
  }finally{await lease.release();}
});
