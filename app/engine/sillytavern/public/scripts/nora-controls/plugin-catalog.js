export const builtinPlugins = Object.freeze({
    regex: { key: 'regex', title: '正则', description: '文本替换与显示规则', icon: 'fa-code' },
    'third-party/JS-Slash-Runner': { key: 'tavern_helper', title: '酒馆助手', description: '卡片脚本与交互功能', icon: 'fa-scroll' },
    'third-party/nora-mvu': { key: 'mvu', title: 'MVU 变量', description: '变量更新与模型配置', icon: 'fa-sliders' },
    'third-party/nora-ledger': { key: 'ledger', title: '剧情账本', description: '当前会话的剧情记忆整理', icon: 'fa-book' },
    'third-party/ST-Prompt-Template': { key: 'prompt_template', title: '提示词模板', description: '动态提示词模板', icon: 'fa-file-lines' },
});

export function pluginCatalog(items) {
    const installed = new Map(items.map(item => [item.name, item]));
    const builtins = Object.entries(builtinPlugins).map(([name, builtin]) => ({
        name, managed: true, editable: false, available: installed.has(name), ...installed.get(name), builtin,
    }));
    const others = items.filter(item => !builtinPlugins[item.name] && !item.managed && item.type !== 'system')
        .map(item => ({ ...item, available: true }))
        .sort((a, b) => a.name.localeCompare(b.name));
    return [...builtins, ...others];
}

export function pluginLibraryStatus(item, runtime, pending = false) {
    if (item.available === false) return '组件缺失';
    if (item.manifestError) return '清单读取失败';
    if (pending) return '已更改，待刷新';
    const enabled = item.libraryEnabled ?? runtime?.enabled;
    if (enabled === false) return runtime?.loaded ? '已停用，待刷新' : '已停用';
    if (runtime?.error) return '加载失败';
    if (runtime?.loaded) return '本页已加载';
    if (item.runtimeReadFailed) return '加载状态读取失败';
    return enabled ? '已启用，尚未加载' : '加载状态未读取';
}

export function ledgerPhase(status) {
    if (!status) return '状态未读取';
    return { queued: '排队中', running: '正在整理', cancelling: '正在取消', waiting: '等待正文完成',
        paused: '失败暂停', disabled: '已关闭', idle: '空闲' }[status.taskPhase]
        || (status.running ? '正在整理' : status.lastError ? '失败暂停' : status.enabled ? '空闲' : '已关闭');
}

export function pluginFeatureStatus(item, world, ledger) {
    if (item.builtin?.key === 'ledger') return ledger ? ledgerPhase(ledger) : world ? '状态未读取' : '未打开会话';
    const capability = world?.capabilities?.declared?.includes(item.builtin?.key) ? world.capabilities.items?.[item.builtin.key] : null;
    if (!world || !item.builtin) return null;
    return capability ? { READY: '世界能力已就绪', PENDING: '世界能力加载中', DEGRADED: '世界能力未就绪' }[capability.status] || '世界能力状态未知' : '当前世界未声明使用';
}
