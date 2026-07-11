/**
 * reviewStore.js
 * Persistent storage layer for conversation reviews (localStorage backed).
 *
 * Each contact gets its own keyed array (`speakup_reviews_${contactId}`).
 * New entries are unshifted to the head (newest first) and the list is capped
 * at MAX_REVIEWS entries.
 */

const MAX_REVIEWS = 50;

// 复盘保存后的通知监听（供同步服务在保存时触发防抖上传）。
let reviewSavedListener = null;

/**
 * 注册「复盘已保存」监听器。saveReview 成功后会回调 listener(contactId)，
 * 让同步服务把新复盘推到云端（A04）。传入 null 可取消。
 * @param {function(string):void|null} fn
 */
export function setReviewSavedListener(fn) {
  if (typeof fn === 'function') reviewSavedListener = fn;
  else reviewSavedListener = null;
}

/** Build the localStorage key for a given contact. */
function storageKey(contactId) {
  return `speakup_reviews_${contactId}`;
}

/**
 * Compute a stable fingerprint for a list of messages.
 * Using message ids means adding/removing/editing a message changes the
 * fingerprint, which is exactly what we want to detect "conversation changed".
 * @param {Array<{id: string}>} messages
 * @returns {string}
 */
export function fingerprintOf(messages) {
  return messages.map(m => m.id).join('|');
}

/**
 * Read all stored reviews for a contact.
 * @param {string} contactId
 * @returns {Array} The reviews array, or [] on missing/corrupt data.
 */
export function getReviews(contactId) {
  try {
    const raw = localStorage.getItem(storageKey(contactId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * Persist a freshly generated review as a new history entry.
 * @param {string} contactId
 * @param {object} review - The structured review object.
 * @param {string} fingerprint - Fingerprint of the conversation it was built from.
 * @returns {object} The stored entry (with id / generatedAt / dayKey / fingerprint / review).
 */
export function saveReview(contactId, review, fingerprint) {
  const generatedAt = new Date().toISOString();
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    generatedAt,
    dayKey: generatedAt.slice(0, 10),
    fingerprint,
    review,
  };
  const list = getReviews(contactId);
  list.unshift(entry);
  const trimmed = list.slice(0, MAX_REVIEWS);
  localStorage.setItem(storageKey(contactId), JSON.stringify(trimmed));
  if (reviewSavedListener) {
    try { reviewSavedListener(contactId); } catch { /* 监听器异常不得影响保存 */ }
  }
  return entry;
}

/**
 * Find a cached review for the exact same conversation (fingerprint match).
 * Because entries are unshifted, the first match is the most recent one.
 * @param {string} contactId
 * @param {string} fingerprint
 * @returns {object|null}
 */
export function findCached(contactId, fingerprint) {
  const list = getReviews(contactId);
  return list.find(r => r.fingerprint === fingerprint) || null;
}

/**
 * Look up a single review entry by its id.
 * @param {string} contactId
 * @param {string} id
 * @returns {object|null}
 */
export function getReviewById(contactId, id) {
  const list = getReviews(contactId);
  return list.find(r => r.id === id) || null;
}

/**
 * Wipe all stored reviews for a contact.
 * @param {string} contactId
 */
export function clearReviews(contactId) {
  try {
    localStorage.removeItem(storageKey(contactId));
  } catch {
    /* ignore quota / unavailable storage errors */
  }
}

/**
 * 合并云端复盘到本地（LWW）：按 id（及 fingerprint 兜底）去重，
 * generatedAt 后者胜。结果写回 localStorage 并裁剪到 MAX_REVIEWS。
 * @param {string} contactId
 * @param {Array} cloudReviews 云端复盘条目数组
 * @returns {Array} 合并后的本地条目数组
 */
export function mergeReviews(contactId, cloudReviews) {
  const local = getReviews(contactId);
  const byKey = new Map();
  const keyOf = (e) => e && (e.id || e.fingerprint || `${e.generatedAt}:${JSON.stringify(e.review && e.review.summary)}`);
  const push = (e) => {
    const k = keyOf(e);
    if (!k) return;
    const existing = byKey.get(k);
    if (!existing) { byKey.set(k, e); return; }
    if (new Date(e.generatedAt).getTime() > new Date(existing.generatedAt).getTime()) {
      byKey.set(k, e);
    }
  };
  local.forEach(push);
  (Array.isArray(cloudReviews) ? cloudReviews : []).forEach(push);
  const merged = Array.from(byKey.values())
    .sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt))
    .slice(0, MAX_REVIEWS);
  try {
    localStorage.setItem(storageKey(contactId), JSON.stringify(merged));
  } catch {
    /* ignore quota errors */
  }
  return merged;
}

/**
 * 规范化一条 Review，保证每个 mistake 都有 wordDefs 数组（旧数据缺失补 []），
 * 兼容 B01 字段（设计 §3.2 / §7）。绝不抛错。
 * @param {object} review
 * @returns {object}
 */
export function normalizeReview(review) {
  if (!review || typeof review !== 'object') return { mistakes: [] };
  const mistakes = Array.isArray(review.mistakes)
    ? review.mistakes.map((m) => ({
        ...m,
        wordDefs: Array.isArray(m.wordDefs)
          ? m.wordDefs.filter((d) => d && typeof d.word === 'string' && typeof d.zh === 'string')
          : [],
      }))
    : [];
  return { ...review, mistakes };
}
