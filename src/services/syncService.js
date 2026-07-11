/**
 * syncService.js
 * 同步码跨端同步核心：
 *   - 绑定 / 生成 / 解绑（纯客户端，生成不调 FC）
 *   - 拉取 / 上传 / 手动同步（原生 fetch 打到 getProxyUrl()）
 *   - LWW 合并（消息按 id+timestamp；复盘按 id+fingerprint+generatedAt）
 *   - 防抖上传（schedulePush，2s）
 *   - 状态广播（供 SyncStatus / useSyncStatus 订阅）
 *
 * 前端零新增运行时依赖；网络错误被隔离，绝不向上抛出导致页面崩溃。
 */

import {
  SYNC_CODE_KEY,
  DEBOUNCE_MS,
  SCHEMA_VERSION,
  ERROR_CODES,
  parseCode,
  getProxyUrl,
  isProxyConfigured,
} from './syncConfig';
import { readRaw, writeRaw } from './messageStore';
import { getReviews, mergeReviews } from './reviewStore';

/** 同步错误，携带与 FC HTTP 状态对齐的错误码。 */
export class SyncError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
  }
}

// --- 状态广播（供 SyncStatus / useSyncStatus 订阅）---------------------------------
const status = { state: 'idle', error: null, lastSyncAt: null };
const statusListeners = new Set();

function setStatus(state, error = null) {
  status.state = state;
  status.error = error;
  if (state === 'synced') status.lastSyncAt = Date.now();
  statusListeners.forEach((fn) => {
    try { fn(status); } catch { /* listener 异常不得影响同步流程 */ }
  });
}

export function getStatus() { return status; }

export function subscribe(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

// --- 同步码绑定 (A01) --------------------------------------------------------------
export function getBinding() {
  try {
    const raw = localStorage.getItem(SYNC_CODE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj && obj.syncId && obj.token) return obj;
  } catch {
    /* ignore */
  }
  return null;
}

export function isBound() { return !!getBinding(); }

// 生成随机 hex 串（优先 crypto.getRandomValues，降级 Math.random）
function randomHex(len) {
  const bytes = new Uint8Array(Math.ceil(len / 2));
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex.slice(0, len);
}

/** 生成新同步码（纯客户端，不调 FC），并立即绑定本地。 */
export function generateCode() {
  const syncId = randomHex(10);
  const token = randomHex(22);
  const full = `${syncId}.${token}`;
  const binding = { syncId, token, full };
  try {
    localStorage.setItem(SYNC_CODE_KEY, JSON.stringify(binding));
  } catch {
    /* ignore */
  }
  return binding;
}

/** 从整码绑定（解析失败返回 false）。 */
export function bindFromCode(full) {
  const parsed = parseCode(full);
  if (!parsed) return false;
  try {
    localStorage.setItem(
      SYNC_CODE_KEY,
      JSON.stringify({ syncId: parsed.syncId, token: parsed.token, full: parsed.full }),
    );
    return true;
  } catch {
    return false;
  }
}

/** 解绑（仅清本地，默认不删云端数据 —— 设计 §8.2）。 */
export function clearBinding() {
  try { localStorage.removeItem(SYNC_CODE_KEY); } catch { /* ignore */ }
  setStatus('idle');
}

// --- 构建请求 URL ----------------------------------------------------------------
function buildUrl(base, params) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

// --- 云端数据结构 (ContactCloudData) ----------------------------------------------
function buildCloudData(contactId) {
  const messages = readRaw(contactId).map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    type: m.type || undefined,
    imageUrl: m.imageUrl || undefined,
    query: m.query || undefined,
    timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
    isError: m.isError || undefined,
  }));
  return {
    v: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    messages,
    reviews: getReviews(contactId),
  };
}

// --- LWW 合并：消息（按 id + timestamp，本地 audioBlob 优先）----------------------
// 音频只存于本地 IndexedDB，绝不上云；即便云端文本更新胜出，也应保留本地 audioBlob。
export function mergeMessages(local, cloud) {
  const localArr = Array.isArray(local) ? local : [];
  const cloudArr = Array.isArray(cloud) ? cloud : [];

  // 以 id 为单位做 LWW；本地条目与云端条目分开打标，便于同时间戳时本地优先。
  const byId = new Map(); // id -> { entry, fromLocal }
  const ingest = (arr, fromLocal) => {
    arr.forEach((m) => {
      if (!m || !m.id) return;
      const prev = byId.get(m.id);
      const tNew = new Date(m.timestamp).getTime();
      if (!prev) {
        byId.set(m.id, { entry: { ...m }, fromLocal });
        return;
      }
      const tPrev = new Date(prev.entry.timestamp).getTime();
      // LWW：更新者胜；时间戳相同则本地优先（fromLocal 不能覆盖本地）
      const incomingWins = tNew > tPrev || (tNew === tPrev && !fromLocal);
      if (incomingWins) byId.set(m.id, { entry: { ...m }, fromLocal });
    });
  };
  ingest(localArr, true);
  ingest(cloudArr, false);

  // 本地音频对照表：把本地 audioBlob 按 id 归并，合并不应丢失本地语音。
  const localAudio = new Map();
  localArr.forEach((m) => {
    if (m && m.id && m.audioBlob) localAudio.set(m.id, m.audioBlob);
  });

  const result = [];
  for (const { entry } of byId.values()) {
    const out = { ...entry };
    // 音频不上云：若最终条目缺 audioBlob 但本地有，则补回本地音频。
    if (!out.audioBlob && localAudio.has(out.id)) {
      out.audioBlob = localAudio.get(out.id);
    }
    result.push(out);
  }
  result.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return result;
}

function handleErrorStatus(resStatus) {
  if (resStatus === 401) {
    const e = new SyncError(ERROR_CODES.UNAUTHORIZED, '同步码或令牌错误');
    setStatus('error', e.message);
    throw e;
  }
  if (resStatus === 404) {
    const e = new SyncError(ERROR_CODES.NOT_FOUND, '云端暂无该联系人数据');
    setStatus('error', e.message);
    throw e;
  }
  if (resStatus === 400) {
    const e = new SyncError(ERROR_CODES.BAD_REQUEST, '请求格式错误');
    setStatus('error', e.message);
    throw e;
  }
  const e = new SyncError(ERROR_CODES.SERVER, '同步服务异常');
  setStatus('error', e.message);
  throw e;
}

// --- 上传（push）-----------------------------------------------------------------
export async function pushContact(contactId) {
  if (!isBound()) throw new SyncError(ERROR_CODES.NOT_BOUND, '尚未绑定同步码');
  if (!isProxyConfigured()) throw new SyncError(ERROR_CODES.NOT_BOUND, '未配置同步代理地址');
  const binding = getBinding();
  setStatus('syncing');
  const url = buildUrl(getProxyUrl(), {
    action: 'sync', op: 'put', syncId: binding.syncId, token: binding.token, contact: contactId,
  });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCloudData(contactId)),
    });
    if (!res.ok) handleErrorStatus(res.status);
    setStatus('synced');
  } catch (err) {
    if (err instanceof SyncError) throw err;
    setStatus('error', '网络异常，同步失败');
    throw new SyncError(ERROR_CODES.NETWORK, '网络异常');
  }
}

// --- 拉取合并（pull）-------------------------------------------------------------
export async function pullContact(contactId, localMessages = null) {
  if (!isBound()) throw new SyncError(ERROR_CODES.NOT_BOUND, '尚未绑定同步码');
  if (!isProxyConfigured()) throw new SyncError(ERROR_CODES.NOT_BOUND, '未配置同步代理地址');
  const binding = getBinding();
  setStatus('syncing');
  const url = buildUrl(getProxyUrl(), {
    action: 'sync', op: 'get', syncId: binding.syncId, token: binding.token, contact: contactId,
  });
  let cloud = { messages: [], reviews: [] };
  try {
    const res = await fetch(url);
    if (res.status === 404) {
      // 命名空间或联系人不存在 → 视为空云端，仅保留本地
      cloud = { messages: [], reviews: [] };
    } else if (!res.ok) {
      handleErrorStatus(res.status);
    } else {
      const json = await res.json().catch(() => ({}));
      if (json && json.v && json.v > SCHEMA_VERSION) {
        setStatus('error', '同步数据版本不兼容');
        throw new SyncError(ERROR_CODES.SERVER, '同步数据版本不兼容');
      }
      cloud = {
        messages: Array.isArray(json.messages) ? json.messages : [],
        reviews: Array.isArray(json.reviews) ? json.reviews : [],
      };
    }
  } catch (err) {
    if (err instanceof SyncError) throw err;
    setStatus('error', '网络异常，同步失败');
    throw new SyncError(ERROR_CODES.NETWORK, '网络异常');
  }

  const local = localMessages || readRaw(contactId);
  const mergedMessages = mergeMessages(local, cloud.messages);
  writeRaw(contactId, mergedMessages);
  const mergedReviews = mergeReviews(contactId, cloud.reviews);
  setStatus('synced');
  return { messages: mergedMessages, reviews: mergedReviews, changed: true };
}

// --- 手动同步：先拉后推 -----------------------------------------------------------
export async function manualSync(contactId, localMessages = null) {
  if (!contactId) return;
  await pullContact(contactId, localMessages);
  await pushContact(contactId);
}

// --- 防抖上传 (A04) --------------------------------------------------------------
const pushTimers = new Map();

export function schedulePush(contactId) {
  if (!contactId) return;
  if (!isBound()) return;
  if (!isProxyConfigured()) return;
  if (pushTimers.has(contactId)) clearTimeout(pushTimers.get(contactId));
  pushTimers.set(contactId, setTimeout(() => {
    pushTimers.delete(contactId);
    // 隔离网络错误：防抖上传失败只更新状态，绝不向上抛出
    pushContact(contactId).catch(() => { /* 状态已由 setStatus('error') 反映 */ });
  }, DEBOUNCE_MS));
}
