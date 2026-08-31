import { SlashCommandAbortController } from '../slash-commands/SlashCommandAbortController.js';
import { tagCurrentLedgerHistory } from '../nora-story-ledger/client.js';
function parseSmartReplies(value) {
    const raw = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { /* use the line fallback */ }
        }
    }
    const tagged = [...raw.matchAll(/<reply>\s*([\s\S]*?)\s*<\/reply>/gi)].map(match => match[1]);
    const structured = Array.isArray(parsed) ? parsed : (parsed?.suggestions || (tagged.length ? tagged : null));
    const fallback = raw.split('\n').map(line => line.trim().replace(/^(?:[-*]|\d+[.、)）])\s*/, '')).filter(Boolean);
    const suggestions = [...new Set((Array.isArray(structured) ? structured : fallback).map(item => String(item || '').trim()).filter(Boolean))];
    if (suggestions.length !== 3) throw new Error('模型没有返回三条完整的智能回复。');
    return suggestions;
}

function recentDialogue(chat, limit = 10) {
    return (Array.isArray(chat) ? chat : [])
        .filter(message => !message?.is_system && String(message?.mes || '').trim())
        .slice(-limit)
        .map(message => `${message.is_user ? '用户' : (String(message.name || '').trim() || '角色')}：${String(message.mes).trim()}`)
        .join('\n\n');
}

export function createStMessageAdapter(runtime, { ensureBackendReady, reportStage = () => {} } = {}) {
    async function hydrateHistory(id = null) {
        const before = runtime();
        const messageId = id === null
            ? null
            : Number(before.getNoraAbsoluteMessageId?.(id) ?? id);
        await before.ensureNoraFullChatLoaded?.();
        tagCurrentLedgerHistory(runtime());
        return { current: runtime(), messageId };
    }

    function assertActive(signal) {
        if (signal?.aborted) throw Object.assign(new Error('操作已取消。'), { name: 'AbortError' });
    }

    async function sendText(text, { signal } = {}) {
        assertActive(signal);
        const { current: before } = await hydrateHistory();
        const chatLengthBefore = before.chat?.length || 0;
        reportStage('send-adapter-start', {
            characterId: before.characterId,
            chatId: before.chatId,
            chatLength: chatLengthBefore,
        });
        try {
            await ensureBackendReady();
            assertActive(signal);
            reportStage('send-core-dispatch');
            const result = await runtime().sendText(text);
            const after = runtime();
            const newMessages = Array.isArray(after.chat) ? after.chat.slice(chatLengthBefore) : [];
            const userMessagePersisted = newMessages.some(message => message?.is_user && !message?.is_system);
            const assistantReply = newMessages.findLast(message => !message?.is_user && !message?.is_system);
            if (!String(assistantReply?.mes || '').trim()) {
                const error = new Error('The model returned an empty response. Check the model output settings, then regenerate.');
                error.noraMessagePersisted = userMessagePersisted;
                throw error;
            }
            reportStage('send-core-complete', {
                chatLength: after.chat?.length || 0,
                onlineStatus: after.onlineStatus,
            });
            return result;
        } catch (error) {
            reportStage('send-core-failed', { error: String(error?.message || error) });
            throw error;
        }
    }

    async function editAndRegenerate(id, text, { signal } = {}) {
        assertActive(signal);
        let { current, messageId } = await hydrateHistory(id);
        assertActive(signal);
        const message = current.chat?.[messageId];
        if (!message?.is_user) throw new Error('只有用户消息可以编辑后重新生成。');
        // Resolve the model before deleting a user's uncompressed suffix.
        await ensureBackendReady();
        assertActive(signal);
        if (typeof current.commitNoraStoryEdit === 'function' && current.chatMetadata?.nora_world?.id) {
            await current.commitNoraStoryEdit(messageId, String(text ?? ''));
            assertActive(signal);
            const result = await runtime().regenerate();
            const reply = runtime().chat?.at(-1);
            if (!reply || reply.is_user || !String(reply.mes || '').trim()) throw new Error('模型没有返回新的回复，请重试。');
            return result;
        }
        const latestUserId = current.chat.findLastIndex(item => item?.is_user && !item?.is_system);
        if (messageId !== latestUserId) throw new Error('只能编辑当前轮的用户消息。');
        const runBackupTransaction = current.runNoraChatBackupTransaction;
        const execute = async ({ saveBeforeGeneration = false } = {}) => {
            while (current.chat.length > messageId + 1) {
                await current.deleteLastMessage();
                current = runtime();
            }
            await current.commitMessageEdit(messageId, String(text ?? ''));
            if (saveBeforeGeneration) await current.saveChat();
            await ensureBackendReady();
            assertActive(signal);
            const result = await runtime().regenerate();
            const reply = runtime().chat?.at(-1);
            if (!reply || reply.is_user || reply.is_system || !String(reply.mes || '').trim()) {
                throw new Error('模型没有返回新的回复，请重试。');
            }
            return result;
        };
        return typeof runBackupTransaction === 'function'
            ? runBackupTransaction(execute)
            : execute({ saveBeforeGeneration: true });
    }

    async function suggestReplies() {
        await ensureBackendReady();
        const current = runtime();
        const context = recentDialogue(current.chat);
        const prompt = `# 最近五轮对话\n${context || '（暂无对话）'}\n\n请给出 3 条用户接下来可直接发送的完整回复，必须紧扣最后一条角色回复。三条方向分别为：情绪回应、人物互动、剧情推进。每条只写用户自己的动作、想法或对白，不得替其他角色行动或发言。只返回以下格式，不要输出解释：\n<reply>第一条</reply>\n<reply>第二条</reply>\n<reply>第三条</reply>`;
        const raw = await current.generateRaw({
            prompt,
            systemPrompt: '你是角色扮演场景的智能回复建议器。生成三条彼此独立、紧扣当前剧情的用户下一步候选消息。',
            responseLength: 1200,
            trimNames: false,
        });
        return parseSmartReplies(raw);
    }

    async function swipe(id, direction) {
        const { current, messageId } = await hydrateHistory(id);
        const message = current.chat?.[messageId];
        const operation = current.swipe?.[direction];
        if (!message || typeof operation !== 'function') return false;
        const before = {
            mes: message.mes,
            swipeId: Number(message.swipe_id || 0),
            swipeCount: Array.isArray(message.swipes) ? message.swipes.length : 1,
        };
        if (direction === 'right' && before.swipeId >= before.swipeCount - 1) await ensureBackendReady();
        await operation(null, { message });
        const after = runtime().chat?.[messageId];
        const afterSwipeCount = Array.isArray(after?.swipes) ? after.swipes.length : 1;
        const generatedEmptySwipe = direction === 'right'
            && afterSwipeCount > before.swipeCount
            && !String(after?.mes || '').trim();
        if (generatedEmptySwipe) {
            const deleteSwipe = runtime().swipe?.delete;
            if (typeof deleteSwipe !== 'function') {
                throw new Error('The model returned an empty Swipe and ST cannot restore the previous reply.');
            }
            await deleteSwipe(Number(after.swipe_id || 0), messageId);
            throw new Error('The model returned an empty Swipe. The previous reply was restored.');
        }
        return Boolean(after && (after.mes !== before.mes
            || Number(after.swipe_id || 0) !== before.swipeId
            || afterSwipeCount !== before.swipeCount));
    }

    return Object.freeze({
        prepareMutation: () => hydrateHistory(),
        runSlash: async (text, { signal } = {}) => {
            await hydrateHistory();
            const controller = new SlashCommandAbortController();
            controller.noraPrepareGeneration = ensureBackendReady;
            controller.noraAwaitGeneration = true;
            const stop = () => { controller.abort('操作已取消。', true); runtime().stopGeneration(); };
            if (signal?.aborted) throw Object.assign(new Error('操作已取消。'), { name: 'AbortError' });
            signal?.addEventListener('abort', stop, { once: true });
            try {
                const result = await runtime().executeSlashCommandsWithOptions(text, {
                    handleParserErrors: false, handleExecutionErrors: false, abortController: controller,
                });
                if (result?.isError) throw new Error(result.errorMessage || '角色卡命令执行失败');
                if (result?.isAborted || signal?.aborted) throw Object.assign(new Error('操作已取消。'), { name: 'AbortError' });
                return result?.pipe;
            } finally { signal?.removeEventListener('abort', stop); }
        },
        restoreMessage: (id) => {
            const current = runtime();
            const message = current.chat?.[id];
            if (message) current.updateMessageBlock(id, message);
        },
        sendText,
        stop: () => runtime().stopGeneration(),
        regenerate: async ({ signal } = {}) => {
            assertActive(signal);
            await hydrateHistory();
            await ensureBackendReady();
            assertActive(signal);
            return runtime().regenerate();
        },
        editAndRegenerate,
        suggestReplies,
        isGenerating: () => Boolean(runtime().isGenerating?.()),
        swipe,
        editMessage: async (id, text) => {
            const { current, messageId } = await hydrateHistory(id);
            return current.commitMessageEdit(messageId, text);
        },
    });
}
