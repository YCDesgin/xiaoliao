/**
 * messageStore.js
 * 聊天消息持久化层（localStorage 文本 + IndexedDB 音频二进制）。
 *
 * 从 App.jsx 抽出，供 syncService 在合并时做「原始读写」（不触碰音频二进制，
 * 因为语音只留本地、不同步 —— 设计 §1.1 Q1）。
 */

import { loadAudio, saveAudio, deleteAudio } from './audioStore';

const msgKey = (id) => `speakup_msgs_${id}`;

// 把一条消息转成「可序列化 slim」形态（剥离 audioBlob 二进制；时间戳统一 ISO）。
// metadata 承载功能1 的 wordDefs 缓存，随消息文本一起持久化（不新增独立 key）。
function toSlim(m) {
  return {
    id: m.id,
    role: m.role,
    text: m.text,
    type: m.type || undefined,
    imageUrl: m.imageUrl || undefined,
    query: m.query || undefined,
    timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
    isError: m.isError || undefined,
    metadata: m.metadata || undefined,
  };
}

/**
 * 加载消息：先读 localStorage 文本，再用 IndexedDB 回填 audioBlob。
 * @param {string} contactId
 * @returns {Promise<Array>} 含 audioBlob（可能为 null）的完整消息数组
 */
export async function loadMessages(contactId) {
  try {
    const raw = localStorage.getItem(msgKey(contactId));
    if (!raw) return [];
    const msgs = JSON.parse(raw);
    const restored = msgs.map((m) => ({ ...m, timestamp: new Date(m.timestamp) }));
    await Promise.all(restored.map(async (m) => {
      try {
        m.audioBlob = await loadAudio(m.id);
      } catch {
        m.audioBlob = null;
      }
    }));
    return restored;
  } catch {
    return [];
  }
}

/**
 * 保存消息：写入 slim 文本到 localStorage，并把 audioBlob 异步存到 IndexedDB。
 * @param {string} contactId
 * @param {Array} msgs
 */
export function saveMessages(contactId, msgs) {
  const slim = msgs.map(toSlim);
  localStorage.setItem(msgKey(contactId), JSON.stringify(slim));
  // 音频二进制存 IndexedDB（fire-and-forget，绝不阻塞文本保存）。
  for (const m of msgs) {
    if (m.audioBlob && m.audioBlob instanceof Blob) {
      saveAudio(m.id, m.audioBlob).catch(() => {});
    }
  }
}

/**
 * 清空消息：删除文本 + 删除对应音频二进制。
 * @param {string} contactId
 */
export function clearMessages(contactId) {
  try {
    const raw = localStorage.getItem(msgKey(contactId));
    if (raw) {
      const msgs = JSON.parse(raw);
      for (const m of msgs) {
        if (m && m.id) deleteAudio(m.id).catch(() => {});
      }
    }
  } catch {
    /* ignore parse errors */
  }
  localStorage.removeItem(msgKey(contactId));
}

/**
 * 原始读取（仅供同步合并使用）：只返回 localStorage 中的 slim 文本，不回填音频。
 * @param {string} contactId
 * @returns {Array}
 */
export function readRaw(contactId) {
  try {
    const raw = localStorage.getItem(msgKey(contactId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((m) => ({ ...m, timestamp: m.timestamp ? new Date(m.timestamp) : new Date() }));
  } catch {
    return [];
  }
}

/**
 * 原始写入（仅供同步合并使用）：把合并后的消息写回 localStorage（剥离 audioBlob）。
 * 不触碰 IndexedDB —— 本地音频仍按 message id 保留（设计 §7：本地 audioBlob 优先）。
 * @param {string} contactId
 * @param {Array} msgs
 */
export function writeRaw(contactId, msgs) {
  const slim = (Array.isArray(msgs) ? msgs : [])
    .filter((m) => m && m.id)
    .map(toSlim);
  localStorage.setItem(msgKey(contactId), JSON.stringify(slim));
}
