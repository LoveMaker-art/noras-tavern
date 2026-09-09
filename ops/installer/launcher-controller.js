/* Real desktop controller. The standalone HTML retains an in-memory preview. */
(() => {
  const api = window.NoraLauncherBridge;
  if (!api && new URLSearchParams(location.search).has('desktop')) {
    clearInline(); $('steps').hidden = true; $('management').hidden = true; $('launchbar').hidden = true;
    say('启动器连接失败。', '请关闭后重新打开桌面启动器。');
    return;
  }
  if (!api || scenario) return;

  let snapshot = {}, view = 'loading', refreshing = false, activeAction = '', lastFailure = null;
  let alive = true, pollTimer, taskTimer, startedAt = 0, lastEvent = 0;
  let milestoneStates = [], currentTask = '', operationCancelled = false;
  let versionInfo = null, versionChecking = false, autoVersionChecked = false, activeService = 'all';
  let sawIncompleteSetup = false, firstCompletionPending = false;
  $('stop').remove(); $('runtimeState').remove();
  const launchHint = document.createElement('p'); launchHint.className = 'launch-hint'; $('launchbar').prepend(launchHint);
  const textError = error => String(error?.message || error || '操作未完成，请重试。')
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').slice(0, 360);

  function complete() { return Boolean(snapshot.setupCompleted ?? snapshot.installer?.setupCompleted) && snapshot.systemReady !== false; }
  function serviceRunning() { return Boolean(snapshot.running || snapshot.gatewayRunning); }
  function allRunning() { return Boolean(snapshot.running && snapshot.gatewayRunning && snapshot.clawchatConnected); }
  function syncState(value) {
    snapshot = { ...snapshot, ...value };
    running = Boolean(snapshot.running);
    daily = complete();
    if (!daily) sawIncompleteSetup = true;
    else if (sawIncompleteSetup) { firstCompletionPending = true; sawIncompleteSetup = false; }
  }
  async function readStatus() {
    const value = await api.status();
    if (value.warning && !value.installed && !value.hermesInstalled) throw new Error(value.warning);
    syncState(value);
    return value;
  }
  function hideMenu() { $('more').hidden = true; $('moreButton').setAttribute('aria-expanded', 'false'); }
  function controls() {
    $('management').hidden = busy || Boolean(snapshot.busy);
    document.querySelectorAll('#management [data-action]').forEach(control => {
      control.hidden = !complete() && control.dataset.action !== 'uninstall';
    });
    $('launchbar').hidden = !complete();
    $('status').hidden = complete();
    $('launch').disabled = busy || Boolean(snapshot.busy);
    let action = '打开酒馆';
    if (['start', 'restart'].includes(activeAction) && activeService !== 'nora') action = '正在启动';
    if (activeAction === 'open') action = '正在打开';
    launchHint.hidden = Boolean(snapshot.running);
    launchHint.textContent = action === '正在启动' ? '正在准备酒馆' : '点击后仅启动酒馆';
    $('launch').querySelector('span').textContent = action;
    $('stopAll').dataset.unavailable = String(!serviceRunning());
    document.querySelectorAll('[data-action], #moreButton, .services button, .conversation-entry button').forEach(item => {
      item.disabled = busy || Boolean(snapshot.busy) || item.dataset.unavailable === 'true';
    });
  }
  function displaySteps() {
    if (complete()) { $('steps').hidden = true; return; }
    $('steps').hidden = false; $('steps').classList.remove('depart');
    const facts = [snapshot.noraInstalled, snapshot.installed, snapshot.modelConfigured,
      snapshot.clawchatPaired && snapshot.clawchatProfileReady !== false, false];
    $('steps').replaceChildren();
    labels.forEach((label, index) => {
      const state = milestoneStates[index] || (facts[index] ? 'done' : 'pending');
      const item = document.createElement('div');
      item.className = `step ${state === 'done' ? 'done' : index === stage ? 'active' : ''} ${busy && index === stage ? 'busy' : ''}`;
      item.innerHTML = '<div class="step-line"></div><i class="fa-solid"></i>';
      item.querySelector('i').classList.add(state === 'done' ? 'fa-check' : state === 'error' ? 'fa-exclamation' : 'fa-minus');
      item.append(document.createTextNode(label)); $('steps').append(item);
    });
  }
  function setupStage(index) {
    stage = index; daily = complete();
    $('status').textContent = busy ? '正在处理' : '需要你参与';
    $('main').classList.toggle('daily', daily);
    $('main').classList.remove('welcome');
    $('main').classList.toggle('editing', daily);
    $('management').hidden = !daily;
    displaySteps(); controls();
  }
  function renderServices() {
    clearInline();
    const group = document.createElement('div'); group.className = 'services'; group.setAttribute('aria-label', '服务控制');
    for (const id of ['nora', 'tavern']) {
      const name = id === 'nora' ? '诺拉' : '酒馆', isOn = Boolean(id === 'nora' ? snapshot.gatewayRunning : snapshot.running);
      const transitioning = busy && ['start', 'stop', 'restart'].includes(activeAction) && [id, 'all'].includes(activeService);
      const state = transitioning ? activeAction === 'stop' ? 'stopping' : 'starting' : isOn ? 'running' : 'stopped';
      const row = document.createElement('div'); row.className = 'service-row'; row.dataset.service = id; row.dataset.state = state;
      row.innerHTML = `<i class="service-symbol fa-solid fa-${id === 'nora' ? 'wand-magic-sparkles' : 'mug-saucer'}" aria-hidden="true"></i><div class="service-name">${name}</div><span class="service-state" role="status"></span>`;
      row.querySelector('.service-state').textContent = { running: '运行中', stopped: '已停止', starting: '启动中', stopping: '停止中' }[state];
      for (const action of ['restart', isOn ? 'stop' : 'start']) {
        const label = ({ restart: '重启', stop: '停止', start: '启动' })[action] + name;
        const control = document.createElement('button'); control.className = 'icon-action'; control.dataset.tip = label; control.setAttribute('aria-label', label);
        control.dataset.unavailable = String(action === 'restart' && !isOn);
        control.innerHTML = `<i class="fa-solid fa-${({ restart: 'rotate-right', stop: 'stop', start: 'play' })[action]}" aria-hidden="true"></i>`;
        control.onclick = () => run(action, { service: id }); row.append(control);
      }
      group.append(row);
    }
    $('inline').append(group);
  }
  dailyHome = (message = '') => {
    view = 'daily'; daily = true; running = Boolean(snapshot.running);
    $('main').className = 'daily'; $('steps').hidden = true; $('management').hidden = false; hideMenu();
    $('launchbar').classList.remove('enter');
    const introduce = firstCompletionPending && allRunning() && !message && !snapshot.warning;
    $('main').classList.toggle('completion', introduce);
    say(message || (introduce ? '酒馆准备好了。' : allRunning() ? '欢迎回来，坐一会儿吧。'
      : snapshot.running ? '酒馆已启动。' : snapshot.gatewayRunning ? '诺拉已启动。' : '随时可以继续。'),
      snapshot.warning ? textError(snapshot.warning) : snapshot.gatewayRunning && !snapshot.clawchatConnected
        ? 'ClawChat 暂未连通，请在更多中检查连接。' : '');
    renderServices();
    renderConversationEntry();
    controls();
    showVersionNotice();
  };
  function renderConversationEntry() {
    if (!snapshot.clawchatPaired) return;
    const entry = document.createElement('div'); entry.className = 'conversation-entry';
    const action = document.createElement('button'); action.type = 'button'; action.className = 'conversation-link';
    action.innerHTML = '<i class="fa-solid fa-comment" aria-hidden="true"></i><span>去 ClawChat 找我</span><i class="fa-solid fa-arrow-up-right-from-square entry-arrow" aria-hidden="true"></i>';
    const introduce = firstCompletionPending && allRunning();
    const guidance = document.createElement('p'); guidance.id = 'conversationGuidance'; guidance.className = 'conversation-guidance'; guidance.hidden = !introduce; guidance.setAttribute('role', 'status');
    guidance.textContent = introduce ? '在 ClawChat 联系人中找到诺拉，发一句「你好」。' : '';
    action.setAttribute('aria-controls', guidance.id); action.setAttribute('aria-expanded', String(introduce));
    action.onclick = async () => {
      if (busy || snapshot.busy || action.disabled) return;
      firstCompletionPending = false;
      guidance.hidden = false; action.setAttribute('aria-expanded', 'true');
      if (!snapshot.gatewayRunning || !snapshot.clawchatConnected) {
        guidance.textContent = snapshot.gatewayRunning ? 'ClawChat 暂未连通，请先检查连接。' : '诺拉已暂停，请先在下方启动诺拉。';
        return;
      }
      action.disabled = true;
      guidance.textContent = '正在打开 ClawChat…';
      try {
        const result = await api.openClawChatApp();
        guidance.textContent = result.ok
          ? '在 ClawChat 联系人中找到诺拉，发一句「你好」。'
          : '未能打开 ClawChat。请手动打开客户端，在联系人中找到诺拉，发一句「你好」。';
        guidance.hidden = result.ok && !introduce;
        action.setAttribute('aria-expanded', String(!guidance.hidden));
      } catch {
        guidance.textContent = '未能打开 ClawChat。请手动打开客户端，在联系人中找到诺拉。';
      } finally { action.disabled = busy || Boolean(snapshot.busy); }
    };
    entry.append(action, guidance); $('inline').prepend(entry);
  }
  closeEdit = () => { if (!busy) { lastFailure = null; route(); } };

  function route() {
    lastFailure = null;
    if (snapshot.busy) {
      view = 'monitor'; clearInline(); setupStage(stage);
      say('后台任务仍在进行。', snapshot.installer?.task || '请稍候，完成后会自动继续。');
      return;
    }
    if (complete()) { dailyHome(); return; }
    if (!snapshot.hermesInstalled || !snapshot.installed || snapshot.systemReady === false) {
      view = 'welcome'; daily = false; $('main').classList.add('welcome'); $('main').classList.remove('daily', 'editing');
      $('steps').hidden = true; $('management').hidden = true; clearInline();
      const interrupted = snapshot.hermesInstalled || snapshot.installer?.startedAt;
      say(interrupted ? '接着把酒馆准备好。' : '我是诺拉。欢迎来到酒馆。',
        snapshot.systemProblems?.length ? snapshot.systemProblems.slice(0, 2).join('；') : interrupted ? '已完成的安装会保留。' : '先把我和酒馆安顿在这台电脑上。');
      $('inline').append(button(serviceRunning() ? '停止并继续' : interrupted ? '继续安装' : '开始安装', serviceRunning() ? () => run('stop') : install));
      const note = document.createElement('p'); note.className = 'note'; note.style.marginTop = '13px';
      note.textContent = `安装目录：${snapshot.noraHome || 'NoraTavern'}`; $('inline').append(note);
      controls(); return;
    }
    if (!snapshot.modelConfigured) { modelForm(); return; }
    if (!snapshot.clawchatPaired) { clawForm(); return; }
    setupStage(4); run('start');
  }
  function taskView(action) {
    view = 'task'; setupStage(stage); clearInline(); $('management').hidden = true;
    const messages = { install: '我来准备，你稍等片刻。', pair: '我来连接 ClawChat。', start: '正在准备 Nora 和酒馆。', stop: '正在停止服务。', update: '正在更新诺拉与酒馆。', repair: '正在修复安装。' };
    say(messages[action] || '我正在处理。');
    $('inline').innerHTML = '<div class="job"><div class="job-head"><span id="jobTitle"></span><span id="jobPercent"></span></div><div class="meter indeterminate"><span id="meterFill"></span></div><div class="job-note" id="jobNote"></div></div><div class="task-actions" id="taskActions"></div>';
    currentTask = '准备中'; startedAt = Date.now(); lastEvent = Date.now();
    const cancel = button('取消', async () => {
      cancel.disabled = true;
      try { const result = await api.cancel(); if (!result.ok) throw new Error(result.warning); operationCancelled = true; }
      catch (error) { currentTask = textError(error); updateTask(); cancel.disabled = false; }
    }, false);
    cancel.className = 'quiet'; $('taskActions').append(cancel);
    clearInterval(taskTimer); taskTimer = setInterval(updateTask, 1000); updateTask();
  }
  function updateTask() {
    if (!$('jobTitle')) return;
    $('jobTitle').textContent = currentTask;
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    $('jobNote').textContent = Date.now() - lastEvent > 20000
      ? `仍在等待后台响应 · 已用时 ${seconds} 秒` : `已用时 ${seconds} 秒`;
  }
  function onEvent(event) {
    if (event.event !== 'heartbeat') lastEvent = Date.now();
    if (event.event === 'milestone' && event.index >= 0 && event.index < 5) {
      milestoneStates[event.index] = event.state;
      if (event.state === 'running') stage = event.index;
      displaySteps();
    }
    if (event.event === 'task' || event.event === 'milestone') {
      currentTask = event.task || currentTask;
      const meter = document.querySelector('.meter');
      if (meter) { meter.classList.add('indeterminate'); $('jobPercent').textContent = ''; }
      updateTask();
    }
    if (event.event === 'progress' && $('meterFill')) {
      const ratio = typeof event.ratio === 'number' && Number.isFinite(event.ratio) ? event.ratio : null;
      document.querySelector('.meter').classList.toggle('indeterminate', ratio === null);
      $('jobPercent').textContent = ratio === null ? '' : `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
      if (ratio !== null) $('meterFill').style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
    }
  }
  function fail(error, action, retry) {
    view = 'error'; lastFailure = { action }; clearInline();
    say(operationCancelled ? '操作已取消。' : '这一步还没有完成。', textError(error));
    $('inline').append(button(operationCancelled ? '继续' : '重试', retry));
    if (complete()) $('inline').append(button('返回', () => { lastFailure = null; dailyHome(); }, false));
    controls();
  }
  async function run(action, options = {}) {
    if (busy) return;
    const wasComplete = complete();
    if (wasComplete) firstCompletionPending = false;
    busy = true; operationCancelled = false; activeAction = action; activeService = options.service || 'all'; lastFailure = null;
    if (wasComplete && ['start', 'stop', 'restart'].includes(action)) { dailyHome(); } else taskView(action);
    controls();
    try {
      const result = await api[action]({ port: snapshot.port || 8799, ...options, onEvent });
      syncState(result); await readStatus();
      const selectedRunning = activeService === 'nora' ? snapshot.gatewayRunning && snapshot.clawchatConnected : activeService === 'tavern' ? snapshot.running : allRunning();
      if (['start', 'restart'].includes(action) && !selectedRunning) throw new Error('所选服务尚未就绪，请重试。');
      if (action === 'start' && !wasComplete && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        $('steps').classList.add('depart');
        await wait(350);
      }
      busy = false; activeAction = ''; clearInterval(taskTimer);
      if (action === 'stop') {
        const stillRunning = activeService === 'nora' ? snapshot.gatewayRunning : activeService === 'tavern' ? snapshot.running : serviceRunning();
        if (stillRunning) throw new Error('所选服务尚未停止，请重试。');
        if (wasComplete) dailyHome(activeService === 'all' ? '服务已停止，故事还在。' : activeService === 'nora' ? '诺拉已暂停。' : '酒馆已停止。');
        else route();
      } else if (['start', 'restart'].includes(action)) {
        dailyHome();
        if (options.openAfter) await openTavern();
      } else if (action === 'update' || action === 'repair') {
        versionInfo = null; autoVersionChecked = false; route();
      } else route();
    } catch (error) {
      busy = false; activeAction = ''; clearInterval(taskTimer);
      try { await readStatus(); } catch {}
      // Single-use pairing codes are never replayed automatically.
      const retry = action === 'pair'
        ? snapshot.clawchatPaired ? () => run('start') : clawForm
        : () => run(action, options);
      fail(error, action, retry);
    } finally { controls(); }
  }
  install = () => { stage = snapshot.hermesInstalled ? 1 : 0; milestoneStates = []; run('install'); };
  async function openTavern() {
    if (busy) return;
    firstCompletionPending = false;
    if (!snapshot.running) { stage = 4; await run('start', { service: 'tavern', openAfter: true }); return; }
    busy = true; activeAction = 'open'; controls();
    try { await api.openExternal(snapshot.url); busy = false; activeAction = ''; dailyHome('酒馆页面已打开。'); }
    catch (error) { busy = false; activeAction = ''; fail(error, 'open', openTavern); }
    finally { controls(); }
  }
  $('launch').onclick = openTavern;

  modelForm = async () => {
    if (busy) return;
    view = 'model'; setupStage(2); clearInline();
    say(complete() ? '这次想用哪个模型？' : '连接一个模型，我们继续。');
    if (complete()) editHeader('模型设置');
    let providers;
    try {
      const result = await api.modelProviders();
      if (!result.ok) throw new Error(result.warning);
      if (view !== 'model') return;
      providers = result.providers;
    } catch (error) { fail(error, 'model', modelForm); return; }
    const form = document.createElement('form');
    form.innerHTML = '<div class="fields"><div><div class="field-line"><label for="provider">模型服务</label><a class="quiet" id="getKey" target="_blank" rel="noopener noreferrer">获取 Key</a></div><select id="provider"></select></div><div><label for="key">API Key</label><div class="secret"><input id="key" type="password" autocomplete="off" placeholder="粘贴 API Key"><button class="eye" type="button" title="显示或隐藏 Key"><i class="fa-solid fa-eye"></i></button></div></div><div class="wide" id="endpointField" hidden><label for="endpoint">接口地址</label><input id="endpoint" type="url" placeholder="https://example.com/v1"></div><div class="wide"><div class="field-line"><label for="model">模型名称</label><button type="button" class="quiet" id="loadModels">获取模型列表</button></div><input id="model" list="modelOptions" placeholder="选择或输入模型名称"><datalist id="modelOptions"></datalist></div></div><p class="model-feedback" id="feedback" role="status">Key 仅保存在本机</p><div class="form-bottom"><span></span><button class="button primary" type="submit">连接并继续</button></div>';
    $('inline').append(form);
    providers.forEach(provider => { const option = document.createElement('option'); option.value = provider.id; option.textContent = provider.label; $('provider').append(option); });
    $('provider').value = providers.some(p => p.id === snapshot.modelProvider) ? snapshot.modelProvider : providers[0].id;
    const selected = () => providers.find(p => p.id === $('provider').value);
    const syncProvider = () => {
      const provider = selected(); $('endpointField').hidden = !provider.custom; $('loadModels').hidden = provider.custom;
      $('getKey').hidden = !provider.signupUrl; if (provider.signupUrl) $('getKey').href = provider.signupUrl;
      $('key').value = ''; $('modelOptions').replaceChildren();
      $('model').value = (snapshot.modelProvider === provider.id ? snapshot.modelName : '')
        || (provider.id === 'deepseek' ? 'deepseek-v4-flash' : '');
      $('endpoint').value = snapshot.modelProvider === provider.id ? snapshot.modelBaseUrl || '' : '';
    };
    $('provider').onchange = syncProvider; syncProvider();
    form.querySelector('.eye').onclick = () => { $('key').type = $('key').type === 'password' ? 'text' : 'password'; };
    const feedback = (text, error = false) => { $('feedback').textContent = text; $('feedback').classList.toggle('error', error); };
    const lock = value => { busy = value; form.querySelectorAll('input,select,button').forEach(c => { c.disabled = value; }); controls(); };
    $('loadModels').onclick = async () => {
      if (!$('key').value.trim()) { feedback('请先填写 API Key。', true); return; }
      lock(true); feedback('正在获取模型列表。');
      try { const result = await api.modelOptions({ provider: $('provider').value, key: $('key').value.trim() });
        $('modelOptions').replaceChildren(); result.models.forEach(name => { const option = document.createElement('option'); option.value = name; $('modelOptions').append(option); });
        feedback('模型列表已更新，也可以直接输入模型名称。');
      } catch (error) { feedback(textError(error), true); } finally { lock(false); }
    };
    form.onsubmit = async event => {
      event.preventDefault(); if (busy) return;
      const payload = { provider: $('provider').value, key: $('key').value.trim(), model: $('model').value.trim(), baseUrl: selected().custom ? $('endpoint').value.trim() : '' };
      if (!payload.key || !payload.model || (selected().custom && !payload.baseUrl)) { feedback('请填写 Key、模型名称和所需的接口地址。', true); return; }
      lock(true); feedback('正在测试模型响应。');
      try { await api.saveAndTestModel(payload); $('key').value = ''; await readStatus(); lock(false);
        if (!snapshot.modelConfigured) throw new Error('模型配置未通过保存检查。');
        if (complete()) {
          dailyHome(snapshot.gatewayRunning ? '模型已保存，重启诺拉后生效。' : '模型已更换。');
          if (snapshot.gatewayRunning) $('inline').append(button('重启诺拉', () => run('restart', { service: 'nora' })));
        } else route();
      } catch (error) { lock(false); feedback(textError(error).replaceAll(payload.key, '***'), true); }
    };
  };
  clawForm = () => {
    if (busy) return;
    view = 'claw'; setupStage(3); clearInline();
    say(snapshot.clawchatPaired ? 'ClawChat 配对已保留。' : '把我接到 ClawChat 吧。');
    if (complete()) editHeader('ClawChat');
    const content = document.createElement('div'); content.className = 'pair';
    content.innerHTML = '<p>在 ClawChat 获取配对码，然后填在这里。</p><div class="task-actions" id="clawActions"></div>';
    $('inline').append(content);
    $('clawActions').append(button('下载 ClawChat', () => api.openClawChat().catch(error => fail(error, 'claw', clawForm)), false));
    if (snapshot.clawchatPaired) $('clawActions').append(button(snapshot.clawchatConnected ? '检查并启动' : '重新连接', () => { stage = 4; run('start', { service: complete() ? 'nora' : 'all' }); }));
    const form = document.createElement('form'); form.style.marginTop = '18px';
    form.innerHTML = '<div class="field-line"><label for="pairCode">配对码</label><a class="quiet" href="https://clawling.com/zh/chat/docs/connect-code/" target="_blank" rel="noopener noreferrer">如何获取配对码 <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a></div><input id="pairCode" type="password" autocomplete="off" placeholder="粘贴 ClawChat 配对码"><p class="model-feedback" id="pairFeedback"></p><div class="form-bottom"><span></span><button class="button primary" type="submit">连接并继续</button></div>';
    if (snapshot.clawchatPaired) {
      const replace = button('重新配对', () => { replace.hidden = true; form.hidden = false; }, false); replace.className = 'quiet'; $('inline').append(replace); form.hidden = true;
    }
    $('inline').append(form);
    form.onsubmit = event => { event.preventDefault(); const code = $('pairCode').value.trim();
      if (!code || /\s/.test(code)) { $('pairFeedback').textContent = '请填写配对码，不是整条激活命令。'; return; }
      $('pairCode').value = ''; run('pair', { code });
    };
  };
  async function checkUpdates() {
    if (busy) return; busy = true; view = 'update'; clearInline(); setupStage(stage); say('我来检查一下更新。'); controls();
    try {
      const result = await api.checkUpdate(); busy = false; versionInfo = result;
      const state = result.state || (result.available ? 'available' : 'current');
      const channelName = result.channel === 'beta' ? 'Beta 测试版' : '正式版';
      const title = { available: '发现新版本。', blocked: '最新发布暂不可用于完整安装。', current: `当前系统已是最新${channelName}。`, ahead: `本机版本高于最新${channelName}。`, unknown: '本机版本待确认。', unavailable: '暂时无法检查更新。' }[state];
      const versions = `本机 ${result.current || '版本待确认'}${result.latest ? ` · GitHub ${result.latest}` : ''}`;
      say(title, result.error || `${versions}${result.compatibilityError ? ` · ${result.compatibilityError}` : ''}${state === 'blocked' ? '。现有安装不受影响。' : ''}`);
      if (result.available && result.updateSupported) $('inline').append(button('安装更新', () => run('update', { tag: result.latest })));
      if (result.releaseUrl) $('inline').append(button('查看发布', () => api.openExternal(result.releaseUrl).catch(error => fail(error, 'update', checkUpdates)), false));
      if (state === 'unavailable') $('inline').append(button('重新检查', checkUpdates));
      $('inline').append(button('返回', () => dailyHome(), false));
    } catch (error) { busy = false; fail(error, 'update', checkUpdates); }
    controls();
  }
  function showVersionNotice() {
    if (view !== 'daily' || busy || !versionInfo || $('versionNotice')) return;
    if (!versionInfo.available && !['blocked', 'unknown', 'unavailable'].includes(versionInfo.state)) return;
    const notice = document.createElement('div'); notice.id = 'versionNotice'; notice.className = 'note';
    const summary = versionInfo.state === 'unavailable' ? '暂时无法检查更新' : versionInfo.state === 'blocked' ? '最新发布暂不可用于完整安装' : versionInfo.state === 'unknown' ? '本机版本待确认'
      : versionInfo.available ? `发现新版本 ${versionInfo.latest}` : `本机版本高于最新${versionInfo.channel === 'beta' ? 'Beta 测试版' : '正式版'}`;
    const details = button('查看版本', checkUpdates, false); details.className = 'quiet';
    notice.append(document.createTextNode(summary + ' '), details);
    $('inline').append(notice);
  }
  async function checkVersionsInBackground() {
    if (autoVersionChecked || versionChecking || busy || snapshot.busy) return;
    autoVersionChecked = true; versionChecking = true;
    try { versionInfo = await api.checkUpdate(); }
    catch (error) { versionInfo = { state: 'unavailable', error: textError(error) }; }
    finally { versionChecking = false; showVersionNotice(); }
  }
  document.querySelectorAll('[data-action]').forEach(control => { control.onclick = () => {
    if (busy) return; hideMenu();
    const action = control.dataset.action;
    if (action === 'model') modelForm();
    if (action === 'claw') clawForm();
    if (action === 'community') { view = 'community'; community(); }
    if (action === 'update') checkUpdates();
    if (action === 'stop-all') run('stop', { service: 'all' });
    if (action === 'uninstall') {
      api.uninstall({ onProgress: task => {
        busy = true; view = 'uninstall'; clearInline(); say(task); controls();
      } }).catch(error => { busy = false; fail(error, 'uninstall', route); });
    }
    if (action === 'settings') {
      view = 'settings'; clearInline(); $('main').classList.add('editing'); say('都收在这里。'); editHeader('安装信息');
      for (const [label, value] of [['安装目录', snapshot.noraHome], ['Nora 系统', snapshot.version || '版本待确认'], ['启动器', versionInfo?.launcherVersion || '版本待确认']]) {
        const row = document.createElement('div'); row.className = 'settings-row'; const title = document.createElement('span'); title.textContent = label;
        const detail = document.createElement('span'); detail.textContent = value; detail.style.overflowWrap = 'anywhere'; row.append(title, detail); $('inline').append(row);
      }
      $('inline').append(button('打开安装目录', () => api.openInstallDirectory().catch(error => fail(error, 'settings', route)), false));
    }
  }; });
  async function poll() {
    if (!alive) return;
    if (!busy && !refreshing) {
      refreshing = true;
      try {
        const before = JSON.stringify([snapshot.running, snapshot.gatewayRunning, snapshot.clawchatConnected, snapshot.warning]);
        await readStatus();
        if (view === 'loading' || (view === 'monitor' && !snapshot.busy)) route();
        else if (view === 'daily' && before !== JSON.stringify([snapshot.running, snapshot.gatewayRunning, snapshot.clawchatConnected, snapshot.warning])) dailyHome();
        controls();
        void checkVersionsInBackground();
      } catch (error) { if (view === 'loading') fail(error, 'status', () => { view = 'loading'; poll(); }); }
      finally { refreshing = false; }
    }
    clearTimeout(pollTimer); pollTimer = setTimeout(poll, 5000);
  }
  addEventListener('beforeunload', () => { alive = false; clearTimeout(pollTimer); clearInterval(taskTimer); });
  clearInline(); $('steps').hidden = true; $('launchbar').hidden = true; say('正在检查本机安装。');
  poll();
})();
