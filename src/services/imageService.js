/**
 * imageService.js
 * ---------------------------------------------------------------------------
 * Free image search powered by Wikimedia Commons (no API key required, CORS
 * enabled via `origin=*`). Used to automatically surface a real photo of a
 * noun the user says they don't understand ("我不明白 apple" -> apple photo).
 *
 * Design goals:
 *   - Never throw / never block the conversation. Any failure returns `null`.
 *   - Cheap in-memory cache so the same word is not fetched repeatedly.
 *   - Simple, dependency-free (just `fetch` + `AbortController`).
 * ---------------------------------------------------------------------------
 */

// query (lower-cased) -> resolved thumbnail url
const cache = new Map();

const ENDPOINT = 'https://commons.wikimedia.org/w/api.php';

/**
 * Search Wikimedia Commons for the first suitable image of `query`.
 * @param {string} query - the (already cleaned) search term.
 * @returns {Promise<string|null>} thumbnail url or null on any failure.
 */
export async function searchImage(query) {
  if (!query || !query.trim()) return null;

  const key = query.toLowerCase().trim();
  if (cache.has(key)) return cache.get(key);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000); // 5s hard timeout

  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrnamespace: '6', // File namespace
    gsrlimit: '6',
    prop: 'imageinfo',
    iiprop: 'url|mime|size',
    iiurlwidth: '400', // request a 400px thumbnail
    format: 'json',
    origin: '*', // enable CORS
  });

  try {
    const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const data = await res.json();
    const pages = data && data.query && data.query.pages;
    if (!pages) return null;

    // `pages` is an object keyed by pageid; iterate its values.
    const entries = Object.values(pages);
    for (const page of entries) {
      const info = page && page.imageinfo && page.imageinfo[0];
      if (info && typeof info.mime === 'string' && info.mime.startsWith('image/') && info.thumburl) {
        cache.set(key, info.thumburl);
        return info.thumburl;
      }
    }
    return null;
  } catch {
    // Network error, timeout (abort), or JSON parse failure -> silently ignore.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Clean a raw extracted query fragment into a search-friendly term.
 * Removes surrounding quotes, common leading filler ("the word ", "这个词"...)
 * and trailing punctuation.
 * @param {string} raw
 * @returns {string} cleaned query (may be empty).
 */
export function cleanQuery(raw) {
  if (!raw) return '';

  let q = raw.trim();

  // Strip surrounding quotes (straight + Chinese curly).
  q = q.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '');

  // Strip common leading filler phrases.
  const prefixes = ['the word', 'a word', 'an word', '这个词', '单词', '这个单词'];
  const lower = q.toLowerCase();
  for (const p of prefixes) {
    if (lower.startsWith(p)) {
      q = q.slice(p.length).trim();
      break;
    }
  }

  // Strip leading English articles.
  q = q.replace(/^(the|a|an)\s+/i, '').trim();

  // Collapse whitespace and drop trailing punctuation.
  q = q.replace(/\s+/g, ' ').replace(/[.,!?;:。，！？；：]+$/, '').trim();

  return q;
}
