/**
 * Unit tests for reviewStore.js — the persistence/cache layer.
 * Uses an in-memory localStorage mock so the module can run under Node.
 * Run with: node --test src/services/reviewStore.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- localStorage mock (in-memory) -----------------------------------------
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

// Import AFTER the mock is installed (module body does not touch localStorage,
// but this keeps the contract explicit).
const {
  fingerprintOf,
  getReviews,
  saveReview,
  findCached,
  getReviewById,
  clearReviews,
} = await import('./reviewStore.js');

test('fingerprintOf: joins message ids with "|"', () => {
  assert.equal(fingerprintOf([{ id: 'a' }, { id: 'b' }, { id: 'c' }]), 'a|b|c');
  assert.equal(fingerprintOf([]), '');
});

test('fingerprintOf: changes when a message id changes or is appended', () => {
  const base = [{ id: '1' }, { id: '2' }];
  const changed = [{ id: '1' }, { id: '3' }];
  const appended = [{ id: '1' }, { id: '2' }, { id: '3' }];
  assert.notEqual(fingerprintOf(base), fingerprintOf(changed));
  assert.notEqual(fingerprintOf(base), fingerprintOf(appended));
});

test('saveReview: returns a correctly shaped entry', () => {
  clearReviews('c1');
  const review = { score: 80, summary: 'A' };
  const e = saveReview('c1', review, 'fp-a');
  assert.equal(typeof e.id, 'string');
  assert.equal(typeof e.generatedAt, 'string');
  assert.equal(e.dayKey, e.generatedAt.slice(0, 10));
  assert.equal(e.fingerprint, 'fp-a');
  assert.equal(e.review, review); // original object retained on the entry
});

test('saveReview: persists and unshifts newest to the head', () => {
  clearReviews('c1');
  saveReview('c1', { summary: 'A' }, 'fp-a');
  const e2 = saveReview('c1', { summary: 'B' }, 'fp-b');
  const list = getReviews('c1');
  assert.equal(list.length, 2);
  assert.equal(list[0].fingerprint, 'fp-b', 'newest entry must be at head');
  assert.equal(list[1].fingerprint, 'fp-a');
  assert.equal(e2.fingerprint, 'fp-b');
});

test('saveReview: caps the list at 50 (drops oldest)', () => {
  clearReviews('c2');
  for (let i = 0; i < 55; i++) {
    saveReview('c2', { score: i, summary: String(i) }, 'fp-' + i);
  }
  const list = getReviews('c2');
  assert.equal(list.length, 50, 'must be capped at MAX_REVIEWS = 50');
  assert.equal(list[0].fingerprint, 'fp-54', 'head is the last saved');
  assert.equal(list[list.length - 1].fingerprint, 'fp-5', 'oldest (0..4) dropped');
});

test('findCached: returns first entry whose fingerprint matches', () => {
  clearReviews('c3');
  saveReview('c3', { summary: 'old' }, 'fp-x');
  saveReview('c3', { summary: 'new' }, 'fp-x'); // duplicate fingerprint
  const hit = findCached('c3', 'fp-x');
  assert.ok(hit, 'should find a cached entry');
  assert.equal(hit.fingerprint, 'fp-x');
  assert.equal(hit.review.summary, 'new', 'most recent (unshifted) match wins');
  assert.equal(findCached('c3', 'fp-missing'), null);
});

test('getReviewById: looks up by stored id', () => {
  clearReviews('c4');
  const e = saveReview('c4', { summary: 'z' }, 'fp-z');
  assert.equal(getReviewById('c4', e.id).review.summary, 'z');
  assert.equal(getReviewById('c4', 'nope'), null);
});

test('clearReviews: wipes the contact key', () => {
  saveReview('c5', { summary: 'q' }, 'fp-q');
  assert.equal(getReviews('c5').length, 1);
  clearReviews('c5');
  assert.deepEqual(getReviews('c5'), []);
});

test('getReviews: tolerates missing and corrupt storage', () => {
  assert.deepEqual(getReviews('never-seen'), []);
  globalThis.localStorage.setItem('speakup_reviews_corrupt', '{not valid json');
  assert.deepEqual(getReviews('corrupt'), []);
});
