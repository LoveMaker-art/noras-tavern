/* Real desktop controller. The standalone HTML retains an in-memory preview. */
(() => {
  const api = window.NoraLauncherBridge;
  if (!api && new URLSearchParams(location.search).has('desktop')) {
    clearInline(); $('steps').hidden = true; $('management').hidden = true; $('launchbar').hidden = true;
    say('启动器连接失败。', '请关闭后重新打开桌面启动器。');
    return;
  }
  if (!api || scenario) return;

  if (api.telemetry) {
    const checkbox = $('telemetryEnabled');
    const feedback = $('telemetryFeedback');
    let saved = false;
    const showFeedback = (text, failed = false) => {
      feedback.textContent = text; feedback.hidden = !text;
      feedback.className = failed ? 'error' : '';
    };
    api.telemetry().then(settings => {
      if (!settings?.available) return;
      $('telemetryNotice').hidden = false;
      saved = Boolean(settings.enabled); checkbox.checked = saved; checkbox.disabled = false;
    }).catch(() => {
      $('telemetryNotice').hidden = false;
      showFeedback('设置读取失败，请重新打开启动器后重试。', true);
    });
    checkbox.onchange = async () => {
      const requested = checkbox.checked; checkbox.disabled = true;
      showFeedback('正在保存…');
      try {
        const settings = await api.telemetry(requested);
        if (!settings?.available || typeof settings.enabled !== 'boolean' || settings.enabled !== requested) throw new Error('setting-not-saved');
        saved = settings.enabled; checkbox.checked = saved;
        showFeedback('');
      }
      catch { checkbox.checked = saved; showFeedback('设置未保存，请重试。', true); }
      finally { checkbox.disabled = false; }
    };
  }

  let snapshot = {}, view = 'loading', refreshing = false, activeAction = '', lastFailure = null;
  let alive = true, pollTimer, taskTimer, startedAt = 0, lastEvent = 0;
  let taskStage = '', taskProgress = null, lastProgressAt = 0;
  let milestoneStates = [], currentTask = '', operationCancelled = false;
  let versionInfo = null, versionChecking = false, autoVersionChecked = false, activeService = 'all';
  let pageReturnFocus;
  let modelFormGeneration = 0;
  let sawIncompleteSetup = false, firstCompletionPending = false;
  let autoStartAttempted = false;
  let bundledUpgradeAttempted = false;
  let statusUnknown = false, lastStatusError = '', lastStatusAt = 0, launcherRecoveryConfirmed = false;
  let logsOpen = false, logTimer, logCursor, logOperationId, logGeneration = 0, logFollow = true, logOutcome;
  let logRecords = [], logBytes = 0, logErrorLocated = false, logFirstError, logReturnFocus;
  const logIds = new Set(), logMissing = new Set();
  const consolePanel = document.createElement('section'); consolePanel.className = 'operation-console'; consolePanel.hidden = true;
  consolePanel.setAttribute('aria-label','详细日志');
  consolePanel.innerHTML = '<div class="console-controls"><button class="quiet" id="consoleBack" type="button">返回操作页</button><button class="quiet" id="consoleCopy" type="button">复制本次日志</button></div><p class="console-status" id="consoleStatus" role="status"></p><pre class="console-output" id="consoleOutput" tabindex="0" aria-label="原始执行日志"></pre><button class="quiet console-latest" id="consoleLatest" type="button" hidden>回到最新记录</button>';
  $('main').append(consolePanel);
  const consoleOutput = $('consoleOutput');
  const atLogEnd = () => consoleOutput.scrollHeight - consoleOutput.clientHeight - consoleOutput.scrollTop <= 8;
  consoleOutput.addEventListener('wheel', event => { if (event.deltaY < 0) { logFollow = false; $('consoleLatest').hidden = false; } }, {passive:true});
  consoleOutput.addEventListener('scroll', () => { logFollow = atLogEnd(); $('consoleLatest').hidden = logFollow; });
  $('consoleLatest').onclick = () => { logFollow = true; consoleOutput.scrollTop = consoleOutput.scrollHeight; $('consoleLatest').hidden = true; };
  $('consoleBack').onclick = () => {
    logsOpen = false; logGeneration++; clearTimeout(logTimer);
    consolePanel.hidden = true; $('main').classList.remove('logs-open');
    const target = logReturnFocus?.isConnected && !logReturnFocus.disabled ? logReturnFocus : $('main');
    if (target === $('main')) target.tabIndex = -1;
    target.focus({preventScroll:true});
  };
  async function copyLogText(text) {
    if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(text); return; } catch {} }
    const field = document.createElement('textarea'); field.value = text; field.readOnly = true;
    field.style.cssText = 'position:fixed;left:-10000px;top:0'; document.body.append(field);
    try { field.select(); if (!document.execCommand('copy')) throw new Error('copy failed'); }
    finally { field.remove(); }
  }
  $('consoleCopy').onclick = async () => {
    const control = $('consoleCopy'), generation = logGeneration, id = logOperationId;
    if (!id || control.disabled) return;
    control.disabled = true;
    try {
      // Copy the complete retained operation, including older records that
      // are outside the bounded live viewport. No arbitrary file API.
      let cursor, parts = [], more = true, seen = new Set(), bytes = 0, partial = false;
      while (more && bytes <= 64 * 1024 * 1024 && alive && generation === logGeneration) {
        const result = await api.operationLogs(id, cursor);
        if (result.operationId !== id) throw new Error('日志操作编号不一致。');
        cursor = result.cursor; more = result.hasMore;
        for (const record of result.records) if (!seen.has(record.id)) {
          seen.add(record.id); parts.push(record.text); bytes += record.text.length * 2;
        }
        if (result.missing.length) partial = true;
        for (const reason of result.missing) parts.push(`[WARNING] 日志读取缺失：${reason}`);
      }
      if (more) parts.push('[WARNING] 复制容量已达上限，记录未全部包含。');
      if (generation !== logGeneration || !alive) return;
      await copyLogText(parts.join('\n')); control.textContent = more || partial ? '已复制部分日志' : '已复制本次日志';
    } catch { control.textContent = '复制失败，请重试'; }
    finally { control.disabled = false; }
  };
  async function readConsole(generation = logGeneration) {
    try {
      const result = await api.operationLogs(logOperationId, logCursor);
      if (!alive || !logsOpen || generation !== logGeneration) return;
      if (logOperationId && result.operationId !== logOperationId) throw new Error('日志操作编号不一致。');
      if (!logOperationId && result.operationId) $('consoleCopy').disabled = false;
      logOperationId = result.operationId; logCursor = result.cursor;
      for (const record of result.records) {
        if (logIds.has(record.id)) continue;
        if(Object.hasOwn(record,'outcome')) logOutcome=record.outcome;
        logIds.add(record.id); logBytes += (record.text.length + 1) * 2;
        const line = document.createElement('span'); line.textContent = record.text + '\n'; consoleOutput.append(line);
        logRecords.push({...record,node:line});
        if (record.error && !logFirstError?.isConnected) logFirstError = line;
      }
      // Reading/copying retained disk evidence is separate from the live
      // viewport budget. Never silently label this excerpt as full history.
      let trimmed = false;
      while ((logBytes > 2 * 1024 * 1024 || logRecords.length > 20000) && logRecords.length > 1) {
        const removed = logRecords.shift(); logBytes -= (removed.text.length + 1) * 2; logIds.delete(removed.id);
        removed.node.remove(); trimmed = true;
      }
      const warnings = [...result.missing, ...(trimmed ? ['较早记录未显示；“复制本次日志”可读取仍保留的记录。'] : [])];
      for (const reason of warnings) if (!logMissing.has(reason)) {
        logMissing.add(reason); const line = document.createElement('span'); line.textContent = `[WARNING] ${reason}\n`; consoleOutput.append(line);
      }
      if (logFirstError?.isConnected && !logErrorLocated && logFollow && !busy && !snapshot.busy) {
        logErrorLocated = true; logFollow = false;
        consoleOutput.scrollTop = Math.max(0, logFirstError.offsetTop - consoleOutput.offsetTop - 24); $('consoleLatest').hidden = atLogEnd();
      } else if (logFollow) consoleOutput.scrollTop = consoleOutput.scrollHeight;
      renderConsoleStatus();
      clearTimeout(logTimer); logTimer = setTimeout(() => readConsole(generation), result.hasMore ? 20 : 1000);
    } catch {
      if (!alive || !logsOpen || generation !== logGeneration) return;
      if (!logMissing.has('read_failed')) { logMissing.add('read_failed'); consoleOutput.append(document.createTextNode('[WARNING] 日志暂时无法读取，保留已有记录，正在重新查询。\n')); }
      logTimer = setTimeout(() => readConsole(generation), 3000);
    }
  }
  function renderConsoleStatus() {
    if (!logsOpen) return;
    const operation = snapshot.operation;
    if (!logOperationId) { $('consoleStatus').textContent = '正在读取本次操作日志…'; return; }
    const outcomes={succeeded:'操作已完成',success:'操作已完成',failed:'操作失败',error:'操作失败',cancelled:'操作已取消',interrupted:'操作中断'};
    if(outcomes[logOutcome]) { $('consoleStatus').textContent=outcomes[logOutcome]; return; }
    if (operation?.operationId !== logOperationId) {
      $('consoleStatus').textContent = '历史操作日志；当前任务进度请返回操作页查看。'; return;
    }
    const state = ({succeeded:'操作已完成',failed:'操作失败',cancelled:'操作已取消',interrupted:'操作中断',blocked:'等待处理',
      'rolled-back':'操作已回退','awaiting-handoff':'等待启动器重新打开'})[operation.state] || '任务正在进行';
    const progress = busy && taskStage === 'download' && taskProgress
      ? `已下载 ${progressBytes(taskProgress.current)}${taskProgress.total ? ` / ${progressBytes(taskProgress.total)}` : ''}` : '';
    $('consoleStatus').textContent = [busy ? currentTask || state : state, progress].filter(Boolean).join(' · ');
  }
  $('stop').remove(); $('runtimeState').remove();
  const launchHint = document.createElement('p'); launchHint.className = 'launch-hint'; $('launchbar').prepend(launchHint);
  const textError = error => {
    const message = String(error?.message || error || '操作结果尚未确认，请先重新查询状态。')
      .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').slice(0, 360);
    return /[\u3400-\u9fff]/.test(message) && !/Traceback|\b\w*Error:|\bat\s+\S+\s*\(|WinError|Errno/i.test(message)
      ? message : '原因尚未确认，请点击“查看日志”，保留现有安装和数据。';
  };
  function errorCopy(error) {
    const guidance = error?.guidance;
    if (guidance && typeof guidance.title === 'string' && guidance.title.trim()) {
      return { title: guidance.title.trim().slice(0, 200), detail: [guidance.detail, guidance.next]
        .filter(value => typeof value === 'string' && value.trim()).join('\n').slice(0, 2000) };
    }
    const message = textError(error), lines = message.split('\n').filter(Boolean);
    return [2, 3].includes(lines.length) && lines.every(line => /[\u3400-\u9fff]/.test(line))
      ? { title: lines[0], detail: lines.slice(1).join('\n') }
      : { title: '这一步还没有完成。', detail: message };
  }
  function operationFailure(operation) {
    const failure = operation.currentFailure || operation.primaryFailure;
    const legacyFiles=operation.result?.legacyFilesRestored===true&&operation.result?.legacyServicesVerified!==true;
    const guidance=legacyFiles?{title:'旧版本文件已恢复。',
      detail:'旧记录未保存服务运行状态，当前服务保持停止。恢复后的数据来自更新前的备份，较新的数据已另行完整保留。',
      next:'确认恢复版本后可启动旧版本，勿删除备份。'}:failure?.guidance;
    return Object.assign(new Error('操作尚未完成。'), { operation, guidance,
      userCode: failure?.code, allowedActions: operation.allowedActions });
  }
  function currentOperation(error) {
    const operation = error?.operation, current = snapshot.operation;
    return operation && current?.operationId === operation.operationId && current.snapshotSequence >= operation.snapshotSequence
      ? current : operation;
  }
  function allowedActions(error) {
    if (statusUnknown) return ['recheck', 'logs'];
    const actions = currentOperation(error)?.allowedActions || error?.allowedActions;
    return Array.isArray(actions) ? actions : ['recheck', 'logs'];
  }
  function noraUpdateGuidance(error, action) {
    return ['update', 'check_update'].includes(action)
      && ['dns_failed','network','tls_failed','timeout','http_unauthorized','http_forbidden','rate_limited','http_error'].includes(error?.failureCode)
      && complete() && allRunning() && snapshot.modelConfigured && !snapshot.busy && !snapshot.updateRecovery && !snapshot.launcherRecovery
      ? '网络恢复后，也可对诺拉说“更新到最新版本”。' : '';
  }
  async function recheckFailure() {
    if (busy) return;
    const primary = lastFailure, operation = currentOperation(primary?.error) || snapshot.operation;
    if (!operation || statusUnknown || typeof api.recheckOperation !== 'function') { await refreshFailure(); return; }
    busy = true; controls();
    try {
      const result = await api.recheckOperation({ operationId: operation.operationId, snapshotSequence: operation.snapshotSequence });
      syncState(result); busy = false;
      if (result.operation || !primary) route(); else fail(primary.error, primary.action, primary.retry, primary);
    } catch (error) {
      busy = false; fail(error, primary?.action || operation.kind, primary?.retry, primary || {});
    } finally { controls(); }
  }
  async function refreshFailure() {
    if (busy) return;
    const primary = lastFailure;
    busy = true; controls();
    try {
      await readStatus(); busy = false;
      if (snapshot.updateRecovery || snapshot.launcherRecovery || snapshot.operation || !primary) route();
      else fail(primary.error, primary.action, primary.retry, primary);
    } catch {
      busy = false;
      if (launcherRecoveryConfirmed) route();
      else if (primary) fail(primary.error, primary.action, primary.retry, primary);
      else route();
    } finally { controls(); }
  }
  function recoveryReason(reason) {
    const readable = textError(reason);
    return readable === String(reason)
      ? readable : '恢复检查尚未通过，具体原因尚未确认。请保留备份并查看日志，暂时不要重复恢复或清空安装。';
  }

  function hasLogs() { return typeof api.operationLogs === 'function' || typeof api.openLogs === 'function'; }
  function appendActions(container, entries) {
    const primary = entries.find(entry => entry.primary) || entries.find(entry => !entry.quiet) || entries[0];
    entries.forEach((entry, index) => {
      const control = button(entry.label, entry.run, entry === primary);
      if (entry.id) control.id = entry.id;
      if(Number.isSafeInteger(entry.retryAt)&&entry.retryAt>Date.now())control.dataset.retryAt=String(entry.retryAt);
      if (entry.quiet && entry !== primary) control.className = 'quiet';
      container.append(control);
    });
  }
  function checkedTime(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '';
  }
  function unknownStatusCopy() {
    return '运行状态未知，正在重新查询。暂不能启动或恢复。';
  }
  function operationFact(operation) {
    if (!operation) return '';
    if (operation.recoveryOutcome === 'files-restored-start-failed') return '旧版本文件已恢复，启动检查未通过。';
    if (operation.effectState === 'unknown') return '程序状态尚未确认，请勿删除安装目录或备份。';
    if (operation.effectState === 'restored') return operation.verification === 'confirmed'
      ? '已恢复旧版本，并通过启动检查。' : '旧版本文件已恢复，尚未通过启动检查。';
    if (operation.effectState === 'untouched') return '本次未替换程序文件。';
    if (operation.effectState === 'changed') return '程序文件已变更，结果待确认。请保留安装目录和备份。';
    return '';
  }
  function retryLabel(action, resume) {
    const name = ({ install: '安装', update: '更新', repair: '修复', start: '启动', stop: '停止', restart: '重启' })[action];
    return name ? `${resume ? '继续' : '重新尝试'}${name}` : resume ? '继续' : '重试';
  }

  function complete() { return Boolean(snapshot.setupCompleted ?? snapshot.installer?.setupCompleted) && snapshot.systemReady !== false; }
  function canReturnHome() {
    if (!complete() || snapshot.systemReady !== true || statusUnknown || busy || snapshot.busy
      || snapshot.updateRecovery || snapshot.launcherRecovery || snapshot.modelSyncPending) return false;
    const operation = snapshot.operation || lastFailure?.error?.operation;
    if (!operation || !['install','update','repair','recover','recoverLauncher'].includes(operation.kind)) return true;
    return recoveredOperation(operation) || operation.state === 'succeeded'
      || operation.effectState === 'restored' && operation.verification === 'confirmed'
        && !['recovery-required','files-restored-start-failed'].includes(operation.recoveryOutcome)
      || operation.effectState === 'untouched' && !operation.handoffRef
        && (!operation.recoveryOutcome || operation.recoveryOutcome === 'not-required');
  }
  function serviceRunning() { return Boolean(snapshot.running || snapshot.gatewayRunning); }
  function allRunning() { return !statusUnknown && Boolean(snapshot.running && snapshot.gatewayRunning && snapshot.clawchatConnected); }
  function syncState(value) {
    if (value.operation && snapshot.operation && value.operation.operationId === snapshot.operation.operationId
      && value.operation.snapshotSequence < snapshot.operation.snapshotSequence) value = { ...value, operation: snapshot.operation };
    snapshot = { ...snapshot, ...value };
    running = Boolean(snapshot.running);
    daily = complete();
    if (!daily) sawIncompleteSetup = true;
    else if (sawIncompleteSetup) { firstCompletionPending = true; sawIncompleteSetup = false; }
  }
  async function readStatus() {
    launcherRecoveryConfirmed = false;
    try {
      const value = await api.status();
      if (Object.hasOwn(value, 'launcherRecovery')) {
        // The launcher backup assessment is independent of runtime status.
        snapshot = { ...snapshot, launcherRecovery: value.launcherRecovery };
        if (typeof value.busy === 'boolean') snapshot.busy = value.busy;
        launcherRecoveryConfirmed = value.busy === false && value.launcherRecovery?.canRecover === true;
      }
      if (value.statusUnavailable || (value.warning && !value.installed && !value.hermesInstalled))
        throw new Error(value.warning || '暂时无法查询后台状态。');
      syncState(value); statusUnknown = false; lastStatusError = ''; lastStatusAt = Date.now();
      return value;
    } catch (error) { statusUnknown = true; lastStatusError = textError(error); throw error; }
  }
  function hideMenu() { $('more').hidden = true; $('moreButton').setAttribute('aria-expanded', 'false'); }
  function controls() {
    const recoveryView = view === 'recovery' && Boolean(snapshot.updateRecovery || snapshot.launcherRecovery);
    const freshInstall = view === 'welcome' && !statusUnknown && !snapshot.operation && !snapshot.installer?.startedAt
      && !snapshot.installed && !snapshot.hermesInstalled && !snapshot.noraInstalled && !serviceRunning();
    $('management').hidden = freshInstall || recoveryView || view === 'error' || view !== 'daily' && (busy || Boolean(snapshot.busy));
    if (freshInstall) hideMenu();
    document.querySelectorAll('#management [data-action]').forEach(control => {
      control.hidden = !complete() && !['uninstall', 'logs'].includes(control.dataset.action);
      if (control.dataset.action === 'logs') control.hidden = typeof api.operationLogs !== 'function' && typeof api.openLogs !== 'function';
    });
    $('launchbar').hidden = recoveryView || !complete() || view !== 'daily';
    $('status').hidden = !recoveryView && complete() && !statusUnknown && view !== 'error';
    if (!statusUnknown && view === 'error') $('status').textContent = '需要处理';
    if (statusUnknown) {
      if ($('status').dataset.unavailable !== 'true') $('status').dataset.previousLabel = $('status').textContent;
      $('status').textContent = '状态暂时无法确认';
    } else if ($('status').dataset.unavailable === 'true' && $('status').textContent === '状态暂时无法确认') {
      $('status').textContent = $('status').dataset.previousLabel || '需要你参与';
    }
    $('status').dataset.unavailable = String(statusUnknown);
    $('launch').disabled = busy || Boolean(snapshot.busy) || statusUnknown;
    const recover = $('recoverUpdate');
    if (recover) recover.disabled = busy || Boolean(snapshot.busy) || statusUnknown;
    const recoverLauncher = $('recoverLauncher');
    if (recoverLauncher) recoverLauncher.disabled = busy || Boolean(snapshot.busy) || (statusUnknown && !launcherRecoveryConfirmed);
    const cancel = $('taskCancel');
    if (cancel) cancel.disabled = snapshot.canCancel !== true || operationCancelled;
    let action = '打开酒馆';
    if (['start', 'restart'].includes(activeAction) && activeService !== 'nora') action = '正在启动';
    if (activeAction === 'open') action = '正在打开';
    launchHint.hidden = Boolean(snapshot.running) && !statusUnknown;
    launchHint.textContent = statusUnknown ? '正在重新查询服务状态' : action === '正在启动' ? '正在准备酒馆' : '点击后仅启动酒馆';
    $('launch').querySelector('span').textContent = action;
    $('stopAll').dataset.unavailable = String(!serviceRunning());
    document.querySelectorAll('[data-action], #moreButton, .services button, .conversation-entry button').forEach(item => {
      item.disabled = busy || Boolean(snapshot.busy) || item.dataset.unavailable === 'true';
      if (item.dataset.action === 'logs') item.disabled = false;
    });
    if (view === 'daily') $('moreButton').disabled = false;
    $('inline').querySelectorAll('[data-retry-at]').forEach(control=>{
      control.disabled=busy||Boolean(snapshot.busy)||Number(control.dataset.retryAt)>Date.now();
    });
    if (statusUnknown) document.querySelectorAll('.services button, .conversation-entry button, #stopAll').forEach(item => { item.disabled = true; });
    if (statusUnknown) document.querySelectorAll('#management [data-action]').forEach(item => {
      if (['stop-all', 'uninstall'].includes(item.dataset.action)) item.disabled = true;
    });
    const submit = $('inline').querySelector('button[type="submit"]');
    if (submit) {
      submit.disabled = busy || Boolean(snapshot.busy) || statusUnknown || submit.dataset.unavailable === 'true';
      submit.classList.toggle('primary', !statusUnknown && submit.dataset.unavailable !== 'true');
    }
    const modelQuery = $('inline').querySelector('#modelStatusRecheck');
    if (modelQuery) {
      modelQuery.hidden = !statusUnknown && modelQuery.dataset.pending !== 'true';
      modelQuery.disabled = busy || Boolean(snapshot.busy);
      modelQuery.classList.toggle('primary', !modelQuery.hidden);
    }
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
    $('main').classList.remove('welcome', 'update-recovery');
    $('main').classList.toggle('editing', daily);
    $('management').hidden = !daily;
    displaySteps(); controls();
  }
  function renderServices() {
    let group = [...$('inline').children].find(node => node.className === 'services');
    if (!group) {
      clearInline();
      group = document.createElement('div'); group.className = 'services'; group.setAttribute('aria-label', '服务控制');
      $('inline').append(group);
      const footer = document.createElement('div'); footer.id = 'dailyVersionSlot'; footer.className = 'services-footer';
      $('inline').append(footer);
    }
    for (const id of ['nora', 'tavern']) {
      const name = id === 'nora' ? '诺拉' : '酒馆', isOn = Boolean(id === 'nora' ? snapshot.gatewayRunning : snapshot.running);
      const transitioning = busy && ['start', 'stop', 'restart'].includes(activeAction) && [id, 'all'].includes(activeService);
      const state = transitioning ? activeAction === 'stop' ? 'stopping' : 'starting' : statusUnknown ? 'unknown' : isOn ? 'running' : 'stopped';
      let row = [...group.children].find(node => node.dataset.service === id);
      if (!row) {
        row = document.createElement('div'); row.className = 'service-row'; row.dataset.service = id;
        row.innerHTML = `<i class="service-symbol fa-solid fa-${id === 'nora' ? 'wand-magic-sparkles' : 'mug-saucer'}" aria-hidden="true"></i><div class="service-name">${name}</div><span class="service-state" role="status"></span>`;
        group.append(row);
      }
      row.dataset.state = state;
      row.querySelector('.service-state').textContent = { running: '运行中', stopped: '已停止', starting: '启动中', stopping: '停止中', unknown: '状态未知' }[state];
      for (const [index, action] of ['restart', isOn ? 'stop' : 'start'].entries()) {
        const label = ({ restart: '重启', stop: '停止', start: '启动' })[action] + name;
        let control = [...row.children].filter(node => node.className === 'icon-action')[index];
        if (!control) { control = document.createElement('button'); control.className = 'icon-action'; control.innerHTML = '<i class="fa-solid" aria-hidden="true"></i>'; row.append(control); }
        control.dataset.tip = label; control.setAttribute('aria-label', label);
        control.dataset.unavailable = String(action === 'restart' && !isOn);
        control.querySelector('i').className = `fa-solid fa-${({ restart: 'rotate-right', stop: 'stop', start: 'play' })[action]}`;
        control.onclick = () => run(action, { service: id });
      }
    }
  }
  dailyHome = (message = '') => {
    const sameView = view === 'daily';
    view = 'daily'; daily = true; running = Boolean(snapshot.running);
    $('main').classList.remove('welcome', 'editing', 'update-recovery', 'completion');
    $('main').classList.add('daily'); $('steps').hidden = true; $('management').hidden = false;
    if (!sameView) hideMenu();
    $('launchbar').classList.remove('enter');
    const introduce = firstCompletionPending && allRunning() && !message && !snapshot.warning && !statusUnknown;
    $('main').classList.toggle('completion', introduce);
    say(statusUnknown ? '服务状态暂时无法确认。' : message || (introduce ? '酒馆准备好了。' : snapshot.running || snapshot.gatewayRunning ? '欢迎回来，坐一会儿吧。' : '随时可以继续。'),
      statusUnknown ? unknownStatusCopy() : snapshot.warning ? textError(snapshot.warning) : recoveredOperation(snapshot.operation) ? `已恢复版本：${snapshot.version || '版本待确认'}。` : snapshot.gatewayRunning && !snapshot.clawchatConnected
        ? 'ClawChat 暂未连通，请在更多中检查连接。' : '', '', {animate:false});
    renderServices();
    renderConversationEntry();
    controls();
    showVersionNotice();
  };
  function renderConversationEntry() {
    const existing = $('inline').querySelector('.conversation-entry');
    if (!snapshot.clawchatPaired) { existing?.remove(); return; }
    if (existing) return;
    const entry = document.createElement('div'); entry.className = 'conversation-entry';
    const action = document.createElement('button'); action.type = 'button'; action.className = 'conversation-link';
    action.innerHTML = '<i class="fa-solid fa-comment" aria-hidden="true"></i><span>去 ClawChat 找我</span><i class="fa-solid fa-arrow-up-right-from-square entry-arrow" aria-hidden="true"></i>';
    const introduce = firstCompletionPending && allRunning();
    const guidance = document.createElement('p'); guidance.id = 'conversationGuidance'; guidance.className = 'conversation-guidance'; guidance.hidden = !introduce; guidance.setAttribute('role', 'status');
    guidance.textContent = introduce ? '在 ClawChat 联系人中找到诺拉，发一句「你好」。' : '';
    action.setAttribute('aria-controls', guidance.id); action.setAttribute('aria-expanded', String(introduce));
    action.onclick = async () => {
      if (busy || snapshot.busy || action.disabled) return;
      const introduce = firstCompletionPending && allRunning();
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
  closeEdit = () => { if (!busy) {
    const home = canReturnHome(); lastFailure = null; if (home) dailyHome(); else route();
    if (home && pageReturnFocus?.isConnected && !pageReturnFocus.disabled) pageReturnFocus.focus({preventScroll:true});
  } };

  async function openLogs(event, operationId) {
    if (typeof api.operationLogs === 'function') {
      hideMenu(); logReturnFocus = event?.currentTarget?.dataset?.action === 'logs' ? $('moreButton') : event?.currentTarget;
      logsOpen = true; logGeneration++; clearTimeout(logTimer);
      logOperationId = operationId || (busy ? undefined : lastFailure?.error?.operation?.operationId || lastFailure?.error?.logOperationId || snapshot.operation?.operationId);
      logOutcome=undefined;
      logCursor = undefined; logRecords = []; logBytes = 0; logIds.clear(); logMissing.clear();
      logErrorLocated = false; logFirstError = undefined; logFollow = true; consoleOutput.replaceChildren();
      $('consoleCopy').textContent = '复制本次日志'; $('consoleCopy').disabled = !logOperationId; $('consoleLatest').hidden = true;
      $('consoleBack').textContent = view === 'model' ? '返回模型设置' : '返回操作页';
      consolePanel.hidden = false; $('main').classList.add('logs-open'); consoleOutput.focus({preventScroll:true});
      await readConsole(logGeneration); return;
    }
    const control = event?.currentTarget;
    let note = $('logFeedback');
    if (!note) {
      note = document.createElement('p'); note.id = 'logFeedback'; note.className = 'install-location';
      note.setAttribute('role', 'status'); $('inline').append(note);
    }
    if (control) control.disabled = true; note.textContent = '正在打开日志…';
    try {
      const result = await api.openLogs();
      note.textContent = result?.ok ? '已请求系统打开日志文件。' : `未能打开日志。${textError(result?.warning || '请稍后重试。')}`;
    } catch (error) { note.textContent = `未能打开日志。${textError(error)}`; }
    finally { if (control) control.disabled = false; }
  }

  function recoveredOperation(operation) {
    return operation?.state === 'rolled-back' && operation.verification === 'confirmed'
      && operation.currentFailure === null
      && ['restored-and-verified', 'not-required'].includes(operation.recoveryOutcome);
  }
  function route() {
    $('main').classList.remove('update-recovery');
    if (statusUnknown && !launcherRecoveryConfirmed) {
      if (lastFailure?.error) fail(lastFailure.error, lastFailure.action, lastFailure.retry, lastFailure);
      else fail('状态暂时无法确认，请等待查询恢复后再继续。', 'status', refreshFailure);
      return;
    }
    if (snapshot.busy) {
      view = 'monitor'; clearInline(); setupStage(stage);
      say(snapshot.installer?.phase === 'update' ? '正在更新。' : '任务正在进行。', snapshot.installer?.task || '');
      if (hasLogs()) $('inline').append(button('查看日志', openLogs, false));
      controls();
      return;
    }
    if (snapshot.updateRecovery || snapshot.launcherRecovery) {
      view = 'recovery'; daily = false; clearInline();
      $('main').classList.remove('welcome', 'daily', 'editing'); $('main').classList.add('update-recovery'); $('steps').hidden = true;
      const appRecovery = snapshot.updateRecovery, launcherRecovery = snapshot.launcherRecovery;
      const filesRestored=snapshot.operation?.recoveryOutcome==='files-restored-start-failed';
      const permitted = !snapshot.operation || snapshot.operation.allowedActions?.some(action=>['recover','start-restored'].includes(action));
      const canRecheck = snapshot.operation ? snapshot.operation.allowedActions?.includes('recheck') : typeof api.status === 'function';
      const recheckLabel = snapshot.operation ? '重新检查' : '重新查询状态';
      const canRecover = !launcherRecovery && !statusUnknown && appRecovery?.canRecover
        && typeof api[snapshot.operation ? 'recoverOperation' : 'recover'] === 'function' && permitted;
      const canRecoverLauncher = (!statusUnknown || launcherRecoveryConfirmed) && launcherRecovery?.canRecover && typeof api.recoverLauncher === 'function';
      const legacy=appRecovery?.kind==='legacy';
      let title = canRecover ? filesRestored?'旧版本文件已恢复。':'更新中断了。' : canRecoverLauncher ? '启动器更新中断了。' : '暂时不能恢复旧版本。';
      let message = canRecover ? filesRestored?'诺拉或酒馆尚未启动成功。处理错误后可启动旧版本。':`${appRecovery.restoreVersion ? `可恢复至 ${appRecovery.restoreVersion}` : '可恢复更新前的程序'}。恢复期间请保持窗口打开。`
          : canRecoverLauncher ? '恢复期间请保持窗口打开，等待旧启动器启动。' + (statusUnknown ? '\n诺拉和酒馆状态未知，其他操作暂不可用。' : '')
            : launcherRecovery ? '请先处理启动器恢复记录，保留安装目录和备份。'
            : !permitted ? `恢复检查未通过。${canRecheck ? `请先${recheckLabel}。` : '请复制日志反馈。'}\n请勿删除安装目录或备份。`
              : '备份尚未通过检查。请复制日志反馈，勿删除安装目录或备份。';
      if (legacy && canRecover) {
        title = '旧更新需要恢复。';
        message = `将恢复到 ${appRecovery.restoreVersion||'更新前的版本'}，还原当时的数据和配置。较新数据另存，暂不合并。\n恢复后需手动启动。`;
      }
      const original = snapshot.operation?.primaryFailure?.guidance || lastFailure?.error?.guidance;
      say(title, message);
      const actions = document.createElement('div'); actions.className = 'recovery-actions';
      actions.classList.add('outcome-actions');
      const entries = [];
      if (canRecoverLauncher) entries.push({label:'恢复旧启动器', run:() => run('recoverLauncher'), id:'recoverLauncher'});
      if (canRecover) entries.push({label:filesRestored?'启动旧版本':'恢复旧版本', run:() => snapshot.operation ? continueOperation('recover') : run('recover'), id:'recoverUpdate'});
      if (!canRecover && canRecheck) entries.push({label:recheckLabel, run:recheckFailure});
      if (hasLogs()) entries.push({label:'查看日志', run:openLogs, quiet:true});
      appendActions(actions, entries);
      $('inline').append(actions);
      const details = document.createElement('details'); details.className = 'recovery-details';
      const summary = document.createElement('summary'); summary.textContent = '恢复详情'; details.append(summary);
      const information = document.createElement('dl');
      const add = (label, value) => {
        if (!value) return;
        const term = document.createElement('dt'); term.textContent = label;
        const description = document.createElement('dd'); description.textContent = value; information.append(term, description);
      };
      if (original?.title) add('最初失败', errorCopy({ guidance: original }).title);
      for (const [label, recovery, capable] of [['酒馆', appRecovery, canRecover], ['启动器', launcherRecovery, canRecoverLauncher]]) {
        if (!recovery) continue;
        const reason = recovery.reason || (recovery.canRecover && !capable ? label === '酒馆' && launcherRecovery
          ? '请先处理启动器程序恢复，再继续酒馆恢复。' : label === '酒馆' && !permitted
          ? '后台尚未允许再次恢复，请先检查当前条件并查看日志。' : '恢复组件不可用，请保留日志和备份。' : '');
        if (reason) { const readable = recoveryReason(reason); add(`${label}恢复检查`, readable); if (readable !== String(reason)) add(`${label}恢复技术记录`, reason); }
        add(`${label}备份位置`, recovery.backup); add(`${label}日志位置`, recovery.log);
        if(recovery.kind==='legacy'){
          add('恢复版本',recovery.restoreVersion);add('恢复记录',recovery.journalReference);
          add('数据处理','恢复备份中的数据和配置；当前较新内容完整保存在 failed-* 目录，暂不自动合并。');
        }
      }
      add('失败信息', lastFailure?.error ? [errorCopy(lastFailure.error).title, errorCopy(lastFailure.error).detail].filter(Boolean).join('\n') : snapshot.installer?.phase === 'error' ? textError(snapshot.installer.error) : '');
      if (information.children.length) { details.append(information); $('inline').append(details); }
      controls(); $('launchbar').hidden = true; $('status').hidden = false; $('status').textContent = '需要恢复'; return;
    }
    const operation = snapshot.operation;
    const restoredSuccessfully = recoveredOperation(operation);
    if (operation && !restoredSuccessfully&&['failed', 'cancelled', 'blocked', 'interrupted', 'rolled-back'].includes(operation.state)) {
      fail(operationFailure(operation), operation.kind); return;
    }
    if (snapshot.installer?.resumeTarget && snapshot.installer.phase === 'error') {
      fail(snapshot.installer.error, 'update');
      return;
    }
    if (snapshot.installed && snapshot.hermesInstalled && snapshot.bundledUpgradeTarget) {
      const target = snapshot.bundledUpgradeTarget;
      if (!bundledUpgradeAttempted && snapshot.installer?.phase !== 'error') {
        bundledUpgradeAttempted = true;
        run('update', { tag: target });
        return;
      }
      view = 'recovery'; daily = false; clearInline();
      $('main').classList.remove('welcome', 'daily', 'editing');
      $('steps').hidden = true;
      say('继续完成版本升级。', snapshot.installer?.error || `启动器已就绪，酒馆将升级到 ${target}。世界、对话和配置会保留。`);
      if (snapshot.installer?.phase === 'error') { fail(snapshot.installer.error, 'update'); return; }
      $('inline').append(button('继续更新', () => run('update', { tag: target })));
      controls(); return;
    }
    if (!autoStartAttempted && snapshot.installed && snapshot.hermesInstalled && snapshot.systemReady === true) {
      autoStartAttempted = true;
      if (!snapshot.running) { run('start', { service: 'tavern', resumeSetup: true }); return; }
    }
    if (complete()) {
      dailyHome(restoredSuccessfully ? operation.kind === 'update' ? '更新未完成，已恢复旧版本。' : '操作已回退，恢复后的状态已核验。' : '');
      return;
    }
    if (snapshot.installed && snapshot.systemReady === false) {
      view = 'recovery'; daily = false;
      $('status').textContent = '需要修复';
      $('main').classList.remove('welcome', 'daily', 'editing');
      $('steps').hidden = true; $('management').hidden = true; clearInline();
      say('当前安装需要修复。', (snapshot.systemProblems || []).slice(0, 2).join('；'));
      const repair = button('修复当前安装', () => run('update'));
      repair.disabled = !snapshot.version;
      $('inline').append(repair);
      const note = document.createElement('p'); note.className = 'install-location';
      note.textContent = '使用最新兼容版本修复，保留世界、对话和配置。' + (!snapshot.version ? '无法确认版本，请先导出日志。' : '');
      $('inline').append(note);
      if (hasLogs()) $('inline').append(button('查看日志', openLogs, false));
      controls(); return;
    }
    if (!snapshot.hermesInstalled || !snapshot.installed || snapshot.systemReady === false) {
      view = 'welcome'; daily = false; $('main').classList.add('welcome'); $('main').classList.remove('daily', 'editing');
      $('steps').hidden = true; $('management').hidden = true; clearInline();
      const interrupted = snapshot.hermesInstalled || snapshot.installer?.startedAt;
      say(interrupted ? '接着把酒馆准备好。' : '我是诺拉。欢迎来到酒馆。',
        snapshot.systemProblems?.length ? snapshot.systemProblems.slice(0, 2).join('；') : interrupted ? '已完成的安装会保留。' : '先把我和酒馆安顿在这台电脑上。');
      $('inline').append(button(serviceRunning() ? '先停止诺拉与酒馆' : interrupted ? '继续安装' : '安装酒馆', serviceRunning() ? () => run('stop') : install));
      const note = document.createElement('div'); note.className = 'install-location';
      const location = document.createElement('span'); location.textContent = snapshot.noraHome || 'NoraTavern';
      location.setAttribute('aria-label', '安装目录'); note.append(location);
      if (snapshot.canChooseDirectory && typeof api.chooseInstallDirectory === 'function') {
        const choose = document.createElement('button'); choose.className = 'install-location-choose';
        choose.type = 'button'; choose.setAttribute('aria-label', '更改安装位置'); choose.dataset.tip = '更改位置';
        choose.innerHTML = '<i class="fa-solid fa-folder-open" aria-hidden="true"></i>';
        choose.onclick = async () => {
          if (busy || snapshot.busy) return;
          busy = true; choose.disabled = true;
          $('inline').querySelectorAll('button').forEach(item => { item.disabled = true; }); controls();
          try { await api.chooseInstallDirectory(); await readStatus(); busy = false; route(); }
          catch (error) {
            busy = false; route();
            const feedback = document.createElement('p'); feedback.className = 'install-location-error';
            feedback.setAttribute('role', 'alert'); feedback.textContent = textError(error); $('inline').append(feedback);
          }
        };
        note.append(choose);
      }
      $('inline').append(note);
      controls(); return;
    }
    if (snapshot.modelSyncPending) { pendingModel(); return; }
    if (!snapshot.modelConfigured) { modelForm(); return; }
    if (!snapshot.clawchatPaired) { clawForm(); return; }
    setupStage(4); run('start');
  }
  function taskView(action) {
    view = 'task'; setupStage(stage); clearInline(); $('management').hidden = true;
    const messages = { install: '正在安装诺拉与酒馆。', pair: '正在连接 ClawChat。', start: activeService === 'nora' ? '正在启动诺拉。' : activeService === 'tavern' ? '正在启动酒馆。' : '正在启动诺拉与酒馆。', stop: '正在停止服务。', update: '正在更新诺拉与酒馆。', repair: '正在修复安装。', recover: '正在恢复旧版本，请保持窗口打开。', recoverLauncher: '正在恢复旧启动器，请保持窗口打开。' };
    say(messages[action] || '我正在处理。');
    $('inline').innerHTML = '<div class="job"><div class="job-head"><span id="jobTitle"></span><span id="jobPercent"></span></div><div class="meter indeterminate"><span id="meterFill"></span></div><div class="job-note" id="jobNote"></div></div><div class="task-actions" id="taskActions"></div>';
    currentTask = '准备中'; startedAt = Date.now(); lastEvent = startedAt;
    taskStage = ''; taskProgress = null; lastProgressAt = startedAt;
    const cancel = button('取消任务', async () => {
      cancel.disabled = true;
      try {
        const result = await api.cancel(); if (!result.ok) throw new Error(result.warning);
        operationCancelled = true; snapshot.canCancel = false; cancel.textContent = '正在取消…'; taskStage = 'cancel'; taskProgress = null;
        $('jobPercent').textContent = ''; document.querySelector('.meter')?.classList.add('indeterminate');
        currentTask = '正在取消，请等待任务结束'; updateTask();
      }
      catch (error) { snapshot.canCancel = false; snapshot.cancelReason = textError(error); updateTask(); }
    }, false);
    cancel.id = 'taskCancel'; cancel.disabled = snapshot.canCancel !== true;
    cancel.className = 'quiet'; if (!['recover', 'recoverLauncher'].includes(action)) $('taskActions').append(cancel);
    if (hasLogs()) $('taskActions').append(button('查看日志', openLogs, false));
    clearInterval(taskTimer); taskTimer = setInterval(updateTask, 1000); updateTask();
  }
  function progressBytes(value) {
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 ** 2).toFixed(1)} MB`;
  }
  function updateTask() {
    if (!$('jobTitle')) return;
    $('jobTitle').textContent = currentTask;
    const now = Date.now();
    const timing = `已用时 ${Math.floor((now - startedAt) / 1000)} 秒`;
    const downloading = taskStage === 'download' && taskProgress;
    const notes = [downloading ? `已下载 ${progressBytes(taskProgress.current)}${taskProgress.total ? ` / ${progressBytes(taskProgress.total)}` : ''} · ${timing}` : timing];
    if (taskStage === 'download') {
      if (now - lastProgressAt >= 180000 && (!taskProgress?.total || taskProgress.current < taskProgress.total)) {
        notes.push('下载已连续 3 分钟无进展，请检查网络或代理。');
      }
    } else if (taskStage !== 'cancel' && now - lastEvent > 20000) {
      notes.push('正在等待处理结果。');
    }
    if (snapshot.canCancel === false && snapshot.cancelReason && taskStage !== 'cancel') notes.push(snapshot.cancelReason);
    $('jobNote').textContent = notes.join('\n');
    if (typeof renderConsoleStatus === 'function') renderConsoleStatus();
  }
  function onEvent(event) {
    if (typeof event.canCancel === 'boolean') { syncState({canCancel:event.canCancel,cancelReason:event.cancelReason}); controls(); }
    if (operationCancelled && ['task','milestone','progress'].includes(event.event)) return;
    if (event.operation) syncState({ operation: event.operation });
    if (event.event !== 'heartbeat') lastEvent = Date.now();
    if (event.event === 'milestone' && event.index >= 0 && event.index < 5) {
      milestoneStates[event.index] = event.state;
      if (event.state === 'running') stage = event.index;
      displaySteps();
    }
    if (event.event === 'task' || event.event === 'milestone') {
      const nextStage = event.stage_id || (event.event === 'task' ? '' : taskStage);
      if (nextStage !== taskStage) {
        taskStage = nextStage;
        taskProgress = null; lastProgressAt = Date.now();
      }
      currentTask = event.task || currentTask;
      const meter = document.querySelector('.meter');
      if (meter) { meter.classList.add('indeterminate'); $('jobPercent').textContent = ''; }
      updateTask();
    }
    if (event.event === 'progress' && $('meterFill')) {
      if (event.stage_id && event.stage_id !== taskStage) {
        taskStage = event.stage_id; taskProgress = null; lastProgressAt = Date.now();
      }
      const current = Number.isFinite(event.current) && event.current >= 0 ? event.current : null;
      const total = Number.isFinite(event.total) && event.total > 0 ? event.total : null;
      if (current !== null) {
        if (!taskProgress || current > taskProgress.current) lastProgressAt = Date.now();
        taskProgress = {current, total};
      }
      const ratio = taskStage === 'download' ? current !== null && total !== null ? current / total : null
        : typeof event.ratio === 'number' && Number.isFinite(event.ratio) ? event.ratio
          : current !== null && total !== null ? current / total : null;
      document.querySelector('.meter').classList.toggle('indeterminate', ratio === null);
      $('jobPercent').textContent = ratio === null ? '' : `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
      if (ratio !== null) $('meterFill').style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
      updateTask();
    }
  }
  function continueOperation(mode = 'resume', expected = snapshot.operation) {
    const operation = snapshot.operation;
    if (expected?.operationId !== operation?.operationId) return;
    if (busy || statusUnknown || !operation || !operation.allowedActions?.some(action => mode === 'recover' ? ['recover','start-restored'].includes(action) : ['retry','resume'].includes(action))) return;
    const endpoint = mode === 'recover' ? 'recoverOperation' : 'resumeOperation';
    if (typeof api[endpoint] !== 'function') return;
    return run(mode === 'recover' ? 'recover' : operation.kind, {
      operationId: operation.operationId, snapshotSequence: operation.snapshotSequence }, endpoint);
  }
  async function openLauncherDownload(event) {
    const control=event.currentTarget;
    let note=$('launcherDownloadFeedback');
    if(!note){
      note=document.createElement('p');note.id='launcherDownloadFeedback';note.className='install-location';
      note.setAttribute('role','status');$('inline').append(note);
    }
    control.disabled=true;note.textContent='正在打开下载页…';
    try{
      const result=await api.openExternal('https://github.com/LoveMaker-art/noras-tavern/releases/latest');
      if(result?.ok!==true)throw new Error('系统尚未确认下载页已打开。');
      note.textContent='已请求打开下载页。请下载对应系统的完整启动器，保留原数据目录后覆盖安装。';
    }catch(error){note.textContent=`未能打开下载页。${textError(error)}可通过左下角“项目地址”查看最新发布。`;}
    finally{control.disabled=false;}
  }
  function fail(error, action, retry, context = {}) {
    view = 'error'; clearInline();
    lastFailure = { error, action, retry, options: context.options || {} };
    const operation = currentOperation(error);
    const problem = errorCopy(operation && operation.snapshotSequence > (error?.operation?.snapshotSequence ?? -1) ? operationFailure(operation) : error);
    const actions = allowedActions(error), fact = operationFact(operation);
    const explanation = fact ? problem.detail.split('\n').filter(line => !/^(安装|更新|修复|启动|停止|重启|本次操作)(尚未确认完成|未完成)[，。]/.test(line)).join('\n') : problem.detail;
    const detail = [...new Set([explanation, fact].filter(Boolean))];
    const noraGuidance = noraUpdateGuidance(error, action); if (noraGuidance) detail.push(noraGuidance);
    if (statusUnknown) detail.push(unknownStatusCopy());
    say(operation?.state === 'cancelled' || operationCancelled ? '操作已取消。' : problem.title, detail.filter(Boolean).join('\n'));
    const entries = [];
    if (!statusUnknown && actions.includes('configure-model')) entries.push({label:'配置模型', run:modelForm});
    if (!statusUnknown && actions.includes('pair-clawchat')) entries.push({label:'连接 ClawChat', run:clawForm});
    if (!statusUnknown && actions.includes('recover') && operation && typeof api.recoverOperation === 'function') entries.push({label:'恢复旧版本', run:() => continueOperation('recover', operation)});
    if (!statusUnknown && actions.includes('start-restored') && operation && typeof api.recoverOperation === 'function') entries.push({label:'启动旧版本', run:() => continueOperation('recover', operation)});
    if (!statusUnknown && actions.includes('resume-model') && typeof api.resumeModelSetup === 'function') entries.push({label:'继续同步', run:() => run('resumeModelSetup')});
    if (actions.includes('replace-launcher') && typeof api.openExternal === 'function') entries.push({label:'下载新版完整启动器', run:openLauncherDownload});
    if (!statusUnknown && actions.some(value => ['retry','resume'].includes(value))) {
      if (operation && typeof api.resumeOperation === 'function') entries.push({label:retryLabel(action, actions.includes('resume')), run:() => continueOperation('resume', operation)});
      else if (!operation && retry) entries.push({label:retryLabel(action, false), run:retry});
    }
    if (actions.includes('recheck')) entries.push({label:operation && !statusUnknown ? '重新检查' : '重新查询状态', run:recheckFailure});
    if (actions.includes('logs') && hasLogs()) entries.push({label:'查看日志', run:openLogs, quiet:true});
    if (canReturnHome()) entries.push({label:'返回酒馆', run:() => { lastFailure = null; dailyHome(); }, quiet:true});
    const group = document.createElement('div'); group.className = 'outcome-actions';
    appendActions(group, entries); $('inline').append(group);
    controls();
  }
  async function run(action, options = {}, endpoint = action) {
    if (busy) return;
    if (statusUnknown && !(action === 'recoverLauncher' && launcherRecoveryConfirmed)) {
      const primary = lastFailure;
      fail(primary?.error || '状态暂时无法确认，请先重新查询状态。', primary?.action || action, primary?.retry, primary || {}); return;
    }
    const operation = snapshot.operation;
    if (operation && !recoveredOperation(operation) && ['failed', 'cancelled', 'blocked', 'interrupted', 'rolled-back'].includes(operation.state)
      && (operation.kind === action || ['install','update','repair','recover'].includes(action))
      && !['resumeOperation','recoverOperation'].includes(endpoint)) { route(); return; }
    if ((snapshot.updateRecovery || snapshot.launcherRecovery) && !['recover', 'recoverLauncher'].includes(action)) { route(); return; }
    const wasComplete = complete();
    if (wasComplete) firstCompletionPending = false;
    busy = true; operationCancelled = false; activeAction = action; activeService = options.service || 'all'; lastFailure = null;
    if (wasComplete && ['start', 'stop', 'restart'].includes(action)) { dailyHome(); } else taskView(action);
    controls();
    try {
      if (['recover', 'recoverLauncher'].includes(action) && endpoint !== 'recoverOperation') {
        try { await readStatus(); } catch (error) {
          if (action !== 'recoverLauncher' || !launcherRecoveryConfirmed) throw error;
        }
        const recovery = action === 'recoverLauncher' ? snapshot.launcherRecovery : snapshot.updateRecovery;
        if (!recovery?.canRecover || snapshot.busy || (statusUnknown && (action !== 'recoverLauncher' || !launcherRecoveryConfirmed)) || typeof api[action] !== 'function') { busy = false; activeAction = ''; clearInterval(taskTimer); route(); return; }
      }
      const result = await api[endpoint]({ port: snapshot.port || 8799, ...options, onEvent });
      if (result.restarting) { currentTask = action === 'recoverLauncher' ? '正在恢复旧启动器，等待窗口重新打开' : '正在重启，随后继续更新'; updateTask(); return; }
      if (action === 'recoverLauncher' && result.restored === true) {
        snapshot.launcherRecovery = null; launcherRecoveryConfirmed = false;
        busy = false; activeAction = ''; clearInterval(taskTimer);
        try { await readStatus(); } catch {}
        if (statusUnknown) fail('旧启动器已恢复。\n诺拉和酒馆的当前运行状态尚未确认。\n请重新查询状态，保留现有数据和日志。', 'status', refreshFailure);
        else route();
        return;
      }
      syncState(result); await readStatus();
      const selectedRunning = activeService === 'nora' ? snapshot.gatewayRunning && snapshot.clawchatConnected : activeService === 'tavern' ? snapshot.running : allRunning();
      if (['start', 'restart'].includes(action) && !selectedRunning) throw new Error('所选服务尚未就绪，请先重新查询状态并查看日志。');
      if (['start', 'restart'].includes(action) && activeService === 'all' && !complete()) throw new Error('服务已启动，但安装复核尚未完成，请先重新查询状态。');
      if (action === 'start' && !wasComplete && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        $('steps').classList.add('depart');
        await wait(350);
      }
      busy = false; activeAction = ''; clearInterval(taskTimer);
      if (action === 'stop') {
        const stillRunning = activeService === 'nora' ? snapshot.gatewayRunning : activeService === 'tavern' ? snapshot.running : serviceRunning();
        if (stillRunning) throw new Error('所选服务尚未停止，请先重新查询状态。');
        if (wasComplete) dailyHome(activeService === 'all' ? '服务已停止，故事还在。' : activeService === 'nora' ? '诺拉已暂停。' : '酒馆已停止。');
        else route();
      } else if (['start', 'restart'].includes(action)) {
        if (options.resumeSetup || !complete()) route();
        else dailyHome();
        if (options.openAfter) await openTavern();
      } else if (['update', 'repair', 'recover', 'recoverLauncher'].includes(action)) {
        versionInfo = null; autoVersionChecked = false; route();
      } else route();
    } catch (error) {
      busy = false; activeAction = ''; clearInterval(taskTimer);
      if (error.operation) syncState({ operation: error.operation });
      lastFailure = { error, action, options, retry: () => run(action, options) };
      try { await readStatus(); } catch {}
      if (['update', 'repair', 'recover', 'recoverLauncher'].includes(action) && (snapshot.updateRecovery || snapshot.launcherRecovery)) {
        if (!statusUnknown) snapshot.installer = { ...snapshot.installer, phase: 'error', error: textError(error) };
        route(); return;
      }
      // Single-use pairing codes are never replayed automatically.
      const retry = action === 'pair'
        ? snapshot.clawchatPaired ? () => run('start') : clawForm
        : () => run(action, options);
      fail(error, action, retry, { options });
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
    const generation = ++modelFormGeneration;
    view = 'model'; setupStage(2); clearInline();
    say(complete() ? '这次想用哪个模型？' : '连接一个模型，我们继续。');
    if (complete()) editHeader('模型设置', canReturnHome() ? '返回酒馆' : '返回操作页');
    let providers;
    try {
      const result = await api.modelProviders();
      if (!result.ok) throw new Error(result.warning);
      if (view !== 'model' || generation !== modelFormGeneration) return;
      providers = result.providers;
    } catch (error) { if (view === 'model' && generation === modelFormGeneration) fail(error, 'model', modelForm); return; }
    const form = document.createElement('form');
    form.innerHTML = '<div class="fields"><div><div class="field-line"><label for="provider">模型服务</label><a class="quiet" id="getKey" target="_blank" rel="noopener noreferrer">获取 API Key</a></div><select id="provider"></select></div><div><label for="key">API Key</label><div class="secret"><input id="key" type="password" autocomplete="off" placeholder="粘贴 API Key"><button class="eye" type="button" title="显示或隐藏 Key" aria-label="显示或隐藏 API Key"><i class="fa-solid fa-eye"></i></button></div></div><div class="wide" id="endpointField" hidden><label for="endpoint">接口地址</label><input id="endpoint" type="url" placeholder="https://example.com/v1"></div><div class="wide"><div class="field-line"><label for="model">模型名称</label><button type="button" class="quiet" id="loadModels">获取模型列表</button></div><input id="model" list="modelOptions" placeholder="选择或输入模型名称"><datalist id="modelOptions"></datalist></div></div><p class="model-feedback" id="feedback" role="status">API Key 保存在本机，不随日志上传。</p><div class="form-bottom"><span></span><button class="button primary" type="submit"></button></div>';
    form.querySelector('button[type="submit"]').textContent = complete() ? '验证并保存' : '验证并继续';
    $('inline').append(form);
    const authField = document.createElement('div');
    authField.id = 'authField';
    authField.innerHTML = '<label for="authMode">认证方式</label><select id="authMode"><option value="key">API Key</option><option value="none">无需认证（本地服务）</option></select>';
    form.querySelector('.fields').append(authField);
    const notice = document.createElement('p'); notice.className = 'model-feedback';
    notice.hidden = true;
    form.append(notice);
    providers.forEach(provider => { const option = document.createElement('option'); option.value = provider.id; option.textContent = provider.label; $('provider').append(option); });
    const savedProvider = snapshot.modelProvider?.startsWith('custom:') ? 'custom' : snapshot.modelProvider;
    $('provider').value = providers.some(p => p.id === savedProvider) ? savedProvider : providers[0].id;
    const selected = () => providers.find(p => p.id === $('provider').value);
    const syncProvider = () => {
      const provider = selected(); $('endpointField').hidden = !provider.custom; $('loadModels').hidden = false;
      authField.hidden = !provider.custom;
      $('authMode').value = provider.custom && savedProvider === provider.id && snapshot.modelAuthMode === 'none' ? 'none' : 'key';
      syncAuth();
      $('getKey').hidden = !provider.signupUrl; if (provider.signupUrl) $('getKey').href = provider.signupUrl;
      $('key').value = ''; $('modelOptions').replaceChildren();
      $('model').value = (savedProvider === provider.id ? snapshot.modelName : '')
        || (provider.id === 'deepseek' ? 'deepseek-v4-flash' : '');
      $('endpoint').value = savedProvider === provider.id ? snapshot.modelBaseUrl || '' : '';
    };
    const syncAuth = () => {
      const local = selected().custom && $('authMode').value === 'none';
      $('key').closest('.secret').parentElement.hidden = local;
      notice.hidden = !local; notice.textContent = local ? '请先启动本地模型服务。' : '';
    };
    $('authMode').onchange = syncAuth;
    $('provider').onchange = syncProvider; syncProvider();
    form.querySelector('.eye').onclick = () => { $('key').type = $('key').type === 'password' ? 'text' : 'password'; };
    let modelOperationId;
    const logs = button('查看日志', event => openLogs(event, modelOperationId), false); logs.type = 'button'; logs.className = 'quiet'; logs.hidden = true;
    form.querySelector('.form-bottom').prepend(logs);
    let submissionUncertain = false, pendingMessage = '';
    const query = button('重新查询状态', async () => {
      if (busy) return; lock(true);
      try {
        await readStatus();
        if (submissionUncertain && snapshot.modelSyncPending && typeof api.resumeModelSetup === 'function') pendingModel(pendingMessage);
        else if (submissionUncertain && snapshot.modelConfigured && !snapshot.modelSyncPending) route();
        else feedback(pendingMessage ? `${pendingMessage}\n当前状态已确认，请根据提示继续。` : '当前状态已确认，可以继续配置。', Boolean(pendingMessage));
      } catch (error) { feedback(`${pendingMessage}\n${unknownStatusCopy()}`, true); }
      finally { lock(false); }
    }, false);
    query.id = 'modelStatusRecheck'; query.type = 'button'; query.hidden = !statusUnknown;
    form.querySelector('.form-bottom').prepend(query);
    const feedback = (text, error = false) => {
      $('feedback').textContent = text; $('feedback').classList.toggle('error', error);
      logs.hidden = !error || !hasLogs();
    };
    const lock = value => { busy = value; form.querySelectorAll('input,select,button').forEach(c => { c.disabled = value; });
      form.querySelector('button[type="submit"]').dataset.unavailable = String(submissionUncertain);
      query.dataset.pending = String(submissionUncertain); controls(); };
    $('loadModels').onclick = async () => {
      if (!$('key').value.trim() && !(selected().custom && $('authMode').value === 'none')) { feedback('请先填写 API Key。', true); return; }
      lock(true); feedback('正在获取模型列表。');
      try { const result = await api.modelOptions({ provider: $('provider').value, key: $('key').value.trim(), baseUrl: $('endpoint').value.trim(), authMode: $('authMode').value });
        $('modelOptions').replaceChildren(); result.models.forEach(name => { const option = document.createElement('option'); option.value = name; $('modelOptions').append(option); });
        feedback('模型列表已更新。');
      } catch (error) {
        modelOperationId = error.operation?.operationId || error.logOperationId;
        const copy = errorCopy(error);
        const unsupported = [404,405,501].includes(error.technical?.http_status);
        feedback(`${copy.title}\n${unsupported ? '请核对接口地址；未提供列表的服务，可输入其公布的模型名称。' : copy.detail}`, true);
      } finally { lock(false); }
    };
    form.onsubmit = async event => {
      event.preventDefault(); if (busy || submissionUncertain || statusUnknown) return;
      const payload = { provider: $('provider').value, key: $('key').value.trim(), model: $('model').value.trim(), baseUrl: selected().custom ? $('endpoint').value.trim() : '', authMode: selected().custom ? $('authMode').value : 'key' };
      if (!payload.key && payload.authMode !== 'none') { feedback('请填写 API Key。', true); return; }
      if (selected().custom && !payload.baseUrl) { feedback('请填写模型服务的接口地址。', true); return; }
      if (!payload.model) { feedback('请选择或填写模型名称。', true); return; }
      lock(true); feedback('正在测试模型响应。');
      let configurationSaved = false;
      try {
        const result = await api.saveAndTestModel(payload); modelOperationId = result?.operation?.operationId;
        if (result?.operation) syncState({operation:result.operation});
        configurationSaved = true; $('key').value = ''; await readStatus(); lock(false);
        if (!snapshot.modelConfigured) throw new Error('模型配置复核未通过，请重新连接。');
        if (complete()) {
          dailyHome(snapshot.gatewayRunning ? '模型配置已保存，重启诺拉后生效。' : '模型配置已保存，下次启动诺拉时生效。');
          if (snapshot.gatewayRunning) $('inline').append(button('重启诺拉', () => run('restart', { service: 'nora' })));
        } else route();
      } catch (error) {
        if (error.operation) { modelOperationId = error.operation.operationId; syncState({operation:error.operation}); }
        const copy = errorCopy(error);
        const message = (copy.title + '\n' + copy.detail).replaceAll(payload.key || '\0', '***');
        try { await readStatus(); } catch {}
        const partial = configurationSaved || error.userCode === 'MODEL_CONFIG_PARTIAL';
        submissionUncertain = partial; pendingMessage = configurationSaved
          ? '配置已保存，请查询状态，无需再次提交。' : message;
        lock(false);
        if (snapshot.modelSyncPending && !partial && allowedActions(error).includes('resume-model')) pendingModel(message);
        else {
          feedback(`${pendingMessage}${statusUnknown ? `\n${unknownStatusCopy()}` : ''}`, true);
        }
      }
    };
    controls();
  };
  function pendingModel(message = '') {
    view = 'model-pending'; setupStage(2); clearInline();
    say('酒馆配置同步未完成。', message || '模型配置已保存，无需重新填写 API Key。');
    $('inline').append(button('继续同步', async () => {
      if (busy) return;
      busy = true; controls();
      try {
        await api.resumeModelSetup(); await readStatus(); busy = false; route();
      } catch (error) {
        busy = false;
        try { await readStatus(); } catch {}
        fail(error, 'resumeModelSetup', pendingModel);
      } finally { controls(); }
    }));
    $('inline').append(button('更换模型配置', modelForm, false));
    controls();
  }
  clawForm = () => {
    if (busy) return;
    view = 'claw'; setupStage(3); clearInline();
    say(snapshot.clawchatPaired ? 'ClawChat 配对已保留。' : '把我接到 ClawChat 吧。');
    if (complete()) editHeader('ClawChat', canReturnHome() ? '返回酒馆' : '返回操作页');
    const content = document.createElement('div'); content.className = 'pair';
    content.innerHTML = '<p>在 ClawChat 获取配对码，然后填在这里。</p><div class="task-actions" id="clawActions"></div>';
    $('inline').append(content);
    $('clawActions').append(button('下载 ClawChat', () => api.openClawChat().catch(error => fail(error, 'claw', clawForm)), false));
    if (snapshot.clawchatPaired) $('clawActions').append(button(snapshot.clawchatConnected ? '检查并启动' : '重新连接', () => { stage = 4; run('start', { service: complete() ? 'nora' : 'all' }); }));
    const form = document.createElement('form'); form.className = 'pair-form';
    form.innerHTML = '<div class="field-line"><label for="pairCode">配对码</label><a class="quiet" href="https://clawling.com/zh/chat/docs/connect-code/" target="_blank" rel="noopener noreferrer">如何获取配对码 <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a></div><input id="pairCode" type="password" autocomplete="off" placeholder="粘贴 ClawChat 配对码"><p class="model-feedback" id="pairFeedback"></p><div class="form-bottom"><span></span><button class="button primary" type="submit">连接并继续</button></div>';
    form.querySelector('button[type="submit"]').textContent = complete() ? '配对并连接' : '配对并继续';
    if (snapshot.clawchatPaired) {
      const replace = button('重新配对', () => { replace.hidden = true; form.hidden = false; }, false); replace.className = 'quiet'; $('inline').append(replace); form.hidden = true;
    }
    $('inline').append(form);
    form.onsubmit = event => { event.preventDefault(); if (busy || statusUnknown) return; const code = $('pairCode').value.trim();
      if (!code || /\s/.test(code)) { $('pairFeedback').textContent = '请填写配对码，不是整条激活命令。'; return; }
      $('pairCode').value = ''; run('pair', { code });
    };
  };
  async function checkUpdates(options = {}) {
    if (view === 'daily' && options.currentTarget) pageReturnFocus = options.currentTarget;
    if (busy) return; busy = true; view = 'update'; clearInline(); setupStage(stage); say('正在检查更新。'); controls();
    try {
      const result = await api.checkUpdate(); busy = false; versionInfo = result;
      const state = result.state || (result.available ? 'available' : 'current');
      const channelName = result.channel === 'beta' ? 'Beta 测试版' : '正式版';
      const reused = result.latestConfirmed !== true && Boolean(result.checkedAt);
      const problem = result.error || result.compatibilityError ? errorCopy({message:result.error || result.compatibilityError}) : null;
      const title = problem ? problem.title
        : { available: '发现可用更新。', blocked: '此版本暂时无法安装。', current: `暂无${channelName}更新。`, ahead: `本机酒馆版本高于${channelName}发布。`, unknown: '本机版本暂时无法确认。', unavailable: '检查更新未完成。' }[state];
      const versions = `酒馆：当前 ${result.current || '待确认'}${result.latest ? ` · 发布 ${result.latest}` : ''}\n启动器：当前 ${result.launcherVersion || '待确认'} · 发布 ${result.launcherLatest || '待确认'}`;
      const explanation = [versions, problem?.detail, state === 'blocked' ? '本次未开始安装此版本。' : '',
        result.checkedAt ? `${reused ? '上次检查结果' : '检查时间'}：${checkedTime(result.checkedAt)}` : ''].filter(Boolean).join('\n');
      const noraGuidance = state === 'unavailable' ? noraUpdateGuidance(result, 'check_update') : '';
      say(title, [explanation, noraGuidance].filter(Boolean).join('\n'));
      const operation = snapshot.operation, entries = [];
      const unresolved = operation && !recoveredOperation(operation) && ['install','update','repair','recover'].includes(operation.kind)
        && ['failed','cancelled','blocked','interrupted','rolled-back'].includes(operation.state);
      if (statusUnknown) {
        const note = document.createElement('p'); note.className = 'model-feedback'; note.textContent = unknownStatusCopy(); $('inline').append(note);
        entries.push({label:'重新查询状态', run:refreshFailure, primary:true});
      } else if (result.available && result.updateSupported && !unresolved) entries.push({label:'安装更新', run:() => run('update', { tag: result.latest }), primary:true});
      else if (unresolved) {
        const note = document.createElement('p'); note.className = 'model-feedback';
        note.textContent = '请先处理上次安装或更新。'; $('inline').append(note);
        entries.push({label:'查看上次操作', run:route, primary:true});
      }
      if (state === 'unavailable' || reused) entries.push({label:'重新检查更新', run:() => checkUpdates(options), retryAt:result.retryAt,primary:!entries.length});
      if (hasLogs()) entries.push({label:'查看日志', run:event=>openLogs(event,result.logOperationId), quiet:true});
      if (result.releaseUrl) entries.push({label:'查看版本说明', run:() => api.openExternal(result.releaseUrl).catch(error => fail(error, 'update', checkUpdates)), quiet:true});
      entries.push({label:canReturnHome() ? '返回酒馆' : '返回操作页', run:closeEdit, quiet:true,
        primary:state === 'current' && !statusUnknown && !unresolved && !reused});
      const group = document.createElement('div'); group.className = 'outcome-actions';
      appendActions(group, entries); $('inline').append(group);
    } catch (error) { busy = false; fail(error, 'update', checkUpdates); }
    controls();
  }
  function showVersionNotice() {
    if (view !== 'daily' || busy || !versionInfo || $('versionNotice')) return;
    if (!versionInfo.available && !['blocked', 'unknown', 'unavailable'].includes(versionInfo.state)) return;
    const notice = document.createElement('div'); notice.id = 'versionNotice'; notice.className = 'note';
    const summary = versionInfo.state === 'unavailable' ? '检查更新未完成' : versionInfo.state === 'blocked' ? '此版本暂时无法安装' : versionInfo.state === 'unknown' ? '本机版本暂时无法确认'
      : versionInfo.available ? `${versionInfo.latestConfirmed === true ? '发现' : '上次检查发现'}可用更新 ${versionInfo.latest}` : `本机酒馆版本高于最新${versionInfo.channel === 'beta' ? 'Beta 测试版' : '正式版'}`;
    const details = button('检查更新', checkUpdates, false); details.className = 'quiet';
    const label = document.createElement('span'); label.textContent = summary; label.title = summary;
    notice.append(label, details);
    $('dailyVersionSlot').append(notice);
  }
  async function checkVersionsInBackground() {
    if (!complete() || autoVersionChecked || versionChecking || busy || snapshot.busy) return;
    autoVersionChecked = true; versionChecking = true;
    try { versionInfo = await api.checkUpdate(); }
    catch (error) { versionInfo = { state: 'unavailable', error: textError(error) }; }
    finally { versionChecking = false; showVersionNotice(); }
  }
  document.querySelectorAll('[data-action]').forEach(control => { control.onclick = () => {
    const action = control.dataset.action;
    if (action === 'logs' && hasLogs()) { hideMenu(); openLogs({ currentTarget: control }); return; }
    if (busy) return; hideMenu();
    if (['model','claw','community','update','settings'].includes(action)) pageReturnFocus = control.closest('#more') ? $('moreButton') : control;
    if (action === 'model') modelForm();
    if (action === 'claw') clawForm();
    if (action === 'community') { view = 'community'; community(canReturnHome() ? '返回酒馆' : '返回操作页'); }
    if (action === 'update') checkUpdates();
    if (action === 'stop-all') run('stop', { service: 'all' });
    if (action === 'uninstall') {
      busy = true; controls();
      api.uninstall({ onProgress: task => {
        busy = true; view = 'uninstall'; clearInline(); say(task); controls();
      } }).then(result => {
        busy = false;
        if (result?.cancelled || result?.started === false) {
          if (view !== 'daily') route(); else controls();
          if (view === 'daily') $('moreButton').focus({preventScroll:true});
        }
      }).catch(error => { busy = false; fail(error, 'uninstall', route); }).finally(controls);
    }
    if (action === 'settings') {
      view = 'settings'; clearInline(); $('main').classList.add('editing'); say('安装信息。'); editHeader('安装信息', canReturnHome() ? '返回酒馆' : '返回操作页');
      for (const [label, value] of [['安装目录', snapshot.noraHome], ['酒馆版本', snapshot.version || '版本待确认'], ['启动器版本', versionInfo?.launcherVersion || '版本待确认']]) {
        const row = document.createElement('div'); row.className = 'settings-row'; const title = document.createElement('span'); title.textContent = label;
        const detail = document.createElement('span'); detail.textContent = value; detail.style.overflowWrap = 'anywhere'; row.append(title, detail); $('inline').append(row);
      }
      $('inline').append(button('打开安装目录', () => api.openInstallDirectory().catch(error => fail(error, 'settings', route)), false));
    }
    controls();
  }; });
  async function poll() {
    if (!alive) return;
    if (!busy && !refreshing) {
      refreshing = true;
      const wasUnknown = statusUnknown;
      try {
        const beforeOperation = JSON.stringify(snapshot.operation);
        const before = JSON.stringify([snapshot.running, snapshot.gatewayRunning, snapshot.clawchatConnected, snapshot.warning]);
        const recoveryView = view === 'recovery';
        const recoverySignature = () => JSON.stringify([snapshot.updateRecovery, snapshot.launcherRecovery].map(value => value
          ? [Boolean(value.canRecover), value.reason || '', value.backup || '', value.job || ''] : null).concat(
            snapshot.installer?.phase === 'error' ? snapshot.installer.error || '' : '', snapshot.operation?.allowedActions || []));
        const beforeRecovery = recoveryView ? recoverySignature() : '';
        const detailsOpen = recoveryView && $('inline').querySelector('.recovery-details')?.open === true;
        await readStatus();
        if (!busy && recoveryView && view === 'recovery' && beforeRecovery !== recoverySignature()) {
          route();
          const details = view === 'recovery' && $('inline').querySelector('.recovery-details');
          if (details && detailsOpen) details.open = true;
        } else if (!busy && view === 'error' && (wasUnknown || beforeOperation !== JSON.stringify(snapshot.operation))) {
          if (snapshot.operation || snapshot.updateRecovery || snapshot.launcherRecovery || !lastFailure) route();
          else fail(lastFailure.error, lastFailure.action, lastFailure.retry, lastFailure);
        }
        else if (view === 'loading' || (view === 'monitor' && !snapshot.busy)) route();
        else if (view === 'daily' && (wasUnknown || before !== JSON.stringify([snapshot.running, snapshot.gatewayRunning, snapshot.clawchatConnected, snapshot.warning]))) dailyHome();
        controls();
        void checkVersionsInBackground();
      } catch (error) {
        if (!busy && launcherRecoveryConfirmed && ['loading', 'error'].includes(view)) route();
        else if (view === 'loading') fail(error, 'status', () => { view = 'loading'; poll(); });
        else if (!busy && view === 'recovery') route();
        else if (!busy && view === 'error' && !wasUnknown && lastFailure) fail(lastFailure.error, lastFailure.action, lastFailure.retry, lastFailure);
        else if (view === 'daily') dailyHome();
        controls();
      }
      finally { refreshing = false; }
    }
    clearTimeout(pollTimer); pollTimer = setTimeout(poll, 5000);
  }
  addEventListener('beforeunload', () => { alive = false; logGeneration++; clearTimeout(logTimer); clearTimeout(pollTimer); clearInterval(taskTimer); });
  clearInline(); $('steps').hidden = true; $('launchbar').hidden = true; say('正在检查本机安装。');
  poll();
})();
