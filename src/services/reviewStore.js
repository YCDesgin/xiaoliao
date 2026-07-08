/**
 * reviewStore.js
 * Persistent storage layer for conversation reviews (localStorage backed).
 *
 * Each contact gets its own keyed array (`speakup_reviews_${contactId}`).
 * New entries are unshifted to the head (newest first) and the list is capped
 * at MAX_REVIEWS entries.
 */

const MAX_REVIEWS = 50;

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
