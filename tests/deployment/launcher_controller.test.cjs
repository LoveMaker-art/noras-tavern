const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { chromium } = require(process.env.NORA_PLAYWRIGHT || 'playwright');
const url = pathToFileURL(path.resolve(__dirname, '../installer/launcher-conversation-prototype.html')).href;
async function openModelEditor(page) {
  await page.locator('#management > [data-action="model"]').click();
  await page.getByRole('button', {name:'+ 添加模型',exact:true}).click();
}
async function closeModelEditor(page) {
  await page.getByRole('button',{name:'返回模型设置',exact:true}).click();
  await page.getByRole('button',{name:'返回酒馆',exact:true}).click();
}
test('model addition keeps an interrupted result queryable before a deliberate retry', {timeout:15000}, async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.NORA_CHROMIUM||undefined});
  try{
    const page=await browser.newPage({viewport:{width:1120,height:680}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{
      let current={configured:true,provider:'custom',model:'old-model',baseUrl:'https://fixture.invalid/v1',authMode:'key'};
      const operation={operationId:'model-save-fixture',kind:'model',snapshotSequence:4,state:'failed',busy:false,
        effectState:'unknown',verification:'unconfirmed',recoveryOutcome:'recovery-required',allowedActions:['recheck','logs']};
      window.modelWrites=0;window.modelOperation=operation;window.modelQueryFails=false;
      window.NoraLauncherBridge={
        status:async()=>({installed:true,hermesInstalled:true,noraInstalled:true,systemReady:true,setupCompleted:true,
          modelConfigured:true,clawchatPaired:true,clawchatConnected:true,gatewayRunning:true,running:true}),
        checkUpdate:async()=>({state:'current',available:false}),
        modelProviders:async()=>({ok:true,providers:[{id:'custom',label:'自定义模型',custom:true}],current}),
        operationSnapshot:async id=>{
          if(id!==operation.operationId)throw new Error('wrong task');
          if(window.modelQueryFails)throw new Error('任务查询暂时中断。');
          return window.modelOperation;
        },
        saveAndTestModel:async payload=>{
          if(++window.modelWrites===1)throw Object.assign(new Error('模型保存响应中断。'),{operation});
          current={configured:true,provider:'custom',model:payload.model,baseUrl:payload.baseUrl,authMode:'key'};
          return {ok:true};
        },
      };
    });
    await page.goto(url);await page.locator('.services').waitFor();await openModelEditor(page);
    await page.locator('#key').fill('synthetic-fixture-key');await page.locator('#model').fill('new-model');
    await page.getByRole('button',{name:'验证并保存',exact:true}).click();
    const query=page.locator('#modelStatusRecheck'),submit=page.getByRole('button',{name:'验证并保存',exact:true});
    await query.waitFor({state:'visible'});assert.equal(await submit.isEnabled(),false);
    await query.click();assert.equal(await submit.isEnabled(),false);assert.equal(await page.locator('#model').inputValue(),'new-model');
    await page.evaluate(()=>{window.modelQueryFails=true;});await query.click();
    assert.equal(await query.isEnabled(),true);assert.equal(await submit.isEnabled(),false);
    await page.evaluate(()=>{window.modelQueryFails=false;window.modelOperation={...window.modelOperation,
      snapshotSequence:5,effectState:'untouched',recoveryOutcome:'not-required',allowedActions:['retry','recheck','logs']};});
    await query.click();assert.equal(await submit.isEnabled(),true);
    assert.equal(await page.locator('#key').inputValue(),'synthetic-fixture-key');
    assert.equal(await page.evaluate(()=>window.modelWrites),1,'querying does not invoke the model writer');
    await submit.click();await page.locator('.model-name').filter({hasText:'new-model'}).waitFor();
    assert.equal(await page.evaluate(()=>window.modelWrites),2);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
test('model task requery keeps writes blocked until the original committed task closes', {timeout:15000}, async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.NORA_CHROMIUM||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1120,height:680}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    let operation={operationId:'original-delete',kind:'model',snapshotSequence:7,state:'failed',busy:false,
      effectState:'changed',verification:'unconfirmed',recoveryOutcome:'recovery-required'};
    const current={configured:true,provider:'custom',model:'keep',selectedId:'keep',models:[
      {id:'keep',provider:'custom',model:'keep',selected:true,available:true},
      {id:'remove',provider:'custom',model:'remove',available:true}]};
    window.confirmOutcome=false;window.deleteWrites=0;window.rechecked=[];
    window.NoraLauncherBridge={
      status:async()=>({installed:true,hermesInstalled:true,noraInstalled:true,systemReady:true,setupCompleted:true,
        modelConfigured:true,clawchatPaired:true,clawchatConnected:true,gatewayRunning:true,running:true}),
      checkUpdate:async()=>({state:'current',available:false}),
      modelProviders:async()=>({ok:true,providers:[{id:'custom',label:'自定义模型',custom:true}],current}),
      operationSnapshot:async id=>{if(id!==operation.operationId)throw new Error('wrong operation');return operation;},
      recheckOperation:async payload=>{
        window.rechecked.push(payload.operationId);
        if(window.confirmOutcome)operation={...operation,state:'succeeded',verification:'confirmed',recoveryOutcome:'not-required'};
        return {operation};
      },
      deleteModel:async()=>{window.deleteWrites++;current.models=current.models.filter(row=>row.id!=='remove');
        throw {operation,guidance:{title:'删除结果尚未确认。'}};},
    };
  });
  await page.goto(url);await page.locator('.services').waitFor();
  await page.locator('#management > [data-action="model"]').click();
  await page.getByRole('button',{name:'删除',exact:true}).last().click();
  await page.getByRole('button',{name:'确认删除',exact:true}).click();
  await page.getByRole('button',{name:'重新查询',exact:true}).click();
  await page.getByText('本次模型操作结果尚未确认，请重新查询。',{exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:'+ 添加模型',exact:true}).count(),0);
  await page.evaluate(()=>{window.confirmOutcome=true;});
  await page.getByRole('button',{name:'重新查询',exact:true}).click();
  await page.locator('#modelList .model-row').waitFor();
  assert.equal(await page.locator('.model-row').count(),1);
  assert.equal(await page.getByRole('button',{name:'+ 添加模型',exact:true}).isEnabled(),true);
  assert.equal(await page.evaluate(()=>window.deleteWrites),1);
  assert.deepEqual(await page.evaluate(()=>window.rechecked),['original-delete','original-delete']);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
test('model deletion confirms inline, preserves refused rows and finishes without changing other controls', {timeout:15000}, async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.NORA_CHROMIUM||undefined});
  try{
    for(const viewport of [{width:1120,height:680},{width:760,height:600}]){
      const page=await browser.newPage({viewport}),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(()=>{
        let current={configured:true,provider:'custom',model:'current-model',selectedId:'current',models:[
          {id:'current',provider:'custom',model:'current-model',selected:true,available:true,connectionLabel:'https://current.invalid/v1'},
          {id:'saved',provider:'opencode-go',model:'saved-model',selected:false,available:true,connectionLabel:'备用连接'}]};
        window.deleteWrites=0;window.allowDelete=false;
        window.NoraLauncherBridge={
          status:async()=>({installed:true,hermesInstalled:true,noraInstalled:true,systemReady:true,setupCompleted:true,
            modelConfigured:true,clawchatPaired:true,clawchatConnected:true,gatewayRunning:true,running:true}),
          checkUpdate:async()=>({state:'current',available:false}),
          modelProviders:async()=>({ok:true,providers:[{id:'custom',label:'自定义模型',custom:true}],current}),
          switchModel:async()=>{throw new Error('deletion must not switch');},
          deleteModel:async({id})=>{
            window.deleteWrites++;
            if(!window.allowDelete)throw Object.assign(new Error('会话仍在使用该模型，请先更换对应模型，再删除。'),
              {modelFailureStage:'candidate',guidance:{title:'暂时不能删除该模型。',detail:'会话仍在使用该模型，请先更换对应模型，再删除。'}});
            current={...current,models:current.models.filter(row=>row.id!==id)};return {ok:true,current};
          },
        };
      });
      await page.goto(url);await page.locator('.services').waitFor();
      await page.locator('#management > [data-action="model"]').click();
      const other=page.locator('.model-row[data-selected="false"]');
      assert.equal(await page.locator('.model-row[data-selected="true"] .model-delete').isVisible(),false);
      assert.equal(await page.getByRole('button',{name:'重启诺拉',exact:true}).count(),0);
      await other.getByRole('button',{name:'删除',exact:true}).click();
      await page.getByRole('button',{name:'取消',exact:true}).click();
      assert.equal(await page.evaluate(()=>window.deleteWrites),0);
      await other.getByRole('button',{name:'删除',exact:true}).click();
      await page.evaluate(()=>document.fonts.ready);
      const geometry=await other.evaluate(row=>{
        const prompt=row.querySelector('.model-delete-prompt').getBoundingClientRect();
        const name=row.querySelector('.model-name').getBoundingClientRect();
        const buttons=[...row.querySelectorAll('.model-delete-buttons button')].map(button=>button.getBoundingClientRect());
        return {overflow:row.scrollWidth-row.clientWidth,promptLeft:prompt.left,nameLeft:name.left+20,
          promptCenter:prompt.top+prompt.height/2,buttonCenters:buttons.map(rect=>rect.top+rect.height/2),
          heights:buttons.map(rect=>rect.height),confirm:row.querySelector('.model-row-actions').getBoundingClientRect().bottom,
          limit:document.querySelector('#modelList').getBoundingClientRect().bottom};
      });
      assert.ok(geometry.overflow<=1);assert.ok(geometry.confirm<=geometry.limit+1);
      assert.ok(Math.abs(geometry.promptLeft-geometry.nameLeft)<=1,'confirmation aligns with model text');
      assert.ok(geometry.buttonCenters.every(center=>Math.abs(center-geometry.promptCenter)<=1),'prompt and buttons share one line');
      assert.equal(geometry.heights[0],geometry.heights[1]);
      assert.equal(await other.locator('.model-delete-prompt').textContent(),'删除这个模型？');
      if(process.env.NORA_MODEL_DELETE_VISUAL_DIR){
        fs.mkdirSync(process.env.NORA_MODEL_DELETE_VISUAL_DIR,{recursive:true});
        await page.locator('#main').screenshot({path:path.join(process.env.NORA_MODEL_DELETE_VISUAL_DIR,`delete-${viewport.width}.png`),animations:'disabled'});
      }
      await page.getByRole('button',{name:'确认删除',exact:true}).click();
      await other.getByText('暂时不能删除该模型。',{exact:false}).waitFor();
      assert.equal(await page.locator('.model-row').count(),2);
      await page.evaluate(()=>{window.allowDelete=true;});
      await other.getByRole('button',{name:'重试',exact:true}).click();
      await page.waitForFunction(()=>document.querySelectorAll('.model-row').length===1);
      assert.equal(await page.locator('.model-row').getAttribute('data-model-id'),'current');
      assert.equal(await page.evaluate(()=>window.deleteWrites),2);
      assert.equal(await page.getByRole('button',{name:'+ 添加模型',exact:true}).isEnabled(),true);
      assert.deepEqual(errors,[]);await page.close();
    }
  }finally{await browser.close();}
});
test('saved model rows keep the title, return and add controls fixed while only the list scrolls', {timeout:30000}, async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.NORA_CHROMIUM||undefined});
  try{
    for(const viewport of [{width:1120,height:680},{width:900,height:612},{width:760,height:600},{width:1120,height:900}]){
      const page=await browser.newPage({viewport,reducedMotion:'reduce'}),errors=[];
      const capture=async name=>{
        if(!process.env.NORA_MODEL_VISUAL_DIR)return;
        fs.mkdirSync(process.env.NORA_MODEL_VISUAL_DIR,{recursive:true});
        await page.locator('#main').screenshot({path:path.join(process.env.NORA_MODEL_VISUAL_DIR,
          `${viewport.width}-${viewport.height}-${name}.png`),animations:'disabled'});
      };
      page.on('pageerror',error=>errors.push(error.message));
      try{
        await page.addInitScript(()=>{
          const current={configured:true,provider:'custom',model:'story-model',selectedId:'saved-0',activation:{state:'unknown'},
            models:Array.from({length:12},(_,index)=>({id:`saved-${index}`,provider:'custom',model:index<2?'story-model':`saved-model-${index}`,
              connectionLabel:index===0?'日常连接':index===1?'备用连接':`连接 ${index+1}`,baseUrl:`https://connection-${index+1}.invalid/v1`,
              authMode:'key',selected:index===0,available:true}))};
          window.NoraLauncherBridge={status:async()=>({installed:true,hermesInstalled:true,noraInstalled:true,systemReady:true,
            setupCompleted:true,modelConfigured:true,clawchatPaired:true,clawchatConnected:true,gatewayRunning:true,running:true}),
            checkUpdate:async()=>({state:'current',available:false,current:'fixture',latest:'fixture'}),
            modelProviders:async()=>({ok:true,providers:[{id:'custom',label:'自定义模型',custom:true}],current}),
            switchModel:async()=>({ok:true,current})};
        });
        await page.goto(url);await page.locator('.services').waitFor();
        await page.locator('#management > [data-action="model"]').click();await page.locator('#modelList .model-row').first().waitFor();
        await page.evaluate(()=>document.fonts.ready);
        const facts=()=>page.evaluate(()=>{
          const rect=selector=>{const box=document.querySelector(selector).getBoundingClientRect();return {top:box.top,bottom:box.bottom,left:box.left,right:box.right};};
          const list=document.getElementById('modelList');
          return {title:rect('#copy'),back:rect('.edit-head button'),add:rect('.model-add'),list:rect('#modelList'),
            scrollHeight:list.scrollHeight,clientHeight:list.clientHeight,listOverflow:getComputedStyle(list).overflowY,
            inlineOverflow:getComputedStyle(document.getElementById('inline')).overflowY,
            modelFont:getComputedStyle(document.querySelector('.model-name')).fontSize,
            savedModelFont:getComputedStyle(document.querySelector('.model-row[data-selected="false"] .model-name')).fontSize,
            connectionFont:getComputedStyle(document.querySelector('.model-connection')).fontSize,
            pageHeight:document.documentElement.scrollHeight,height:innerHeight};
        });
        const before=await facts();
        await capture('multiple-closed');
        assert.equal(await page.locator('#copy').textContent(),'模型设置');
        assert.equal(await page.locator('.edit-head > span').textContent(),'');
        assert.equal(before.modelFont,'14px');assert.equal(before.savedModelFont,'14px');assert.equal(before.connectionFont,'12px');
        assert.equal(before.listOverflow,'auto');assert.equal(before.inlineOverflow,'hidden');
        assert.ok(before.scrollHeight>before.clientHeight,`list scrolls at ${JSON.stringify(viewport)}`);
        assert.ok(before.clientHeight>=60);assert.ok(before.list.top>=before.back.bottom-1);
        assert.ok(before.list.bottom<=before.add.top+1);assert.ok(before.add.bottom<=viewport.height);
        assert.ok(before.pageHeight<=before.height+1);
        await page.locator('#modelList').evaluate(list=>{list.scrollTop=list.scrollHeight;});
        const after=await facts();
        for(const control of ['title','back','add'])assert.deepEqual(after[control],before[control],`${control} remains fixed`);
        assert.equal(await page.locator('#modelList').evaluate(list=>list.scrollTop>0),true);
        await page.locator('#modelList').evaluate(list=>{list.scrollTop=0;});
        await page.locator('.model-details summary').first().click();
        const opened=await facts();assert.deepEqual(opened.add,before.add);assert.deepEqual(opened.title,before.title);
        await capture('multiple-expanded');
        assert.equal(await page.locator('#key').count(),0);
        if(process.env.NORA_MODEL_LIST_SCREENSHOT&&viewport.width===1120&&viewport.height===680)
          await page.screenshot({path:process.env.NORA_MODEL_LIST_SCREENSHOT,animations:'disabled'});
        await page.locator('#modelList').evaluate(list=>{list.scrollTop=90;});
        const scrollBefore=await page.locator('#modelList').evaluate(list=>list.scrollTop);
        const anchors=await workflowAnchors(page);await page.getByRole('button',{name:'+ 添加模型',exact:true}).click();
        await page.locator('#provider').waitFor();assert.deepEqual(await workflowAnchors(page),anchors,'the existing form retains the workflow title anchor');
        await page.getByRole('button',{name:'返回模型设置',exact:true}).click();await page.locator('#modelList').waitFor();
        assert.deepEqual(await workflowAnchors(page),anchors,'returning to the list retains the title anchor');
        assert.equal(await page.locator('#modelList').evaluate(list=>list.scrollTop),scrollBefore);
        await page.getByRole('button',{name:'返回酒馆',exact:true}).click();
        await page.evaluate(()=>{
          const model={id:'only-current',provider:'custom',model:'kimi-for-coding',selected:true,available:true,
            connectionLabel:'https://api.fixture.invalid/coding/v1',baseUrl:'https://api.fixture.invalid/coding/v1',authMode:'key'};
          window.NoraLauncherBridge.modelProviders=async()=>({ok:true,providers:[{id:'custom',label:'自定义模型',custom:true}],
            current:{configured:true,provider:'custom',model:model.model,selectedId:model.id,models:[model]}});
        });
        await page.locator('#management > [data-action="model"]').click();await page.locator('#modelList .model-row').waitFor();
        const compact=await page.evaluate(()=>{
          const row=document.querySelector('.model-row').getBoundingClientRect(),add=document.querySelector('.model-add').getBoundingClientRect();
          const connection=document.querySelector('.model-connection').getBoundingClientRect(),details=document.querySelector('.model-details-label').getBoundingClientRect();
          const name=document.querySelector('.model-name').getBoundingClientRect(),rowStyle=getComputedStyle(document.querySelector('.model-row'));
          return {gap:add.top-row.bottom,buttonWidth:add.width,rowWidth:row.width,rowHeight:row.height,
            lineGap:connection.top-name.bottom,detailGap:details.left-connection.right,
            paddingTop:parseFloat(rowStyle.paddingTop),paddingBottom:parseFloat(rowStyle.paddingBottom),
            connectionTop:connection.top,detailsTop:details.top,scrollHeight:document.documentElement.scrollHeight,height:innerHeight};
        });
        assert.ok(compact.gap>=0&&compact.gap<=20,'a short list keeps the add control close to its last model');
        assert.ok(compact.buttonWidth<compact.rowWidth/2,'adding a model remains a secondary action');
        assert.ok(compact.rowHeight>=76&&compact.rowHeight<=96,'a two-line model leaves breathing room without becoming a large card');
        assert.ok(compact.lineGap>=8,'the primary and secondary text have visible separation');
        assert.ok(compact.detailGap>=16,'details follow connection information with a clear gap');
        assert.ok(compact.paddingTop>=12&&compact.paddingBottom>=12,'text does not touch the row edges');
        assert.ok(Math.abs(compact.connectionTop-compact.detailsTop)<=4,'details share the secondary information line');
        assert.ok(compact.scrollHeight<=compact.height+1);
        await capture('single-closed');
        const summary=page.locator('.model-details summary'),beforeOpen=await summary.boundingBox();
        await summary.click();await page.locator('.model-details[open] p').first().waitFor();
        const afterOpen=await summary.boundingBox();assert.deepEqual(afterOpen,beforeOpen,'expansion keeps the disclosure target in place');
        await capture('single-expanded');
        await summary.click();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
        assert.equal(await summary.evaluate(element=>element.matches(':focus-visible')),true);
        const focus=await summary.locator('.model-details-label').evaluate(element=>getComputedStyle(element).textDecorationLine);
        assert.match(focus,/underline/,'keyboard focus stays visible without a heavy summary frame');
        await capture('single-focused');
        await page.getByRole('button',{name:'返回酒馆',exact:true}).click();
        await page.evaluate(()=>{
          const models=[
            {id:'long-current',provider:'custom',model:'provider/long-context-story-model-with-reasoning-and-extended-context',
              selected:true,available:true,authMode:'key',connectionLabel:'https://relay.example.invalid/v1',
              baseUrl:'https://relay.example.invalid/api/proxy/extended-context/compatible/v1'},
            {id:'other-one',provider:'custom',model:'deepseek-chat',selected:false,available:true,authMode:'key',connectionLabel:'日常连接'},
            {id:'other-two',provider:'custom',model:'deepseek-chat',selected:false,available:true,authMode:'key',connectionLabel:'备用连接'},
          ];
          window.NoraLauncherBridge.modelProviders=async()=>({ok:true,providers:[{id:'custom',label:'自定义模型',custom:true}],
            current:{configured:true,selectedId:'long-current',models}});
        });
        await page.locator('#management > [data-action="model"]').click();await page.locator('#modelList .model-row').first().waitFor();
        await capture('long-name-multiple');
        await page.locator('.model-details summary').first().click();
        const overflow=await page.locator('.model-row').evaluateAll(rows=>rows.map(row=>{
          const name=row.querySelector('.model-name').getBoundingClientRect(),controls=row.querySelector('.model-row-controls').getBoundingClientRect();
          return {horizontal:row.scrollWidth-row.clientWidth,nameRight:name.right,controlsLeft:controls.left,
            detailOverflow:[...row.querySelectorAll('.model-details p')].filter(p=>p.getClientRects().length).map(p=>p.scrollWidth-p.clientWidth)};
        }));
        assert.ok(overflow.every(row=>row.horizontal<=1&&row.nameRight<=row.controlsLeft+1&&row.detailOverflow.every(value=>value<=1)),
          'long identifiers and expanded addresses must wrap without covering controls or overflowing their row');
        await capture('long-name-expanded');
        assert.deepEqual(errors,[]);
      }finally{await page.close();}
    }
  }finally{await browser.close();}
});
async function dailyInteractionPage(browser,viewport,options={}){
  const page=await browser.newPage({viewport});
  page.uiErrors=[];page.on('pageerror',error=>page.uiErrors.push(error.message));
  await page.addInitScript(options=>{
    window.state={installed:true,hermesInstalled:true,noraInstalled:true,systemReady:true,setupCompleted:true,
      modelConfigured:true,clawchatPaired:true,clawchatProfileReady:true,clawchatConnected:true,gatewayRunning:true,running:true,
      noraHome:'/isolated/NoraTavern',version:'2.4.2',port:8799,url:'http://127.0.0.1:8799',installer:{setupCompleted:true}};
    Object.assign(window.state,options.initialState||{});
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
      ...(options.resumeReady?{resumeOperation:async request=>{window.resumeRequest=request;return {restarting:true};}}:{}),
      openInstallDirectory:async()=>{window.calls.push({name:'directory'});},
      openExternal:async()=>{window.calls.push({name:'external'});},
      openClawChatApp:async()=>({ok:true}),openClawChat:async()=>{},uninstall:async()=>{window.calls.push({name:'uninstall'});return new Promise(resolve=>{window.finishUninstall=resolve;});}};
  },options);
  await page.goto(url);await page.locator(options.initialState?.retainedUninstallPending||options.initialState?.updateSequence?'#copy':'.services').waitFor();
  await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));});
  return page;
}

test('production configuration fields, pairing and settings share aligned geometry across viewports', {timeout:90000}, async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.NORA_CHROMIUM||undefined}),report=[];
  const sourceHash=file=>require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(file)).digest('hex');
  report.push({kind:'executed-source-inputs',htmlSha256:sourceHash(new URL(url)),
    controllerSha256:sourceHash(new URL('launcher-controller.js',url)),testSha256:sourceHash(__filename)});
  const viewports=[{width:1120,height:680},{width:1120,height:741},{width:1120,height:900},
    {width:980,height:680},{width:761,height:740},{width:760,height:600}];
  const ready={installed:true,hermesInstalled:true,noraInstalled:true,systemReady:true,setupCompleted:true,
    modelConfigured:true,clawchatPaired:true,clawchatProfileReady:true,clawchatConnected:true,
    gatewayRunning:true,running:true,installer:{setupCompleted:true},noraHome:'/isolated/NoraTavern',version:'2.4.2'};
  const close=(left,right,message)=>assert.ok(Math.abs(left-right)<=0.5,`${message}: ${left} != ${right}`);
  const settle=page=>page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  const open=async(viewport,state)=>{
    const page=await browser.newPage({viewport,reducedMotion:'reduce'});
    page.setDefaultTimeout(4000);page.uiErrors=[];page.on('pageerror',error=>page.uiErrors.push(error.message));
    try {
      await page.addInitScript(state=>{
        window.alignmentCalls={providers:0,versions:0};
        window.NoraLauncherBridge={status:async()=>({...state}),telemetry:async()=>({available:true,enabled:true}),
          checkUpdate:async()=>{window.alignmentCalls.versions++;return {state:'current',available:false,
            current:state.version,latest:state.version,launcherVersion:'2.4.8-layout-verification'};},
          modelProviders:async()=>{window.alignmentCalls.providers++;return {ok:true,providers:[
            {id:'deepseek',label:'DeepSeek',signupUrl:'https://platform.deepseek.com/'},
            {id:'custom',label:'自定义模型',custom:true}]};},
          modelOptions:async()=>{throw Object.assign(new Error('模型列表未能获取。'),{guidance:{title:'模型列表未能获取。',
            detail:'请核对接口地址与认证设置；未提供模型列表的服务仍可手动输入模型名称。'}});},
          operationLogs:async()=>({records:[],missing:[],hasMore:false}),openClawChat:async()=>({ok:true}),
          openClawChatApp:async()=>({ok:true}),openInstallDirectory:async()=>({ok:true})};
      },state);
      await page.goto(url);
      assert.equal(new URL(page.url()).searchParams.has('scenario'),false,'the standalone scenario must not bypass the production controller');
      return page;
    } catch(error) {await page.close();throw error;}
  };
  const navigate=async(page,action)=>{
    await page.locator('.services').waitFor();
    if(action==='model'){await openModelEditor(page);return;}
    await page.locator('#moreButton').click();
    await page.locator(`#more [data-action="${action}"]`).click();
  };
  const modelGeometry=page=>page.evaluate(()=>{
    const rect=e=>e.getBoundingClientRect().toJSON(),fields=document.querySelector('.fields');
    const visible=e=>e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
    const controls=Object.fromEntries(['provider','key','endpoint','model','authMode'].map(id=>{
      const control=document.getElementById(id),label=document.querySelector(`label[for="${id}"]`);
      return [id,visible(control)?{label:rect(label),control:rect(control)}:null];
    }));
    const inline=document.getElementById('inline'),submit=fields.closest('form').querySelector('[type="submit"]');
    const submitRect=rect(submit),clipOwners=[];
    for(let owner=submit.parentElement;owner;owner=owner.parentElement){
      const style=getComputedStyle(owner),bounds=rect(owner);
      if(/auto|scroll|hidden|clip/.test(style.overflowY)&&(submitRect.top<bounds.top-0.5||submitRect.bottom>bounds.bottom+0.5))
        clipOwners.push({id:owner.id||owner.className,rect:bounds,scrollHeight:owner.scrollHeight,clientHeight:owner.clientHeight,scrollTop:owner.scrollTop});
    }
    return {fields:rect(fields),controls,provider:document.getElementById('provider').value,
      auth:document.getElementById('authMode').value,getKeyVisible:visible(document.getElementById('getKey')),
      keyFieldHidden:document.getElementById('key').closest('.secret').parentElement.hidden,
      submit:submitRect,inline:{rect:rect(inline),scrollHeight:inline.scrollHeight,clientHeight:inline.clientHeight,scrollTop:inline.scrollTop},
      clipOwners,providers:window.alignmentCalls.providers};
  });
  const assertModel=(facts,viewport,branch,label)=>{
    assert.ok(facts.providers>0,`${label}: real bridge modelProviders must have been called`);
    assert.equal(facts.provider,branch==='deepseek'?'deepseek':'custom');
    assert.equal(facts.getKeyVisible,branch==='deepseek');
    assert.equal(facts.keyFieldHidden,branch==='custom-none');
    assert.equal(Boolean(facts.controls.key),branch!=='custom-none');
    assert.equal(Boolean(facts.controls.endpoint),branch!=='deepseek');
    assert.equal(Boolean(facts.controls.authMode),branch!=='deepseek');
    assert.equal(facts.auth,branch==='custom-none'?'none':'key');
    if(viewport.width>760){
      for(const [leftId,rightId] of [['provider','key'],['model','authMode']]){
        const left=facts.controls[leftId],right=facts.controls[rightId];if(!left||!right)continue;
        close(left.label.top,right.label.top,`${label}: ${leftId}/${rightId} label tops`);
        for(const property of ['top','width','height'])close(left.control[property],right.control[property],`${label}: ${leftId}/${rightId} ${property}`);
      }
    }else{
      for(const [id,fact] of Object.entries(facts.controls))if(fact){
        close(fact.control.left,facts.fields.left,`${label}: single-column ${id} left`);
        close(fact.control.width,facts.fields.width,`${label}: single-column ${id} width`);
      }
    }
    if(branch==='custom-none'){
      close(facts.controls.provider.control.left,facts.fields.left,`${label}: no-key provider left`);
      close(facts.controls.provider.control.width,facts.fields.width,`${label}: no-key provider full width`);
    }
    close(facts.submit.right,facts.fields.right,`${label}: submit/fields right edges`);
  };
  try {
    for(const viewport of viewports){
      for(const mode of ['default','edit'])for(const branch of ['deepseek','custom-key','custom-none']){
        const state=mode==='edit'?ready:{...ready,setupCompleted:false,modelConfigured:false,clawchatPaired:false,installer:{setupCompleted:false}};
        const page=await open(viewport,state),label=`model ${mode}/${branch} ${viewport.width}x${viewport.height}`;
        try {
          if(mode==='edit')await navigate(page,'model');
          await page.locator('#authMode').waitFor({state:'attached'});
          await page.locator('#provider').selectOption(branch==='deepseek'?'deepseek':'custom');
          if(branch!=='deepseek')await page.locator('#authMode').selectOption(branch==='custom-none'?'none':'key');
          await settle(page);const facts=await modelGeometry(page);report.push({label,viewport,facts});assertModel(facts,viewport,branch,label);
          await page.locator('#loadModels').click();await page.locator('#feedback.error').waitFor();
          await settle(page);const errorFacts=await modelGeometry(page);report.push({label:label+' feedback',viewport,facts:errorFacts});
          assertModel(errorFacts,viewport,branch,label+' feedback');
          const reachability=await workflowReachability(page);report.push({label:label+' reachability',viewport,reachability});
          assert.deepEqual({invalidRegions:reachability.invalidRegions,wheelMissing:reachability.wheelMissing,
            missing:reachability.missing,unreachable:reachability.unreachable,moved:reachability.moved,outerScroll:reachability.outerScroll},
            {invalidRegions:[],wheelMissing:[],missing:[],unreachable:[],moved:[],outerScroll:[]},`${label}: every visible control remains reachable`);
          assert.deepEqual(page.uiErrors,[]);
        } finally {await page.close();}
      }
      for(const mode of ['default','edit']){
        const state=mode==='edit'?ready:{...ready,setupCompleted:false,clawchatPaired:false,installer:{setupCompleted:false}};
        const page=await open(viewport,state),label=`pair ${mode} ${viewport.width}x${viewport.height}`;
        try {
          if(mode==='edit'){
            await navigate(page,'claw');assert.equal(await page.locator('.pair-form').isHidden(),true);
            await page.getByRole('button',{name:'重新配对',exact:true}).click();
          }
          await page.locator('#pairCode').waitFor();await settle(page);
          const geometry=()=>page.evaluate(()=>{
            const input=document.getElementById('pairCode'),form=input.form,header=form.querySelector('.field-line');
            const rect=e=>e.getBoundingClientRect().toJSON();
            const textRect=e=>{const range=document.createRange();range.selectNodeContents([...e.childNodes].find(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.trim()));return range.getBoundingClientRect().toJSON();};
            return {label:textRect(header.querySelector('label')),help:textRect(header.querySelector('a')),
              header:rect(header),input:rect(input),submit:rect(form.querySelector('[type="submit"]'))};
          });
          for(const validation of [false,true]){
            if(validation){await page.locator('.pair-form [type="submit"]').click();await page.locator('#pairFeedback').filter({hasText:'请填写配对码'}).waitFor();await settle(page);}
            const facts=await geometry();report.push({label,validation,viewport,facts});
            close(facts.label.top,facts.help.top,`${label}: title/help text tops`);
            close(facts.input.left,facts.header.left,`${label}: input/header left`);
            close(facts.input.right,facts.header.right,`${label}: input/header right`);
            close(facts.submit.right,facts.input.right,`${label}: submit/input right`);
          }
          assert.deepEqual(page.uiErrors,[]);
        } finally {await page.close();}
      }
      const state={...ready,noraHome:'C:\\Users\\中文用户\\AppData\\Local\\'+'chosen-installation-directory\\'.repeat(8)+'NoraTavern',version:'2.4.2-'+ 'long-version.'.repeat(8)};
      const page=await open(viewport,state),label=`settings ${viewport.width}x${viewport.height}`;
      try {
        await navigate(page,'settings');await page.locator('.settings-row').last().waitFor();await settle(page);
        const facts=await page.locator('.settings-row').evaluateAll(rows=>rows.map(row=>{
          const rect=e=>e.getBoundingClientRect().toJSON();return {row:rect(row),title:rect(row.firstElementChild),
            value:rect(row.lastElementChild),text:row.lastElementChild.textContent,scrollWidth:row.scrollWidth,clientWidth:row.clientWidth};
        }));
        report.push({label,viewport,facts});assert.equal(facts.length,3);assert.equal(facts[0].text,state.noraHome);assert.equal(facts[1].text,state.version);
        for(const fact of facts){
          close(fact.value.left,facts[0].value.left,`${label}: fixed value-column start`);
          assert.ok(fact.value.left>=fact.row.left-0.5&&fact.value.right<=fact.row.right+0.5,`${label}: value stays within row ${JSON.stringify(fact)}`);
          assert.ok(fact.scrollWidth<=fact.clientWidth+1,`${label}: long values must not create horizontal overflow`);
          assert.ok(fact.row.left>=-0.5&&fact.row.right<=viewport.width+0.5,`${label}: row stays within viewport`);
        }
        assert.deepEqual(page.uiErrors,[]);
      } finally {await page.close();}
    }
  } finally {
    try {if(process.env.NORA_ALIGNMENT_REPORT)require('node:fs').writeFileSync(process.env.NORA_ALIGNMENT_REPORT,JSON.stringify(report,null,2)+'\n');}
    finally {await browser.close();}
  }
});

test('an interrupted KEEP offers its existing uninstall entry and logs while blocking installation',{timeout:15000},async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.NORA_CHROMIUM});
  try{
    const page=await dailyInteractionPage(browser,{width:1120,height:680},{initialState:{installed:false,hermesInstalled:false,noraInstalled:false,
      systemReady:false,setupCompleted:false,running:false,gatewayRunning:false,clawchatConnected:false,
      retainedInstallation:true,retainedUninstallPending:true,warning:'保留数据卸载尚未完成，请在更多中继续卸载。'}});
    await page.getByText('保留数据卸载尚未完成。',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'安装酒馆',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'继续安装',exact:true}).count(),0);
    assert.equal(await page.locator('#moreButton').isEnabled(),true);
    await page.locator('#moreButton').click();assert.equal(await page.locator('[data-action="uninstall"]').isVisible(),true);
    await page.locator('[data-action="uninstall"]').click();await page.waitForFunction(()=>window.calls.some(item=>item.name==='uninstall'));
    assert.deepEqual(await page.evaluate(()=>window.calls),[{name:'uninstall'}]);assert.deepEqual(page.uiErrors,[]);
  }finally{await browser.close();}
});
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

for(const both of [false,true])test(`the existing update button submits the fixed batch for ${both?'both components':'APP only'}`,async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.NORA_CHROMIUM||undefined});
  try{
    const page=await dailyInteractionPage(browser,{width:1120,height:680},{versionResult:{state:'available',available:true,updateSupported:true,
      current:both?'2.4.2':'2.5.2',latest:'v2.5.2',releaseTag:'v2.5.3',launcherVersion:'2.2.2',launcherLatest:'2.2.3',
      launcherUpdateAvailable:true,releaseAvailable:both}});
    await page.evaluate(()=>{window.NoraLauncherBridge.update=async options=>{window.updateRequest=options;return {restarting:true};};});
    await page.locator('#moreButton').click();await page.locator('[data-action="update"]').click();
    await page.getByRole('button',{name:'安装更新',exact:true}).click();
    const request=await page.evaluate(()=>({...window.updateRequest,onEvent:undefined}));
    assert.equal(request.tag,'v2.5.3');assert.equal(request.includeLauncher,both?true:undefined);assert.equal(request.launcherOnly,both?undefined:true);
    assert.deepEqual(page.uiErrors,[]);
  }finally{await browser.close();}
});
test('reopened compatible partial update explains both versions and retries the original operation',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.NORA_CHROMIUM||undefined});
  try{
    const operationId='11111111-1111-4111-8111-111111111111';
    const page=await dailyInteractionPage(browser,{width:1120,height:680},{initialState:{
      operation:{operationId,kind:'update',state:'failed',effectState:'untouched',verification:'unconfirmed',
        recoveryOutcome:'not-required',snapshotSequence:7,allowedActions:['retry','recheck'],busy:false,
        primaryFailure:{message:'APP download unavailable',code:'RESOURCE_DOWNLOAD_FAILED'}},
      updateSequence:{status:'partial',failed:'launcher',
      message:'酒馆已更新；启动器更新失败，原启动器已恢复。',coreVersion:'2.5.2',launcherVersion:'2.2.2',releaseTag:'v2.5.3',operationId,snapshotSequence:7}}});
    assert.match(await page.locator('#copy').innerText(),/更新部分完成/);
    assert.match(await page.locator('#subcopy').innerText(),/2\.5\.2.*2\.2\.2/s);
    await page.evaluate(()=>{
      window.NoraLauncherBridge.recheckOperation=async options=>{
        window.recheckRequest=options;window.state.operation={...window.state.operation,snapshotSequence:8};return {operation:window.state.operation};
      };
      window.NoraLauncherBridge.resumeOperation=async options=>{window.resumeRequest=options;return {restarting:true};};
    });
    await page.getByRole('button',{name:'重新检查',exact:true}).click();
    assert.match(await page.locator('#copy').innerText(),/更新部分完成/);
    await page.getByRole('button',{name:'重新尝试更新',exact:true}).click();
    const request=await page.evaluate(()=>({...window.resumeRequest,onEvent:undefined}));
    assert.equal(request.operationId,operationId);assert.equal(request.snapshotSequence,8);assert.deepEqual(page.uiErrors,[]);
  }finally{await browser.close();}
});
test('a failed second phase immediately shows the canonical partial result',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.NORA_CHROMIUM||undefined});
  try{
    const page=await dailyInteractionPage(browser,{width:1120,height:680},{versionResult:{state:'available',available:true,updateSupported:true,
      current:'2.4.3',latest:'v2.5.2',releaseTag:'v2.5.3',launcherVersion:'2.2.1',launcherLatest:'2.2.2',
      launcherUpdateAvailable:true,releaseAvailable:true}});
    await page.evaluate(()=>{window.NoraLauncherBridge.resumeOperation=async()=>({restarting:true});window.NoraLauncherBridge.update=async()=>{
      const operation={operationId:'11111111-1111-4111-8111-111111111111',kind:'update',state:'rolled-back',
        snapshotSequence:9,effectState:'restored',verification:'confirmed',recoveryOutcome:'restored-and-verified',
        busy:false,allowedActions:['retry','recheck','logs']};
      window.state.operation=operation;window.state.updateSequence={status:'partial',failed:'core',coreVersion:'2.4.3',launcherVersion:'2.2.2',
        operation,operationId:operation.operationId,snapshotSequence:9,message:'启动器已更新；酒馆更新未完成，当前程序组合已核验可用。'};
      const {allowedActions,...raw}=operation;throw {message:'更新部分完成',operation:raw};
    };});
    await page.locator('#moreButton').click();await page.locator('[data-action="update"]').click();
    await page.getByRole('button',{name:'安装更新',exact:true}).click();
    await page.getByText('更新部分完成。',{exact:true}).waitFor();
    assert.match(await page.locator('#subcopy').innerText(),/2\.4\.3.*2\.2\.2/s);
    assert.equal(await page.getByRole('button',{name:'重新尝试更新',exact:true}).isEnabled(),true);
    assert.deepEqual(page.uiErrors,[]);
  }finally{await browser.close();}
});
test('partial update retry uses its own core task when the latest task is a later shutdown',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.NORA_CHROMIUM||undefined});
  try{
    const operationId='11111111-1111-4111-8111-111111111111';
    const core={operationId,kind:'update',state:'rolled-back',snapshotSequence:13,effectState:'restored',
      verification:'confirmed',recoveryOutcome:'restored-and-verified',busy:false,allowedActions:['retry','recheck','logs']};
    const page=await dailyInteractionPage(browser,{width:1120,height:680},{resumeReady:true,initialState:{
      operation:{operationId:'22222222-2222-4222-8222-222222222222',kind:'shutdown',state:'succeeded',
        snapshotSequence:4,busy:false,allowedActions:['logs']},
      updateSequence:{status:'partial',failed:'core',operation:core,operationId,snapshotSequence:13,
        coreVersion:'2.4.3',launcherVersion:'2.2.2',message:'旧酒馆已恢复，启动器更新保留。'}}});
    await page.getByRole('button',{name:'重新尝试更新',exact:true}).click();
    await page.waitForFunction(()=>Boolean(window.resumeRequest),{},{timeout:3000});
    const request=await page.evaluate(()=>({...window.resumeRequest,onEvent:undefined}));
    assert.equal(request.operationId,operationId);assert.equal(request.snapshotSequence,13);
    assert.deepEqual(page.uiErrors,[]);
  }finally{await browser.close();}
});
function sameAnchors(actual,expected,label){
  for(const selector of Object.keys(expected))for(const axis of ['x','y'])
    assert.ok(Math.abs(actual[selector][axis]-expected[selector][axis])<=1,
      `${label}: ${selector} ${axis} moved ${actual[selector][axis]-expected[selector][axis]}px`);
}
async function workflowAnchors(page) {
  return page.evaluate(() => ({
    steps: document.getElementById('main').getBoundingClientRect().top,
    speaker: document.querySelector('.speaker').getBoundingClientRect().top,
    copy: document.getElementById('copy').getBoundingClientRect().top,
  }));
}
async function workflowReachability(page) {
  await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations()
    .filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
  const baseline=await workflowAnchors(page);
  const regions=await page.evaluate(()=>['inline','copy','subcopy'].filter(id=>{
    const e=document.getElementById(id);
    return e.getClientRects().length&&/auto|scroll/.test(getComputedStyle(e).overflowY)&&e.scrollHeight>e.clientHeight+1;
  }));
  const invalidRegions=await page.evaluate(()=>['inline','copy','subcopy'].filter(id=>{
    const e=document.getElementById(id);if(!e.getClientRects().length)return false;
    const r=e.getBoundingClientRect();if(r.top<0||r.bottom>innerHeight+1||r.height<1)return true;
    for(let owner=e.parentElement;owner;owner=owner.parentElement){
      const style=getComputedStyle(owner),b=owner.getBoundingClientRect();
      if(/hidden|clip/.test(style.overflowY)&&(r.top<b.top-1||r.bottom>b.bottom+1))return true;
    }return false;
  }));
  const scrolling=[];
  for(const id of regions) {
    const region=page.locator(`#${id}`);
    const before=await region.evaluate(e=>({top:e.scrollTop,range:e.scrollHeight-e.clientHeight}));
    await region.hover();await page.mouse.wheel(0,10000);
    await page.waitForFunction(id=>{const e=document.getElementById(id);return e.scrollTop>=e.scrollHeight-e.clientHeight-1;},id,{timeout:2000});
    const after=await region.evaluate(e=>({top:e.scrollTop,range:e.scrollHeight-e.clientHeight}));
    scrolling.push({id,before,after});
  }
  const wheelTargets=await page.evaluate(()=>{
    window.layoutWheelTargets=[...document.querySelectorAll('#inline button,#inline input,#inline select,#inline a[href],#inline summary')]
      .filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
    return window.layoutWheelTargets.map(e=>e.id||e.getAttribute('aria-label')||e.textContent.trim());
  });
  const wheelVisited=new Set();
  if(wheelTargets.length) {
    const region=page.locator('#inline');await region.hover();await page.mouse.wheel(0,-10000);
    await page.waitForFunction(()=>document.getElementById('inline').scrollTop<=1,{},{timeout:2000});
    for(let step=0;step<50;step++) {
      const sweep=await page.evaluate(()=>{
        const region=document.getElementById('inline'),b=region.getBoundingClientRect();
        const visited=window.layoutWheelTargets.flatMap((e,index)=>{
          const r=e.getBoundingClientRect();if(r.top<b.top-1||r.bottom>b.bottom+1||r.top<0||r.bottom>innerHeight+1)return [];
          const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
          return hit&&(hit===e||e.contains(hit))?[index]:[];
        });
        return {visited,top:region.scrollTop,range:region.scrollHeight-region.clientHeight,height:region.clientHeight};
      });
      sweep.visited.forEach(i=>wheelVisited.add(i));
      if(sweep.top>=sweep.range-1)break;
      await page.mouse.wheel(0,Math.max(20,sweep.height/2));
      await page.waitForFunction(top=>document.getElementById('inline').scrollTop>top, sweep.top,{timeout:2000});
    }
  }
  const expected=await page.evaluate(()=>{
    window.layoutTargets=[...document.querySelectorAll('main button,main input,main select,main a[href],main summary,main [tabindex]')]
      .filter(e=>!e.disabled&&e.tabIndex>=0&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
    document.activeElement?.blur();
    return window.layoutTargets.map(e=>e.id||e.getAttribute('aria-label')||e.textContent.trim());
  });
  const visited=new Set(), unreachable=[];
  // Walk the actual keyboard order; do not programmatically focus each control.
  for(let step=0;step<expected.length*2+16&&visited.size<expected.length;step++) {
    await page.keyboard.press('Tab');
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const fact=await page.evaluate(()=>{
      const e=document.activeElement,index=window.layoutTargets.indexOf(e);if(index<0)return {index};
      const r=e.getBoundingClientRect();let within=r.top>=0&&r.bottom<=innerHeight+1&&r.left>=0&&r.right<=innerWidth+1;
      const clippedBy=[];
      for(let owner=e.parentElement;owner;owner=owner.parentElement) {
        const style=getComputedStyle(owner),b=owner.getBoundingClientRect();
        if(/auto|scroll|hidden|clip/.test(style.overflowY)&&(r.top<b.top-1||r.bottom>b.bottom+1)){
          within=false;clippedBy.push({id:owner.id||owner.className,top:b.top,bottom:b.bottom,scrollTop:owner.scrollTop});
        }
      }
      const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
      return {index,within,uncovered:Boolean(hit&&(hit===e||e.contains(hit))),top:r.top,bottom:r.bottom,clippedBy};
    });
    if(fact.index>=0) {
      visited.add(fact.index);
      if(!fact.within||!fact.uncovered)unreachable.push({name:expected[fact.index],...fact});
    }
  }
  const after=await workflowAnchors(page);
  const moved=Object.keys(baseline).filter(key=>Math.abs(baseline[key]-after[key])>1);
  const outerScroll=await page.evaluate(()=>['main','scroll'].map(id=>({id,top:document.getElementById(id).scrollTop}))
    .concat({id:'body',top:document.scrollingElement.scrollTop}).filter(e=>e.top!==0));
  return {scrolling,invalidRegions,wheelMissing:wheelTargets.filter((_,i)=>!wheelVisited.has(i)),
    visited:[...visited].map(i=>expected[i]),missing:expected.filter((_,i)=>!visited.has(i)),unreachable,moved,outerScroll};
}
test('workflow routes preserve the installation anchors at the short-height boundary', {timeout:30000}, async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.NORA_CHROMIUM||undefined});
  const ready={installed:true,hermesInstalled:true,noraInstalled:true,systemReady:true,modelConfigured:true,
    clawchatPaired:true,clawchatProfileReady:true,running:true,gatewayRunning:true,clawchatConnected:true,
    installer:{setupCompleted:false},version:'2.4.2'};
  const failed={schema:'nora-operation/1',operationId:'22222222-2222-4222-8222-222222222222',kind:'install',
    state:'failed',effectState:'untouched',allowedActions:['recheck','logs'],primaryFailure:{code:'TEST_FAILURE',
      guidance:{title:'安装尚未完成。',detail:'请查看日志后继续。'}}};
  const states=[
    ['installation',{...ready,busy:true,installer:{setupCompleted:false,phase:'install'}},'#copy'],
    ['model',{...ready,modelConfigured:false},'#provider'],
    ['pair',{...ready,clawchatPaired:false},'#pairCode'],
    ['model-pending',{...ready,modelSyncPending:true},'#inline .button'],
    ['error',{...ready,operation:failed},'.outcome-actions'],
    ['repair',{...ready,systemReady:false,systemProblems:['运行环境需要修复。']},'#inline .button'],
    ['recovery',{...ready,operation:{...failed,state:'interrupted',allowedActions:['recover','recheck','logs']},
      updateRecovery:{canRecover:true,restoreVersion:'2.4.1',backup:'/isolated/backup'}},'#recoverUpdate'],
    ['launcher-recovery',{...ready,launcherRecovery:{canRecover:true,backup:'/isolated/launcher-backup'}},'#recoverLauncher'],
  ];
  const report=[], moved=[];
  try {
    for(const viewport of [{width:1120,height:741},{width:1120,height:740},{width:1120,height:680},{width:740,height:600}]) {
      let baseline;
      for(const [name,state,selector] of states) {
        const page=await browser.newPage({viewport});
        try {
          await page.addInitScript(state=>{window.NoraLauncherBridge={status:async()=>state,
            telemetry:async()=>({available:true,enabled:true}),
            modelProviders:async()=>({ok:true,providers:[{id:'custom',label:'自定义模型',custom:true}]}),
            operationLogs:async()=>({records:[],missing:[],hasMore:false}),recoverOperation:async()=>state,recoverLauncher:async()=>state};},state);
          await page.goto(url);await page.locator(selector).first().waitFor();
          await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations()
            .filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
          const anchors=await workflowAnchors(page),steps=await page.locator('#steps').evaluate(e=>({hidden:e.hidden,top:e.getBoundingClientRect().top,height:e.getBoundingClientRect().height}));
          let initialForm;
          if(name==='model'&&viewport.width===1120&&viewport.height===680) {
            initialForm=await page.evaluate(()=>{
              const inline=document.getElementById('inline'),box=inline.getBoundingClientRect();
              return {scrollTop:inline.scrollTop,inline:{top:box.top,bottom:box.bottom,height:box.height},
                controls:[...inline.querySelectorAll('button,input,select')].filter(e=>e.getClientRects().length).map(e=>{
                  const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
                  return {name:e.id||e.getAttribute('aria-label')||e.textContent.trim(),top:r.top,bottom:r.bottom,
                    fullyVisible:r.top>=box.top-1&&r.bottom<=box.bottom+1&&r.top>=0&&r.bottom<=innerHeight,
                    uncovered:Boolean(hit&&(hit===e||e.contains(hit)))};
                })};
            });
            assert.equal(initialForm.scrollTop,0,'ordinary initial form must be checked before focus or scrolling');
            assert.ok(initialForm.controls.some(e=>e.name==='验证并继续'));
            assert.deepEqual(initialForm.controls.filter(e=>!e.fullyVisible||!e.uncovered),[],
              'ordinary initial fields and submit must be completely visible without scrolling');
          }
          report.push({viewport,name,anchors,steps,initialForm});
          if(!steps.hidden){assert.equal(steps.height,44);assert.equal(steps.top,anchors.steps);}
          baseline ||= anchors;
          for(const key of Object.keys(baseline))if(Math.abs(anchors[key]-baseline[key])>1)
            moved.push(`${name} ${key} moved ${anchors[key]-baseline[key]}px at ${viewport.width}x${viewport.height}`);
        } finally {await page.close();}
      }
    }
    assert.deepEqual(moved,[]);
  } finally {
    if(process.env.NORA_ANCHOR_REPORT)require('node:fs').writeFileSync(process.env.NORA_ANCHOR_REPORT,JSON.stringify(report,null,2)+'\n');
    await browser.close();
  }
});
test('connection failure and a failure after the daily page use the same workflow anchor',{timeout:15000},async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.NORA_CHROMIUM||undefined});
  try {
    const page=await dailyInteractionPage(browser,{width:1120,height:680});
    try {
      await openModelEditor(page);await page.locator('#provider').waitFor();
      await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
      const baseline=await workflowAnchors(page);
      await closeModelEditor(page);await page.locator('.services').waitFor();
      await page.evaluate(()=>{window.NoraLauncherBridge.checkUpdate=async()=>{throw Object.assign(new Error('更新查询失败。'),{guidance:{title:'更新查询失败。',detail:'保留现有安装，重新查询。'}});};});
      await page.locator('#moreButton').click();await page.locator('#more [data-action="update"]').click();
      await page.getByText('更新查询失败。',{exact:true}).waitFor();
      const reachability=await workflowReachability(page);
      assert.deepEqual(await workflowAnchors(page),baseline,'failure must override the inherited daily/editing centering');
      assert.deepEqual(reachability.missing,[]);assert.deepEqual(reachability.unreachable,[]);assert.deepEqual(reachability.outerScroll,[]);
      const disconnected=await browser.newPage({viewport:{width:1120,height:680}});
      try {
        await disconnected.goto(`${url}?desktop`);await disconnected.getByText('启动器连接失败。',{exact:true}).waitFor();
        await disconnected.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
        assert.equal(await disconnected.locator('main').getAttribute('data-layout'),'workflow');
        assert.deepEqual(await workflowAnchors(disconnected),baseline,'early connection failure shares the hidden-step geometry');
        assert.equal(await disconnected.locator('#steps').isVisible(),false);
      }finally{await disconnected.close();}
    }finally{await page.close();}
  }finally{await browser.close();}
});
test('long workflow text, forms and recovery details retain anchors and keyboard-reachable actions', {timeout:30000},async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.NORA_CHROMIUM||undefined}),report=[];
  const ready={installed:true,hermesInstalled:true,noraInstalled:true,systemReady:true,modelConfigured:true,
    clawchatPaired:true,running:true,gatewayRunning:true,clawchatConnected:true,installer:{setupCompleted:false},version:'2.4.2'};
  const failure={schema:'nora-operation/1',operationId:'22222222-2222-4222-8222-222222222222',kind:'update',
    state:'failed',effectState:'untouched',allowedActions:['recheck','logs'],primaryFailure:{code:'TEST_LONG_DETAIL',guidance:{
      title:'当前安装需要检查，请保留现有数据。'.repeat(20),detail:'这里是完整的失败详情，用于确认窗口内可以阅读全部信息。\n'.repeat(90)}}};
  try {
    for(const viewport of [{width:1120,height:680},{width:740,height:600}])for(const name of ['model-feedback','long-error','long-recovery']) {
      const state=name==='model-feedback'?{...ready,modelConfigured:false}:name==='long-error'?{...ready,operation:failure}:
        {...ready,operation:{...failure,state:'interrupted',allowedActions:['recover','recheck','logs']},
          updateRecovery:{canRecover:true,restoreVersion:'2.4.1',backup:'/isolated/备份目录/'.repeat(30),log:'/isolated/日志目录/'.repeat(30)}};
      const page=await browser.newPage({viewport});
      try {
        await page.addInitScript(state=>{window.NoraLauncherBridge={status:async()=>state,telemetry:async()=>({available:true,enabled:true}),
          modelProviders:async()=>({ok:true,providers:[{id:'custom',label:'自定义模型',custom:true}]}),
          modelOptions:async()=>{throw Error('模型返回了需要检查的详细信息。'.repeat(30));},
          operationLogs:async()=>({records:[],missing:[],hasMore:false}),recoverOperation:async()=>state};},state);
        await page.goto(url);await page.locator(name==='model-feedback'?'#provider':'.outcome-actions').waitFor();
        if(name==='model-feedback') {
          await page.locator('#key').fill('test-only');await page.locator('#loadModels').click();await page.locator('#feedback.error').waitFor();
        }
        if(name==='long-recovery')await page.locator('.recovery-details summary').click();
        await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations()
          .filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
        const facts=await workflowReachability(page);report.push({name,viewport,...facts});
        assert.deepEqual({invalidRegions:facts.invalidRegions,wheelMissing:facts.wheelMissing,missing:facts.missing,unreachable:facts.unreachable,moved:facts.moved,outerScroll:facts.outerScroll},
          {invalidRegions:[],wheelMissing:[],missing:[],unreachable:[],moved:[],outerScroll:[]},`${name} ${JSON.stringify(viewport)}`);
        assert.ok(facts.scrolling.length>0,'long contents must exercise actual wheel scrolling');
      }finally{await page.close();}
    }
  }finally{
    if(process.env.NORA_REACHABILITY_REPORT)require('node:fs').writeFileSync(process.env.NORA_REACHABILITY_REPORT,JSON.stringify(report,null,2)+'\n');
    await browser.close();
  }
});
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
      let workflowBaseline;
      for(const action of ['settings','model','claw','community','update','logs']){
        if(action==='model') await page.locator('#management > [data-action="model"]').click();
        else {
          await page.locator('#moreButton').click();
          sameAnchors(await dailyAnchors(page),baseline,'More opened');
          await page.locator(`#more [data-action="${action}"]`).click();
        }
        const target=action==='logs'?'.operation-console':'#inline';
        await page.locator(target).waitFor();
        if(action==='model')await page.getByRole('button',{name:'+ 添加模型',exact:true}).waitFor();
        const actualOrigin=await page.locator('#main').boundingBox();
        assert.ok(Math.abs(actualOrigin.x-origin.x)<=1,`${action} moved the whole right column sideways`);
        const workflow=await page.locator('main').getAttribute('data-layout')==='workflow';
        if(workflow) {
          const anchors=await workflowAnchors(page);workflowBaseline ||= anchors;
          assert.deepEqual(anchors,workflowBaseline,`${action} preserves the shared installation anchor`);
        } else assert.ok(Math.abs(actualOrigin.y-origin.y)<=1,`${action} moved the auxiliary right column`);
        if(action!=='logs')assert.equal(await page.locator('#launchbar').isVisible(),false,'home actions are not carried into a feature page');
        if(action!=='logs'&&!workflow)assert.ok(Math.abs((await page.locator('#message').boundingBox()).x-message.x)<=1,`${action} moved the auxiliary content sideways`);
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
test('workflow feature pages share anchors while auxiliary pages retain their original centering',{timeout:30000},async()=>{
  const browser=await chromium.launch({executablePath:process.env.NORA_CHROMIUM||undefined});
  try{
    const page=await dailyInteractionPage(browser,{width:1120,height:680},{versionResult:{state:'blocked',available:false,
      current:'2.4.2',latest:'v2.4.2',launcherVersion:'2.0.2',checkedAt:'2026-10-08T05:51:27Z',latestConfirmed:true,
      releaseUrl:'https://github.com/LoveMaker-art/noras-tavern/releases/tag/v2.4.2',
      compatibilityError:'线上发布与当前启动器不兼容。\n当前安装和数据未修改。\n请等待兼容版本发布，勿反复重试。'}});
    try{
      const workflowBaselines=new Map();
      for(const action of ['update','settings','claw','community','model']){
        if(action==='model')await page.locator('#management > [data-action="model"]').click();
        else{await page.locator('#moreButton').click();await page.locator(`#more [data-action="${action}"]`).click();}
        await page.getByRole('button',{name:'返回酒馆',exact:true}).waitFor();
        if(action==='model')await page.getByRole('button',{name:'+ 添加模型',exact:true}).waitFor();
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
          if(['update','claw','model'].includes(action)) {
            assert.equal(await page.locator('main').getAttribute('data-layout'),'workflow');
            const key=JSON.stringify(viewport),anchors=await workflowAnchors(page);
            if(!workflowBaselines.has(key))workflowBaselines.set(key,anchors);
            assert.deepEqual(anchors,workflowBaselines.get(key),`${action} shares the installation anchor at ${key}`);
          } else assert.ok(Math.abs(placement.above-placement.below)<=2,
            `${action} retains original centering; top gap=${placement.above}px bottom gap=${placement.below}px`);
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
      await openModelEditor(page);
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
      await closeModelEditor(page);
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
    const pairingLayout = async () => {
      await page.evaluate(async()=>{await Promise.all(document.getAnimations()
        .filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
      const facts=await workflowReachability(page);
      return {inputReachable:facts.visited.includes('pairCode'),submitReachable:facts.visited.includes('配对并继续'),
        inputAboveSubmit:await page.evaluate(()=>{const input=document.getElementById('pairCode');return input.getBoundingClientRect().bottom<=input.form.querySelector('[type="submit"]').getBoundingClientRect().top;}),
        invalidRegions:facts.invalidRegions,wheelMissing:facts.wheelMissing,missing:facts.missing,unreachable:facts.unreachable,moved:facts.moved,outerScroll:facts.outerScroll};
    };
    for (const viewport of [{ width: 1120, height: 680 }, { width: 900, height: 640 }]) {
      await page.setViewportSize(viewport);
      assert.deepEqual(await pairingLayout(), { inputReachable: true, submitReachable: true,
        inputAboveSubmit: true,invalidRegions:[],wheelMissing:[],missing:[],unreachable:[],moved:[],outerScroll:[] }, `pairing layout at ${viewport.width}x${viewport.height}`);
    }
    await page.getByRole('button', { name: '配对并继续', exact: true }).click();
    assert.match(await page.locator('#pairFeedback').textContent(), /请填写配对码/);
    assert.deepEqual(await pairingLayout(), { inputReachable: true, submitReachable: true,
      inputAboveSubmit: true,invalidRegions:[],wheelMissing:[],missing:[],unreachable:[],moved:[],outerScroll:[] }, 'pairing validation feedback stays reachable');
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

test('all launcher routes keep content and actions reachable within their designated scroll regions', {timeout:90000}, async()=>{
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
          await openModelEditor(page);await page.locator('#authMode').waitFor();
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
          const workflow=await page.locator('main').getAttribute('data-layout')==='workflow'&&name!=='logs'&&name!=='more';
          const reachability=workflow?await workflowReachability(page):null;
          const facts=await page.evaluate(async name=>{
            await document.fonts.ready;
            await Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
            const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
            const within=e=>{
              // A bounded, genuinely scrollable form is checked by actual wheel
              // and keyboard traversal, rather than requiring every field at once.
              if(document.querySelector('main').dataset.layout==='workflow'&&e.closest('#inline'))return true;
              const r=e.getBoundingClientRect();
              if(r.top<0||r.bottom>innerHeight+1||r.left<0||r.right>innerWidth+1)return false;
              for(let owner=e.parentElement;owner;owner=owner.parentElement){
                const style=getComputedStyle(owner),b=owner.getBoundingClientRect();
                if(/auto|scroll|hidden|clip/.test(style.overflowY)&&(r.top<b.top-1||r.bottom>b.bottom+1))return false;
                if(style.position==='fixed')break;
              }return true;
            };
            const scope=name==='more'?document.querySelector('#more'):name==='logs'?document.querySelector('.operation-console'):document.querySelector('main');
            const workflow=document.querySelector('main').dataset.layout==='workflow';
            const allowed=name==='more'?['more-actions']:name==='logs'?['console-output']:workflow?['inline','copy','subcopy']:[];
            const permitted=e=>allowed.includes(e.id)||allowed.some(c=>e.classList.contains(c));
            const scrollers=[...scope.querySelectorAll('*')].filter(e=>visible(e)&&/auto|scroll/.test(getComputedStyle(e).overflowY)&&e.scrollHeight>e.clientHeight+1);
            const clipping=[...scope.querySelectorAll('button,input,select,#copy,#subcopy,#telemetryNotice,.conversation-guidance,.model-feedback,.settings-row,.launch-hint')]
              .filter(e=>visible(e)&&!e.closest('.console-output')&&!within(e));
            const covered=[...scope.querySelectorAll('button,input,select')].filter(e=>{
              if(workflow&&e.closest('#inline'))return false; // Real wheel/Tab traversal above checks these controls, including disabled controls.
              if(!visible(e)||!within(e))return false;
              const r=e.getBoundingClientRect();
              return [r.top+2,r.top+r.height/2,r.bottom-2].some(y=>{
                const hit=document.elementFromPoint(r.left+r.width/2,y);
                return !hit||(hit!==e&&!e.contains(hit));
              });
            });
            return {unexpectedScrollers:scrollers.filter(e=>!permitted(e)).map(e=>e.id||e.className),
              clipped:clipping.map(e=>e.id||e.getAttribute('aria-label')||e.textContent.trim()),
              covered:covered.map(e=>e.id||e.getAttribute('aria-label')||e.textContent.trim()),
              logScrollable:name==='logs'?document.querySelector('#consoleOutput').scrollHeight>document.querySelector('#consoleOutput').clientHeight:null,
              geometry:scrollers.filter(e=>!permitted(e)).map(e=>({id:e.id,height:e.clientHeight,content:e.scrollHeight})),
              bounds:clipping.map(e=>({id:e.id,top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom}))};
          },name);
          if(process.env.NORA_SCREENSHOT&&(facts.unexpectedScrollers.length||facts.clipped.length||facts.covered.length))await page.screenshot({path:process.env.NORA_SCREENSHOT.replace('.png',`-${name}-${viewport.width}x${viewport.height}.png`),animations:'disabled'});
          results.push({name,viewport,...facts,reachability,errors:errors.slice()});
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
    const failed=results.filter(r=>r.error||r.errors.length||r.unexpectedScrollers.length||r.clipped.length||r.covered.length||r.logScrollable===false
      ||r.reachability&&['invalidRegions','wheelMissing','missing','unreachable','moved','outerScroll'].some(key=>r.reachability[key].length));
    assert.deepEqual(failed,[],JSON.stringify(failed,null,2));
    assert.equal(results.length,scenarios.length*3);
  }finally{await browser.close();}
});
