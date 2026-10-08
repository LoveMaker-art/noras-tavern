const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { chromium } = require(process.env.NORA_PLAYWRIGHT || 'playwright');
const url = pathToFileURL(path.resolve(__dirname, '../installer/launcher-conversation-prototype.html')).href;
async function dailyInteractionPage(browser,viewport,options={}){
  const page=await browser.newPage({viewport});
  page.uiErrors=[];page.on('pageerror',error=>page.uiErrors.push(error.message));
  await page.addInitScript(options=>{
    window.state={installed:true,hermesInstalled:true,noraInstalled:true,systemReady:true,setupCompleted:true,
      modelConfigured:true,clawchatPaired:true,clawchatProfileReady:true,clawchatConnected:true,gatewayRunning:true,running:true,
      noraHome:'/isolated/NoraTavern',version:'2.4.2',port:8799,url:'http://127.0.0.1:8799',installer:{setupCompleted:true}};
    window.calls=[];window.statusReads=0;
    const action=name=>options=>{window.calls.push({name,service:options.service});return new Promise((resolve,reject)=>{
      window.finishAction=(patch,error)=>{Object.assign(window.state,patch);error?reject(new Error(error)):resolve({...window.state});};
    });};
    window.NoraLauncherBridge={status:async()=>{window.statusReads++;return {...window.state};},telemetry:async value=>typeof value==='boolean'?
      new Promise(resolve=>{window.finishTelemetry=resolve;}):({available:true,enabled:true}),
      start:action('start'),stop:action('stop'),restart:action('restart'),
      checkUpdate:async()=>options.deferVersion?new Promise(resolve=>{window.finishVersion=resolve;}):options.versionResult||({state:'current',available:false,current:'2.4.2',latest:'2.4.2',launcherVersion:'2.0.2'}),
      modelProviders:async()=>({ok:true,providers:[{id:'custom',label:'自定义模型',custom:true}]}),
      modelOptions:async()=>({ok:true,models:['test-model']}),
      operationLogs:async id=>({operationId:id||'22222222-2222-4222-8222-222222222222',records:[{id:'one',text:'[INFO] retained log',outcome:'succeeded'}],hasMore:false,missing:[]}),
      openInstallDirectory:async()=>{window.calls.push({name:'directory'});},
      openExternal:async()=>{window.calls.push({name:'external'});},
      openClawChatApp:async()=>({ok:true}),openClawChat:async()=>{},uninstall:async()=>{window.calls.push({name:'uninstall'});return new Promise(resolve=>{window.finishUninstall=resolve;});}};
  },options);
  await page.goto(url);await page.locator('.services').waitFor();
  await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));});
  return page;
}
async function dailyAnchors(page){
  return page.evaluate(()=>Object.fromEntries(['#copy','.services','#management','#launch','#telemetryNotice']
    .map(selector=>{const e=document.querySelector(selector),r=e.getBoundingClientRect();return [selector,{x:r.x,y:r.y}];})));
}

test('update cooldown keeps retry disabled through polling while logs and return remain usable', {timeout:20000},async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.NORA_CHROMIUM});
  try{
    const page=await dailyInteractionPage(browser,{width:1120,height:680},{versionResult:{
      state:'unavailable',available:false,current:'2.4.2',launcherVersion:'2.0.2',retryAt:Date.now()+600000,
      error:'下载或更新服务限制了请求。\n请在约 10 分钟后重新检查。'}});
    await page.locator('#moreButton').click();await page.locator('[data-action="update"]').click();
    const retry=page.getByRole('button',{name:'重新检查更新',exact:true});
    assert.equal(await retry.isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'查看日志',exact:true}).isEnabled(),true);
    assert.equal(await page.getByRole('button',{name:'返回酒馆',exact:true}).isEnabled(),true);
    await page.getByRole('button',{name:'查看日志',exact:true}).click();
    await page.getByRole('button',{name:'返回操作页',exact:true}).click();
    assert.equal(await retry.isDisabled(),true);
    await page.evaluate(()=>{const original=Date.now;Date.now=()=>original()+3600000;});
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='重新检查更新'&&!button.disabled),{},{timeout:7000});
    await page.getByRole('button',{name:'返回酒馆',exact:true}).click();
    await page.locator('.services').waitFor();assert.deepEqual(page.uiErrors,[]);
  }finally{await browser.close();}
});
function sameAnchors(actual,expected,label){
  for(const selector of Object.keys(expected))for(const axis of ['x','y'])
    assert.ok(Math.abs(actual[selector][axis]-expected[selector][axis])<=1,
      `${label}: ${selector} ${axis} moved ${actual[selector][axis]-expected[selector][axis]}px`);
}
test('daily service actions retain body anchors while busy and after each result',{timeout:60000},async()=>{
  const browser=await chromium.launch({executablePath:process.env.NORA_CHROMIUM||undefined});
  try{
    for(const viewport of [{width:1120,height:680},{width:900,height:640},{width:1120,height:652}]){
      const page=await dailyInteractionPage(browser,viewport);
      try{
        await page.evaluate(()=>{window.serviceRows=[...document.querySelectorAll('.service-row')];window.serviceButtons=[...document.querySelectorAll('.service-row button')];});
        const baseline=await dailyAnchors(page);
        for(const [name,service,patch] of [
          ['stop','nora',{gatewayRunning:false,clawchatConnected:false}],['start','nora',{gatewayRunning:true,clawchatConnected:true}],
          ['restart','nora',{}],['stop','tavern',{running:false}],['start','tavern',{running:true}],['restart','tavern',{}]
        ]){
          const label=({stop:'停止',start:'启动',restart:'重启'})[name]+(service==='nora'?'诺拉':'酒馆');
          await page.getByRole('button',{name:label,exact:true}).click();
          await page.waitForFunction(()=>typeof window.finishAction==='function');
          sameAnchors(await dailyAnchors(page),baseline,`${label} busy at ${viewport.width}x${viewport.height}`);
          await page.evaluate(patch=>{const done=window.finishAction;delete window.finishAction;done(patch);},patch);
          await page.waitForFunction(()=>[...document.querySelectorAll('.service-row')].every(row=>
            !['starting','stopping'].includes(row.dataset.state)&&!row.querySelectorAll('button')[1].disabled));
          sameAnchors(await dailyAnchors(page),baseline,`${label} completed`);
        }
        assert.equal(await page.evaluate(()=>window.serviceRows.every((row,i)=>row===document.querySelectorAll('.service-row')[i])&&
          window.serviceButtons.every((control,i)=>control===document.querySelectorAll('.service-row button')[i])),true,'service refresh preserves control nodes');
        assert.deepEqual(await page.evaluate(()=>window.calls),[
          {name:'stop',service:'nora'},{name:'start',service:'nora'},{name:'restart',service:'nora'},
          {name:'stop',service:'tavern'},{name:'start',service:'tavern'},{name:'restart',service:'tavern'}]);
        assert.deepEqual(page.uiErrors,[]);
      }finally{await page.close();}
    }
  }finally{await browser.close();}
});
test('More close controls and diagnostic saving preserve layout and focus',{timeout:15000},async()=>{
  const browser=await chromium.launch({executablePath:process.env.NORA_CHROMIUM||undefined});
  try{
    const page=await dailyInteractionPage(browser,{width:900,height:612});
    try{
      const baseline=await dailyAnchors(page);
      await page.locator('#moreButton').click();await page.locator('#moreClose').click();
      sameAnchors(await dailyAnchors(page),baseline,'More close button');
      assert.equal(await page.evaluate(()=>document.activeElement.id),'moreButton');
      await page.locator('#moreButton').click();
      await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.dataset.action),'uninstall');
      await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'moreClose');
      await page.locator('#more').click({position:{x:12,y:120}});
      assert.equal(await page.locator('#more').isVisible(),false);
      sameAnchors(await dailyAnchors(page),baseline,'More backdrop');
      await page.locator('#telemetryEnabled').uncheck();
      await page.waitForFunction(()=>typeof window.finishTelemetry==='function');
      sameAnchors(await dailyAnchors(page),baseline,'diagnostic choice saving');
      await page.evaluate(()=>window.finishTelemetry({available:true,enabled:false}));
      await page.waitForFunction(()=>!document.querySelector('#telemetryEnabled').disabled);
      sameAnchors(await dailyAnchors(page),baseline,'diagnostic choice saved');
      await page.locator('#telemetryEnabled').check();
      await page.evaluate(()=>window.finishTelemetry({available:false}));
      await page.locator('#telemetryFeedback').filter({hasText:'设置未保存'}).waitFor();
      assert.equal(await page.locator('#telemetryEnabled').isChecked(),false);
      sameAnchors(await dailyAnchors(page),baseline,'diagnostic choice failure');
      assert.deepEqual(page.uiErrors,[]);
    }finally{await page.close();}
  }finally{await browser.close();}
});
test('More navigation retains its right-column origin and returns without moving the home',{timeout:60000},async()=>{
  const browser=await chromium.launch({executablePath:process.env.NORA_CHROMIUM||undefined});
  try{
    const page=await dailyInteractionPage(browser,{width:1120,height:680});
    try{
      const baseline=await dailyAnchors(page),origin=await page.locator('#main').boundingBox(),message=await page.locator('#message').boundingBox();
      for(const action of ['settings','model','claw','community','update','logs']){
        if(action==='model') await page.locator('#management > [data-action="model"]').click();
        else {
          await page.locator('#moreButton').click();
          sameAnchors(await dailyAnchors(page),baseline,'More opened');
          await page.locator(`#more [data-action="${action}"]`).click();
        }
        const target=action==='logs'?'.operation-console':action==='model'?'#provider':'#inline';
        await page.locator(target).waitFor();
        const actualOrigin=await page.locator('#main').boundingBox();
        assert.ok(Math.abs(actualOrigin.x-origin.x)<=1&&Math.abs(actualOrigin.y-origin.y)<=1,`${action} moved the whole right column`);
        if(action!=='logs')assert.equal(await page.locator('#launchbar').isVisible(),false,'home actions are not carried into a feature page');
        if(action!=='logs')assert.ok(Math.abs((await page.locator('#message').boundingBox()).x-message.x)<=1,`${action} moved the content sideways`);
        await page.getByRole('button',{name:action==='logs'?'返回操作页':'返回酒馆',exact:true}).click();
        await page.locator('.services').waitFor();
        sameAnchors(await dailyAnchors(page),baseline,`${action} returned`);
        assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#moreButton')||
          document.activeElement===document.querySelector('#management > [data-action="model"]')),true,'return restores the initiating control');
      }
      assert.deepEqual(page.uiErrors,[]);
    }finally{await page.close();}
  }finally{await browser.close();}
});
test('feature pages center their whole content when it fits the original right area',{timeout:30000},async()=>{
  const browser=await chromium.launch({executablePath:process.env.NORA_CHROMIUM||undefined});
  try{
    const page=await dailyInteractionPage(browser,{width:1120,height:680},{versionResult:{state:'blocked',available:false,
      current:'2.4.2',latest:'v2.4.2',launcherVersion:'2.0.2',checkedAt:'2026-10-08T05:51:27Z',latestConfirmed:true,
      releaseUrl:'https://github.com/LoveMaker-art/noras-tavern/releases/tag/v2.4.2',
      compatibilityError:'线上发布与当前启动器不兼容。\n当前安装和数据未修改。\n请等待兼容版本发布，勿反复重试。'}});
    try{
      for(const action of ['update','settings','claw','community','model']){
        if(action==='model')await page.locator('#management > [data-action="model"]').click();
        else{await page.locator('#moreButton').click();await page.locator(`#more [data-action="${action}"]`).click();}
        await page.getByRole('button',{name:'返回酒馆',exact:true}).waitFor();
        if(action==='model')await page.locator('#provider').waitFor();
        for(const viewport of [{width:1120,height:680},{width:1120,height:652},{width:900,height:612}]){
          await page.setViewportSize(viewport);
          const placement=await page.evaluate(async()=>{
            await document.fonts.ready;
            await Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
            const scroll=document.querySelector('.scroll'),content=document.querySelector('.dialogue-group');
            const outer=scroll.getBoundingClientRect(),inner=content.getBoundingClientRect(),style=getComputedStyle(scroll);
            const top=outer.top+parseFloat(style.paddingTop),bottom=outer.bottom-parseFloat(style.paddingBottom);
            return {above:inner.top-top,below:bottom-inner.bottom,fits:inner.height<=bottom-top+1};
          });
          assert.equal(placement.fits,true,`${action} content should fit ${viewport.width}x${viewport.height}`);
          assert.ok(Math.abs(placement.above-placement.below)<=2,
            `${action} should center the whole content; top gap=${placement.above}px bottom gap=${placement.below}px`);
          if(process.env.NORA_SCREENSHOT&&action==='update'&&viewport.height===680)
            await page.screenshot({path:process.env.NORA_SCREENSHOT,animations:'disabled'});
        }
        await page.getByRole('button',{name:'返回酒馆',exact:true}).click();
      }
      assert.deepEqual(page.uiErrors,[]);
    }finally{await page.close();}
  }finally{await browser.close();}
});
test('background refresh and version results preserve More, model drafts and body anchors',{timeout:20000},async()=>{
  const browser=await chromium.launch({executablePath:process.env.NORA_CHROMIUM||undefined});
  try{
    const page=await dailyInteractionPage(browser,{width:1120,height:680},{deferVersion:true});
    try{
      const baseline=await dailyAnchors(page);
      await page.waitForFunction(()=>typeof window.finishVersion==='function');
      await page.evaluate(()=>window.finishVersion({state:'blocked',available:true,latest:'2.4.3',launcherVersion:'2.0.2'}));
      await page.locator('#versionNotice').waitFor();
      sameAnchors(await dailyAnchors(page),baseline,'background version notice');
      await page.locator('#moreButton').focus();await page.keyboard.press('Enter');
      await page.locator('#moreClose').waitFor();
      assert.equal(await page.evaluate(()=>document.activeElement.id),'moreClose');
      const reads=await page.evaluate(()=>window.statusReads);
      await page.evaluate(()=>{window.state.gatewayRunning=false;window.state.clawchatConnected=false;});
      await page.waitForFunction(reads=>window.statusReads>reads,reads);
      assert.equal(await page.locator('#more').isVisible(),true,'polling does not close More');
      sameAnchors(await dailyAnchors(page),baseline,'background service change');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#more').isVisible(),false);
      assert.equal(await page.evaluate(()=>document.activeElement.id),'moreButton');
      await page.locator('#management > [data-action="model"]').click();
      await page.locator('#key').fill('test-only-draft');await page.locator('#model').fill('draft-model');
      await page.getByRole('button',{name:'显示或隐藏 API Key'}).click();
      assert.equal(await page.locator('#key').getAttribute('type'),'text');
      await page.getByRole('button',{name:'显示或隐藏 API Key'}).click();
      assert.equal(await page.locator('#key').getAttribute('type'),'password');
      await page.locator('#loadModels').click();
      await page.locator('#feedback').filter({hasText:'模型列表已更新'}).waitFor();
      const formReads=await page.evaluate(()=>window.statusReads);
      await page.evaluate(()=>{window.state.gatewayRunning=true;window.state.clawchatConnected=true;});
      await page.waitForFunction(reads=>window.statusReads>reads,formReads);
      assert.equal(await page.locator('#key').inputValue(),'test-only-draft');
      assert.equal(await page.locator('#model').inputValue(),'draft-model');
      await page.getByRole('button',{name:'返回酒馆',exact:true}).click();
      sameAnchors(await dailyAnchors(page),baseline,'model draft discarded by explicit return');
      assert.deepEqual(page.uiErrors,[]);
    }finally{await page.close();}
  }finally{await browser.close();}
});
test('uninstall confirmation, stop-all and late model responses cannot repeat or hijack navigation',{timeout:20000},async()=>{
  const browser=await chromium.launch({executablePath:process.env.NORA_CHROMIUM||undefined});
  try{
    const page=await dailyInteractionPage(browser,{width:1120,height:680});
    try{
      const baseline=await dailyAnchors(page);
      await page.locator('#moreButton').click();await page.locator('[data-action="uninstall"]').click();
      await page.waitForFunction(()=>typeof window.finishUninstall==='function');
      sameAnchors(await dailyAnchors(page),baseline,'waiting for uninstall confirmation');
      await page.locator('#moreButton').click();
      assert.equal(await page.locator('[data-action="uninstall"]').isDisabled(),true);
      assert.equal(await page.locator('[data-action="logs"]').isEnabled(),true);
      await page.locator('[data-action="logs"]').click();await page.locator('#consoleOutput').waitFor();
      await page.locator('#consoleBack').click();await page.evaluate(()=>window.finishUninstall({started:false}));
      await page.waitForFunction(()=>!document.querySelector('[data-action="uninstall"]').disabled);
      assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='uninstall').length),1);
      sameAnchors(await dailyAnchors(page),baseline,'uninstall cancelled');
      await page.locator('#moreButton').click();await page.locator('#stopAll').click();
      await page.waitForFunction(()=>typeof window.finishAction==='function');
      sameAnchors(await dailyAnchors(page),baseline,'stop all busy');
      await page.evaluate(()=>window.finishAction({running:false,gatewayRunning:false,clawchatConnected:false}));
      await page.waitForFunction(()=>document.querySelectorAll('[data-state="stopped"]').length===2);
      sameAnchors(await dailyAnchors(page),baseline,'stop all completed');
      await page.evaluate(()=>{window.NoraLauncherBridge.modelProviders=()=>new Promise((resolve,reject)=>{window.finishProviders={resolve,reject};});});
      await page.locator('#management > [data-action="model"]').click();
      await page.waitForFunction(()=>Boolean(window.finishProviders));
      await page.getByRole('button',{name:'返回酒馆',exact:true}).click();
      await page.evaluate(()=>window.finishProviders.reject(new Error('late old response')));
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
      assert.equal(await page.locator('.services').isVisible(),true,'late provider failure cannot replace returned home');
      assert.deepEqual(page.uiErrors,[]);
    }finally{await page.close();}
  }finally{await browser.close();}
});
test('real error page renders package replacement without replaying the incompatible installation',async()=>{
  const browser=await chromium.launch({executablePath:process.env.NORA_CHROMIUM||undefined});
  try{
    const page=await browser.newPage({viewport:{width:1120,height:680}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{
      window.calls=[];
      const failure={code:'RELEASE_EXECUTOR_INCOMPATIBLE',guidance:{title:'安装包与当前启动器不兼容。',
        detail:'原安装和数据未修改。',next:'请下载新版完整安装包；保留原数据目录，不要反复重试此安装包。'}};
      const state={installed:false,hermesInstalled:false,noraHome:'/isolated/NoraTavern',operation:{
        schema:'nora-operation/1',operationId:'22222222-2222-4222-8222-222222222222',kind:'install',
        state:'failed',effectState:'untouched',verification:'failed',snapshotSequence:2,
        allowedActions:['replace-launcher','logs'],primaryFailure:failure,currentFailure:failure}};
      window.NoraLauncherBridge={status:async()=>state,telemetry:async()=>({available:true,enabled:true}),
        openExternal:async url=>{window.calls.push(['open',url]);return {ok:true};},openLogs:async()=>({ok:true}),
        install:async()=>{window.calls.push(['install']);throw Error('unsafe replay');},
        resumeOperation:async()=>{window.calls.push(['resume']);throw Error('unsafe replay');}};
    });
    await page.goto(url);
    const heading=page.locator('#copy');await heading.filter({hasText:'安装包与当前启动器不兼容。'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'重试',exact:true}).count(),0);
    await page.getByRole('button',{name:'下载新版完整启动器',exact:true}).click();
    await page.locator('#launcherDownloadFeedback').filter({hasText:'保留原数据目录'}).waitFor();
    assert.equal(await heading.textContent(),'安装包与当前启动器不兼容。');
    assert.deepEqual(await page.evaluate(()=>window.calls),[['open','https://github.com/LoveMaker-art/noras-tavern/releases/latest']]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('real controller waits for backend results through install, model, pairing, launch and stop', async () => {
  const browser = await chromium.launch({ executablePath: process.env.NORA_CHROMIUM || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 680 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.state = { noraHome: '/isolated/NoraTavern', installed: false, hermesInstalled: false,
        modelConfigured: false, clawchatPaired: false, clawchatConnected: false, gatewayRunning: false,
        running: false, port: 8799, url: 'http://127.0.0.1:8799', installer: { setupCompleted: false } };
      window.calls = [];
      const action = name => options => {
        window.calls.push(name);
        window.lastOptions = options;
        options.onEvent?.({ event: 'task', task: `backend-${name}` });
        return new Promise((resolve, reject) => { window.settle = (patch, error) => {
          Object.assign(window.state, patch);
          if (error) {
            const operation = { schema:'nora-operation/1',operationId:'22222222-2222-4222-8222-222222222222',
              kind:name,state:'failed',effectState:'untouched',verification:'failed',snapshotSequence:2,
              allowedActions:['retry','recheck','logs'],primaryFailure:{code:'LOCAL_CONNECT_FAILED',
                guidance:{title:'本地连接未完成。',detail:'服务尚未连接，可以重试一次。'}} };
            window.state.operation = operation;
            reject(Object.assign(new Error(error),{operation,guidance:operation.primaryFailure.guidance}));
          } else { window.state.operation=null; resolve({ ...window.state }); }
        }; });
      };
      window.NoraLauncherBridge = {
        resumeOperation: options => {
          if(options.operationId!==window.state.operation?.operationId||options.snapshotSequence!==2)throw new Error('Stale operation');
          return action(window.state.operation.kind)(options);
        },
        status: async () => ({ ...window.state }), telemetry: async () => ({ available: true, enabled: true }),
        install: action('install'), start: action('start'), stop: action('stop'), pair: action('pair'),
        modelProviders: async () => ({ ok: true, providers: [{ id: 'custom', label: '自定义模型', custom: true }] }),
        saveAndTestModel: async payload => { window.calls.push('model'); window.state.modelConfigured = true; },
        openExternal: async url => { window.calls.push('open'); }, cancel: async () => ({ ok: true }),
        openClawChat: async () => {}, checkUpdate: async () => ({ available: false, state:'blocked', latest: 'v1.0.0' }),
      };
    });
    await page.goto(url);
    await page.getByRole('button', { name: '安装酒馆', exact: true }).click();
    await page.waitForFunction(() => window.calls.includes('install'));
    assert.equal(await page.locator('#provider').count(), 0);
    assert.equal(await page.locator('#jobPercent').textContent(), '');
    await page.evaluate(() => window.settle({ installed: true, hermesInstalled: true }));
    await page.locator('#key').fill('test-only');
    await page.locator('#endpoint').fill('https://relay.example/v1');
    await page.locator('#model').fill('test-model');
    if (process.env.NORA_SCREENSHOT) await page.screenshot({ path: process.env.NORA_SCREENSHOT, animations: 'disabled' });
    await page.getByRole('button', { name: '验证并继续', exact: true }).click();
    await page.locator('#pairCode').waitFor();
    const pairingLayout = () => page.evaluate(async () => {
      const input = document.getElementById('pairCode');
      const submit = input.form.querySelector('[type="submit"]');
      await Promise.all([document.getElementById('message'), document.getElementById('inline')]
        .flatMap(element => element.getAnimations()).map(animation => animation.finished.catch(() => {})));
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth
          && Boolean(hit && (hit === element || element.contains(hit)));
      };
      return { inputVisible: visible(input), submitVisible: visible(submit),
        inputAboveSubmit: input.getBoundingClientRect().bottom <= submit.getBoundingClientRect().top,
        scrollingAreas: ['message', 'inline'].filter(id => {
          const element = document.getElementById(id);
          return /auto|scroll/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1;
        }) };
    });
    for (const viewport of [{ width: 1120, height: 680 }, { width: 900, height: 640 }]) {
      await page.setViewportSize(viewport);
      assert.deepEqual(await pairingLayout(), { inputVisible: true, submitVisible: true,
        inputAboveSubmit: true, scrollingAreas: [] }, `pairing layout at ${viewport.width}x${viewport.height}`);
    }
    await page.getByRole('button', { name: '配对并继续', exact: true }).click();
    assert.match(await page.locator('#pairFeedback').textContent(), /请填写配对码/);
    assert.deepEqual(await pairingLayout(), { inputVisible: true, submitVisible: true,
      inputAboveSubmit: true, scrollingAreas: [] }, 'pairing validation feedback stays in view');
    await page.setViewportSize({ width: 1120, height: 680 });
    await page.locator('#pairCode').fill('test-code');
    await page.getByRole('button', { name: '配对并继续', exact: true }).click();
    await page.waitForFunction(() => window.calls.includes('pair'));
    await page.evaluate(() => window.settle({ clawchatPaired: true }));
    await page.waitForFunction(() => window.calls.includes('start'));
    assert.equal(await page.locator('#launchbar').isVisible(), false);
    await page.evaluate(() => window.settle({}, 'connection failed'));
    await page.getByRole('button', { name: '重新尝试启动', exact: true }).click();
    await page.waitForFunction(() => window.calls.filter(c => c === 'start').length === 2);
    await page.evaluate(() => window.settle({ running: true, gatewayRunning: true, clawchatConnected: true, installer: { setupCompleted: true } }));
    await page.locator('#conversationGuidance').waitFor({state:'visible'});
    await page.locator('#versionNotice').waitFor();
    const dailyLayout = () => page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{})));
      const ids=['message','inline'];
      const scrollingAreas=ids.filter(id=>{
        const element=document.getElementById(id);
        return /auto|scroll/.test(getComputedStyle(element).overflowY)&&element.scrollHeight>element.clientHeight+1;
      });
      const selectors=['#copy','#conversationGuidance','.services','#versionNotice','#management','#launch','#telemetryNotice'];
      const clipped=selectors.filter(selector=>{
        const element=document.querySelector(selector),rect=element.getBoundingClientRect();
        if(!element.getClientRects().length)return false;
        if(rect.top<0||rect.bottom>innerHeight||rect.left<0||rect.right>innerWidth)return true;
        for(let owner=element.parentElement;owner;owner=owner.parentElement){
          const style=getComputedStyle(owner),bounds=owner.getBoundingClientRect();
          if(/auto|scroll|hidden|clip/.test(style.overflowY)&&(rect.top<bounds.top-1||rect.bottom>bounds.bottom+1))return true;
        }
        return false;
      });
      return {scrollingAreas,clipped};
    });
    for(const viewport of [{width:1120,height:652},{width:900,height:612},{width:1120,height:680}]){
      await page.setViewportSize(viewport);
      if(process.env.NORA_SCREENSHOT)await page.screenshot({path:process.env.NORA_SCREENSHOT.replace('.png',`-completion-${viewport.width}x${viewport.height}.png`),animations:'disabled'});
      assert.deepEqual(await dailyLayout(),{scrollingAreas:[],clipped:[]},`completion layout at ${viewport.width}x${viewport.height}`);
    }
    const completionAnchors=await dailyAnchors(page);
    await page.locator('#launch').click();
    assert.deepEqual(await dailyLayout(),{scrollingAreas:[],clipped:[]},'daily layout after opening Tavern');
    await page.waitForFunction(() => window.calls.includes('open'));
    sameAnchors(await dailyAnchors(page),completionAnchors,'first completion opening Tavern');
    await page.getByRole('button', { name: '停止诺拉', exact: true }).click();
    await page.waitForFunction(() => window.calls.includes('stop'));
    assert.equal(await page.evaluate(() => window.lastOptions.service), 'nora');
    sameAnchors(await dailyAnchors(page),completionAnchors,'first completion stopping Nora');
    await page.evaluate(() => window.settle({ gatewayRunning: false, clawchatConnected: false }));
    await page.locator('[data-service="nora"][data-state="stopped"]').waitFor();
    assert.equal(await page.locator('[data-service="tavern"]').getAttribute('data-state'), 'running');
    sameAnchors(await dailyAnchors(page),completionAnchors,'first completion stopped Nora');
    await page.locator('#launch').click();
    await page.waitForFunction(() => window.calls.filter(c => c === 'open').length === 2);
    assert.equal(await page.evaluate(() => window.state.gatewayRunning), false);
    await page.getByRole('button', { name: '停止酒馆', exact: true }).click();
    await page.waitForFunction(() => window.calls.filter(c => c === 'stop').length === 2);
    assert.equal(await page.evaluate(() => window.lastOptions.service), 'tavern');
    await page.evaluate(() => window.settle({ running: false }));
    await page.locator('[data-service="tavern"][data-state="stopped"]').waitFor();
    await page.locator('#launch').click();
    await page.waitForFunction(() => window.calls.filter(c => c === 'start').length === 3);
    assert.equal(await page.evaluate(() => window.lastOptions.service), 'tavern');
    await page.evaluate(() => window.settle({ running: true }));
    await page.waitForFunction(() => window.calls.filter(c => c === 'open').length === 3);
    await page.locator('#moreButton').click();
    assert.equal(await page.locator('#more').isVisible(), true);
    assert.equal(await page.locator('.portrait img').getAttribute('draggable'), 'false');
    if (process.env.NORA_SCREENSHOT) await page.screenshot({ path: process.env.NORA_SCREENSHOT.replace('.png', '-daily.png'), animations: 'disabled' });
    assert.equal(await page.locator('#steps').isVisible(), false);
    assert.equal(await page.locator('#launchbar').isVisible(), false);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#more').isVisible(), false);
    assert.equal(await page.locator('#launchbar').isVisible(), true);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.calls), ['install', 'model', 'pair', 'start', 'start', 'open', 'stop', 'open', 'stop', 'start', 'open']);
  } finally { await browser.close(); }
});

test('all launcher routes keep visible content and actions reachable without nested scrolling', {timeout:60000}, async()=>{
  const browser=await chromium.launch({executablePath:process.env.NORA_CHROMIUM||undefined});
  const ready={installed:true,hermesInstalled:true,noraInstalled:true,modelConfigured:true,clawchatPaired:true,
    clawchatProfileReady:true,clawchatConnected:true,running:true,gatewayRunning:true,systemReady:true,
    installer:{setupCompleted:true},version:'2.4.2',noraHome:'/isolated/NoraTavern'};
  const failure={schema:'nora-operation/1',operationId:'22222222-2222-4222-8222-222222222222',kind:'install',
    state:'failed',effectState:'untouched',allowedActions:['recheck','logs'],primaryFailure:{code:'TAVERN_START_TIMEOUT',
      guidance:{title:'酒馆启动超时。',detail:'等待120秒后，酒馆仍未就绪。',next:'请查看并复制本次日志，暂勿重复安装。'}}};
  const scenarios=[
    ['welcome',{installed:false,hermesInstalled:false,installer:{setupCompleted:false}},'#copy'],
    ['model',{...ready,modelConfigured:false,installer:{setupCompleted:false}},'#provider'],
    ['pair',{...ready,clawchatPaired:false,installer:{setupCompleted:false}},'#pairCode'],
    ['model-pending',{...ready,modelSyncPending:true,installer:{setupCompleted:false}},'#inline .button'],
    ['daily',ready,'#launch'],
    ['daily-warning',{...ready,clawchatConnected:false,warning:'ClawChat 暂未连通，请在更多中检查连接。'},'#launch'],
    ['daily-stopped',{...ready,running:false,gatewayRunning:false,clawchatConnected:false,systemReady:undefined},'#launch'],
    ['daily-nora-stopped',{...ready,gatewayRunning:false,clawchatConnected:false},'#launch'],
    ['repair',{...ready,systemReady:false,systemProblems:['当前运行环境不完整，请修复安装。']},'#inline .button'],
    ['status-unknown',{...ready,statusUnavailable:true,warning:'状态查询暂时不可用。'},'#inline'],
    ['task',{...ready,busy:true,installer:{setupCompleted:false,phase:'install',task:'正在下载酒馆资源。'}},'#inline'],
    ['error',{...ready,operation:failure},'#inline .outcome-actions'],
    ['recoverable',{...ready,operation:{...failure,state:'interrupted',allowedActions:['recover','recheck','logs']},
      updateRecovery:{canRecover:true,restoreVersion:'2.4.1',backup:'/isolated/backup',log:'/isolated/update.log'}},'#recoverUpdate'],
    ['recovery-blocked',{...ready,operation:{...failure,state:'blocked',allowedActions:['recheck','logs']},
      updateRecovery:{canRecover:false,reason:'备份尚未通过检查。',backup:'/isolated/backup'}},'.recovery-details'],
    ['recovery-details',{...ready,operation:{...failure,state:'interrupted',allowedActions:['recover','recheck','logs']},
      updateRecovery:{canRecover:true,restoreVersion:'2.4.1',backup:'/isolated/backup',log:'/isolated/update.log'}},'#recoverUpdate'],
    ['launcher-recovery',{...ready,launcherRecovery:{canRecover:true,backup:'/isolated/launcher-backup',log:'/isolated/launcher.log'}},'#recoverLauncher'],
    ['restored-start-failed',{...ready,operation:{...failure,state:'interrupted',allowedActions:['start-restored','recheck','logs'],recoveryOutcome:'files-restored-start-failed'},
      updateRecovery:{canRecover:true,restoreVersion:'2.4.1',backup:'/isolated/backup',log:'/isolated/update.log'}},'#recoverUpdate'],
    ['more',ready,'#launch'],['settings',ready,'#launch'],['update-check',ready,'#launch'],['logs',ready,'#launch'],
    ['settings-long-path',{...ready,noraHome:'C:\\Users\\administrator\\AppData\\Local\\NoraTavern-Tests\\launcher-candidate-3b1bcd4bb196-telemetry\\NoraTavern'},'#launch'],
    ['telemetry-unavailable',{...ready,telemetryUnavailable:true},'#launch'],
    ['model-edit',ready,'#launch'],['model-local',ready,'#launch'],['model-builtin',ready,'#launch'],
    ['model-error',ready,'#launch'],['pair-edit',ready,'#launch'],['pair-replace',ready,'#launch'],['community',ready,'#launch'],
    ['download',{installed:false,hermesInstalled:false,installer:{setupCompleted:false}},'#copy'],
  ];
  const results=[];
  try{
    for(const [name,state,selector] of scenarios){
      const page=await browser.newPage({viewport:{width:1120,height:680}}),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      try{
        await page.addInitScript(state=>{
          window.NoraLauncherBridge={status:async()=>state,telemetry:async()=>{if(state.telemetryUnavailable)throw Error('unavailable');return {available:true,enabled:true};},
            checkUpdate:async()=>({state:'blocked',available:false,current:'2.4.2',latest:'2.4.2'}),
            modelProviders:async()=>({ok:true,providers:[{id:'custom',label:'自定义模型',custom:true},{id:'deepseek',label:'DeepSeek',signupUrl:'https://example.com/key'}]}),
            modelOptions:async()=>{throw Object.assign(new Error('模型服务未响应。'),{guidance:{title:'模型连接未完成。',detail:'请核对接口地址与 API Key，再重新验证。'}});},
            recoverOperation:async()=>state,recheckOperation:async()=>state,recoverLauncher:async()=>state,
            install:options=>{options.onEvent({event:'progress',stage:'download',task:'正在下载酒馆资源。',progress:{current:100,total:200}});return new Promise(()=>{});},
            openInstallDirectory:async()=>({ok:true}),
            operationLogs:async()=>({operationId:'22222222-2222-4222-8222-222222222222',cursor:{offset:200},
              records:Array.from({length:200},(_,i)=>({id:`record-${i}`,text:`[INFO] execution record ${i}`})),missing:[],hasMore:false}),
          };
        },state);
        await page.goto(url);await page.locator(selector).first().waitFor({state:'visible',timeout:3000});
        await page.evaluate(async()=>{
          await document.fonts.ready;
          await Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
        });
        const bodyBefore=await page.locator('#copy').boundingBox();
        if(['more','settings','settings-long-path','update-check','logs'].includes(name)){
          await page.locator('#moreButton').click();
          assert.deepEqual(await page.locator('#copy').boundingBox(),bodyBefore,'opening More preserves body geometry');
          if(name!=='more')await page.locator(`#more [data-action="${({'settings':'settings','settings-long-path':'settings','update-check':'update','logs':'logs'})[name]}"]`).click();
          if(name==='logs')await page.locator('#consoleOutput span').first().waitFor({timeout:3000});
        }
        if(['model-edit','model-local','model-builtin','model-error'].includes(name)){
          await page.locator('[data-action="model"]').first().click();await page.locator('#authMode').waitFor();
          if(name==='model-local')await page.locator('#authMode').selectOption('none');
          if(name==='model-builtin')await page.locator('#provider').selectOption('deepseek');
          if(name==='model-error'){
            await page.locator('#key').fill('test-only');await page.locator('#loadModels').click();
            await page.locator('#feedback.error').waitFor();
          }
        }
        if(['pair-edit','pair-replace','community'].includes(name)){
          await page.locator('#moreButton').click();
          await page.locator(`#more [data-action="${name==='community'?'community':'claw'}"]`).click();
          if(name==='pair-replace'){
            await page.getByRole('button',{name:'重新配对',exact:true}).click();
            await page.locator('#inline button[type="submit"]').click();
          }
        }
        if(name==='recovery-details')await page.locator('.recovery-details summary').click();
        if(name==='download'){
          await page.getByRole('button',{name:'安装酒馆',exact:true}).click();await page.locator('#jobTitle').waitFor();
        }
        if(name==='model'||name==='pair')await page.locator('#inline button[type="submit"]').click();
        for(const viewport of [{width:1120,height:680},{width:1120,height:652},{width:900,height:612}]){
          await page.setViewportSize(viewport);
          const facts=await page.evaluate(async name=>{
            await document.fonts.ready;
            await Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
            const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
            const within=e=>{
              const r=e.getBoundingClientRect();
              if(r.top<0||r.bottom>innerHeight+1||r.left<0||r.right>innerWidth+1)return false;
              for(let owner=e.parentElement;owner;owner=owner.parentElement){
                const style=getComputedStyle(owner),b=owner.getBoundingClientRect();
                if(/auto|scroll|hidden|clip/.test(style.overflowY)&&(r.top<b.top-1||r.bottom>b.bottom+1))return false;
                if(style.position==='fixed')break;
              }return true;
            };
            const scope=name==='more'?document.querySelector('#more'):name==='logs'?document.querySelector('.operation-console'):document.querySelector('main');
            const allowed=name==='more'?['more-actions']:name==='logs'?['console-output']:name==='recovery-details'?['recovery-details']:[];
            const scrollers=[...scope.querySelectorAll('*')].filter(e=>visible(e)&&/auto|scroll/.test(getComputedStyle(e).overflowY)&&e.scrollHeight>e.clientHeight+1);
            const clipping=[...scope.querySelectorAll('button,input,select,#copy,#subcopy,#telemetryNotice,.conversation-guidance,.model-feedback,.settings-row,.launch-hint')]
              .filter(e=>visible(e)&&!e.closest('.console-output')&&!within(e));
            const covered=[...scope.querySelectorAll('button,input,select')].filter(e=>{
              if(!visible(e)||!within(e))return false;
              const r=e.getBoundingClientRect();
              return [r.top+2,r.top+r.height/2,r.bottom-2].some(y=>{
                const hit=document.elementFromPoint(r.left+r.width/2,y);
                return !hit||(hit!==e&&!e.contains(hit));
              });
            });
            return {unexpectedScrollers:scrollers.filter(e=>!allowed.some(c=>e.classList.contains(c))).map(e=>e.id||e.className),
              clipped:clipping.map(e=>e.id||e.getAttribute('aria-label')||e.textContent.trim()),
              covered:covered.map(e=>e.id||e.getAttribute('aria-label')||e.textContent.trim()),
              logScrollable:name==='logs'?document.querySelector('#consoleOutput').scrollHeight>document.querySelector('#consoleOutput').clientHeight:null,
              geometry:scrollers.filter(e=>!allowed.some(c=>e.classList.contains(c))).map(e=>({id:e.id,height:e.clientHeight,content:e.scrollHeight})),
              bounds:clipping.map(e=>({id:e.id,top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom}))};
          },name);
          if(process.env.NORA_SCREENSHOT&&(facts.unexpectedScrollers.length||facts.clipped.length||facts.covered.length))await page.screenshot({path:process.env.NORA_SCREENSHOT.replace('.png',`-${name}-${viewport.width}x${viewport.height}.png`),animations:'disabled'});
          results.push({name,viewport,...facts,errors:errors.slice()});
        }
        if(name==='more'){
          const coveredBody=await page.locator('#copy').boundingBox();
          await page.keyboard.press('Escape');assert.deepEqual(await page.locator('#copy').boundingBox(),coveredBody,'closing More preserves body geometry');
          assert.equal(await page.locator('#more').isVisible(),false);
        }
        if(name==='logs'){
          await page.locator('#consoleOutput').hover();const before=await page.locator('#consoleOutput').evaluate(e=>e.scrollTop);
          await page.mouse.wheel(0,-200);await page.locator('#consoleLatest').waitFor({state:'visible'});
          await page.waitForFunction(before=>document.querySelector('#consoleOutput').scrollTop<before,before,{timeout:2000});
          await page.locator('#consoleBack').click();assert.equal(await page.locator('#launch').isVisible(),true);
        }
      }catch(error){results.push({name,error:error.message});}
      finally{await page.close();}
    }
    if(process.env.NORA_LAYOUT_REPORT)require('node:fs').writeFileSync(process.env.NORA_LAYOUT_REPORT,JSON.stringify(results,null,2)+'\n');
    const failed=results.filter(r=>r.error||r.errors.length||r.unexpectedScrollers.length||r.clipped.length||r.covered.length||r.logScrollable===false);
    assert.deepEqual(failed,[],JSON.stringify(failed,null,2));
    assert.equal(results.length,scenarios.length*3);
  }finally{await browser.close();}
});
