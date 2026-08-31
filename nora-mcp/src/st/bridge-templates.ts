export const BRIDGE_ID = "st-mcp-runtime-bridge";

export function bridgeServerPluginPackage(): string {
  return JSON.stringify({
    name: BRIDGE_ID,
    version: "0.1.0",
    private: true,
    type: "module",
    main: "index.mjs",
  }, null, 2) + "\n";
}

export function bridgeServerPluginIndex(): string {
  return `import express from 'express';

export const info = {
  id: '${BRIDGE_ID}',
  name: 'ST MCP Runtime Bridge',
  description: 'Receives browser runtime snapshots for external Agent control through st-mcp.'
};

let latestSnapshot = null;
const history = [];
const MAX_HISTORY = 20;

export async function init(router) {
  router.use(express.json({ limit: '2mb' }));

  router.get('/health', (_request, response) => {
    response.json({
      ok: true,
      plugin: info.id,
      hasSnapshot: Boolean(latestSnapshot),
      snapshotCount: history.length,
      latestReceivedAt: latestSnapshot?.receivedAt ?? null
    });
  });

  router.get('/snapshot', (_request, response) => {
    if (!latestSnapshot) {
      response.status(404).json({ ok: false, error: 'no runtime snapshot has been published yet' });
      return;
    }
    response.json({ ok: true, snapshot: latestSnapshot });
  });

  router.post('/snapshot', (request, response) => {
    const body = typeof request.body === 'object' && request.body !== null ? request.body : {};
    latestSnapshot = normalizeSnapshot(body);
    history.push(latestSnapshot);
    while (history.length > MAX_HISTORY) history.shift();
    response.json({ ok: true, receivedAt: latestSnapshot.receivedAt });
  });

  router.get('/history', (_request, response) => {
    response.json({ ok: true, history });
  });
}

export async function exit() {
  latestSnapshot = null;
  history.length = 0;
}

function normalizeSnapshot(value) {
  return {
    schema: 'st-mcp-runtime-snapshot/v1',
    receivedAt: new Date().toISOString(),
    publishedAt: typeof value.publishedAt === 'string' ? value.publishedAt : null,
    url: typeof value.url === 'string' ? value.url.slice(0, 500) : '',
    title: typeof value.title === 'string' ? value.title.slice(0, 300) : '',
    state: sanitize(value.state),
    events: Array.isArray(value.events) ? value.events.slice(-30).map((event) => sanitize(event)) : []
  };
}

function sanitize(value, depth = 0) {
  if (depth > 5) return '[max-depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 4000 ? value.slice(0, 4000) + '...[truncated]' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (/secret|token|key|password|cookie|authorization/i.test(key)) {
        output[key] = '[redacted]';
      } else {
        output[key] = sanitize(item, depth + 1);
      }
    }
    return output;
  }
  return String(value);
}
`;
}

export function bridgeServerPluginReadme(): string {
  return `# ST MCP Runtime Bridge

Server plugin side of the runtime bridge.

It receives browser snapshots from the matching frontend extension and exposes:

- \`GET /api/plugins/${BRIDGE_ID}/health\`
- \`GET /api/plugins/${BRIDGE_ID}/snapshot\`
- \`POST /api/plugins/${BRIDGE_ID}/snapshot\`
- \`GET /api/plugins/${BRIDGE_ID}/history\`
`;
}

export function bridgeExtensionManifest(): string {
  return JSON.stringify({
    display_name: "ST MCP Runtime Bridge",
    loading_order: 99,
    requires: [],
    optional: [],
    js: "index.js",
    author: "st-mcp",
    version: "0.1.0",
    homePage: "https://github.com/SillyTavern/SillyTavern",
    auto_update: false,
    hooks: {
      activate: "init",
    },
  }, null, 2) + "\n";
}

export function bridgeExtensionIndex(): string {
  return `import { eventSource, event_types, getRequestHeaders } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

const BRIDGE_ENDPOINT = '/api/plugins/${BRIDGE_ID}/snapshot';
const EVENT_LIMIT = 30;
const RECENT_MESSAGE_LIMIT = 12;

let initialized = false;
let publishTimer = null;
const events = [];

export function init() {
  if (initialized) return;
  initialized = true;
  globalThis.StMcpRuntimeBridge = {
    publishNow,
    getSnapshot: buildSnapshot,
    version: '0.1.0'
  };

  subscribe();
  schedulePublish('init');
  setInterval(() => schedulePublish('interval'), 15000);
}

function subscribe() {
  const names = [
    'APP_READY',
    'CHAT_CHANGED',
    'CHAT_LOADED',
    'MESSAGE_SENT',
    'MESSAGE_RECEIVED',
    'MESSAGE_EDITED',
    'MESSAGE_DELETED',
    'MESSAGE_SWIPED',
    'GENERATION_STARTED',
    'GENERATION_ENDED',
    'GENERATION_STOPPED',
    'SETTINGS_UPDATED',
    'CHARACTER_EDITED',
    'WORLDINFO_UPDATED',
    'WORLDINFO_SETTINGS_UPDATED'
  ];

  for (const name of names) {
    const type = event_types?.[name];
    if (!type) continue;
    eventSource.on(type, (...args) => {
      rememberEvent(name, args);
      schedulePublish(name);
    });
  }
}

function rememberEvent(name, args) {
  events.push({
    name,
    at: new Date().toISOString(),
    args: summarizeArgs(args)
  });
  while (events.length > EVENT_LIMIT) events.shift();
}

function schedulePublish(reason) {
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = setTimeout(() => publishNow(reason).catch(() => {}), 250);
}

async function publishNow(reason = 'manual') {
  const payload = {
    publishedAt: new Date().toISOString(),
    url: location.href,
    title: document.title,
    reason,
    state: buildSnapshot(),
    events
  };

  const response = await fetch(BRIDGE_ENDPOINT, {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(\`ST MCP bridge publish failed: HTTP \${response.status}\`);
  }

  return response.json();
}

function buildSnapshot() {
  const context = safeContext();
  const chat = Array.isArray(context?.chat) ? context.chat : [];
  const characters = Array.isArray(context?.characters) ? context.characters : [];
  const extensionSettings = context?.extensionSettings || {};

  return {
    schema: 'st-mcp-browser-state/v1',
    capturedAt: new Date().toISOString(),
    location: {
      hash: location.hash,
      pathname: location.pathname
    },
    active: {
      characterId: context?.characterId ?? null,
      groupId: context?.groupId ?? null,
      chatId: readValue(context, ['chatId']) ?? callMaybe(context, 'getCurrentChatId') ?? null,
      mainApi: context?.mainApi ?? context?.main_api ?? null,
      onlineStatus: context?.onlineStatus ?? null
    },
    counts: {
      characters: characters.length,
      chatMessages: chat.length,
      disabledExtensions: Array.isArray(extensionSettings.disabledExtensions)
        ? extensionSettings.disabledExtensions.length
        : 0
    },
    characters: characters.slice(0, 100).map((character, index) => ({
      index,
      name: character?.name ?? character?.data?.name ?? '',
      avatar: character?.avatar ?? '',
      favorite: Boolean(character?.fav)
    })),
    recentMessages: chat.slice(-RECENT_MESSAGE_LIMIT).map(summarizeMessage),
    extensions: {
      disabled: Array.isArray(extensionSettings.disabledExtensions)
        ? extensionSettings.disabledExtensions.slice(0, 200)
        : []
    },
    globals: {
      hasSillyTavern: Boolean(globalThis.SillyTavern)
    }
  };
}

function safeContext() {
  try {
    if (globalThis.SillyTavern?.getContext) return globalThis.SillyTavern.getContext();
    return getContext();
  } catch {
    return {};
  }
}

function summarizeMessage(message, index) {
  return {
    index,
    name: message?.name ?? '',
    isUser: Boolean(message?.is_user),
    isSystem: Boolean(message?.is_system),
    swipeId: message?.swipe_id ?? null,
    textPreview: typeof message?.mes === 'string' ? message.mes.slice(0, 600) : '',
    variables: message?.variables && typeof message.variables === 'object'
      ? Object.keys(message.variables).slice(0, 30)
      : []
  };
}

function summarizeArgs(args) {
  return args.slice(0, 4).map((value) => {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return { type: 'array', length: value.length };
    if (typeof value === 'object') return { type: 'object', keys: Object.keys(value).slice(0, 20) };
    return String(value);
  });
}

function readValue(target, keys) {
  for (const key of keys) {
    if (target && Object.prototype.hasOwnProperty.call(target, key)) return target[key];
  }
  return undefined;
}

function callMaybe(target, name) {
  try {
    return typeof target?.[name] === 'function' ? target[name]() : undefined;
  } catch {
    return undefined;
  }
}
`;
}

export function bridgeExtensionReadme(): string {
  return `# ST MCP Runtime Bridge Extension

Browser side of the runtime bridge. It captures a sanitized snapshot of the
current SillyTavern frontend state and publishes it to the matching server
plugin.
`;
}
