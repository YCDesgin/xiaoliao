import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  parseCode,
  formatCode,
  SYNC_CODE_KEY,
  SYNC_PROXY_URL_KEY,
} from '../services/syncConfig';
import * as sync from '../services/syncService';
import { mergeReviews, normalizeReview } from '../services/reviewStore';

const HEX10 = '0123456789';
const HEX22 = 'abcdef0123456789abcdef'; // 22 hex chars (6 + 10 + 6)
const FULL = `${HEX10}.${HEX22}`;

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// --- parseCode / formatCode (整码契约) ---
describe('syncConfig.parseCode / formatCode (T01)', () => {
  it('round-trips a valid full code', () => {
    const full = formatCode(HEX10, HEX22);
    expect(full).toBe(FULL);
    const parsed = parseCode(full);
    expect(parsed).not.toBeNull();
    expect(parsed.syncId).toBe(HEX10);
    expect(parsed.token).toBe(HEX22);
    expect(parsed.full).toBe(FULL);
  });

  it('rejects malformed codes', () => {
    expect(parseCode('not-a-code')).toBeNull();
    expect(parseCode('123456789.abcdef0123456789abcdef0123')).toBeNull(); // syncId 9 hex
    expect(parseCode(`${HEX10}.short`)).toBeNull(); // token too short
    expect(parseCode('')).toBeNull();
    expect(parseCode(null)).toBeNull();
  });
});

// --- mergeMessages LWW ---
describe('syncService.mergeMessages LWW (T01)', () => {
  it('later timestamp wins for the same id', () => {
    const local = [{ id: '1', role: 'user', text: 'old', timestamp: new Date('2020-01-01') }];
    const cloud = [{ id: '1', role: 'user', text: 'new', timestamp: new Date('2021-01-01') }];
    const merged = sync.mergeMessages(local, cloud);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe('new');
  });

  it('keeps entries unique by id across both sides', () => {
    const local = [{ id: '1', text: 'a', timestamp: new Date('2020-01-01') }];
    const cloud = [{ id: '2', text: 'b', timestamp: new Date('2020-02-01') }];
    const merged = sync.mergeMessages(local, cloud);
    expect(merged.map((m) => m.id).sort()).toEqual(['1', '2']);
  });

  it('preserves local audioBlob (本地 audio 优先)', () => {
    const blob = new Blob(['x'], { type: 'audio/webm' });
    const local = [{ id: '1', text: 'a', audioBlob: blob, timestamp: new Date('2020-01-01') }];
    const cloud = [{ id: '1', text: 'a', timestamp: new Date('2021-01-01') }];
    const merged = sync.mergeMessages(local, cloud);
    expect(merged[0].audioBlob).toBe(blob);
  });
});

// --- mergeReviews LWW ---
describe('reviewStore.mergeReviews LWW (T01)', () => {
  it('merges local + cloud, later generatedAt wins by id', () => {
    const cid = 'rev-c1';
    const entry = (id, when, summary) => ({ id, generatedAt: when, fingerprint: 'fp', review: { summary } });
    localStorage.setItem(
      `speakup_reviews_${cid}`,
      JSON.stringify([entry('r1', '2020-01-01T00:00:00.000Z', 'old')]),
    );
    const cloud = [
      entry('r1', '2021-01-01T00:00:00.000Z', 'new'),
      entry('r2', '2021-01-02T00:00:00.000Z', 'b'),
    ];
    const merged = mergeReviews(cid, cloud);
    expect(merged.find((r) => r.id === 'r1').review.summary).toBe('new');
    expect(merged.find((r) => r.id === 'r2').review.summary).toBe('b');
  });
});

// --- normalizeReview (B01) ---
describe('reviewStore.normalizeReview (T04/B01)', () => {
  it('fills missing wordDefs with []', () => {
    const r = normalizeReview({ mistakes: [{ original: 'x', corrected: 'y' }] });
    expect(Array.isArray(r.mistakes[0].wordDefs)).toBe(true);
    expect(r.mistakes[0].wordDefs).toHaveLength(0);
  });
  it('keeps valid wordDefs', () => {
    const r = normalizeReview({ mistakes: [{ original: 'x', corrected: 'y', wordDefs: [{ word: 'y', zh: '你' }] }] });
    expect(r.mistakes[0].wordDefs).toEqual([{ word: 'y', zh: '你' }]);
  });
});

// --- schedulePush debounce ---
describe('syncService.schedulePush debounce (T01)', () => {
  it('only fires one push within the debounce window', async () => {
    vi.useFakeTimers();
    localStorage.setItem(SYNC_CODE_KEY, JSON.stringify({ syncId: HEX10, token: HEX22, full: FULL }));
    localStorage.setItem(SYNC_PROXY_URL_KEY, 'https://real.example.com/sync');
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }));
    vi.stubGlobal('fetch', fetchMock);

    sync.schedulePush('c1');
    sync.schedulePush('c1'); // 2nd within window should reset the timer
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('action=sync');
    expect(url).toContain('op=put');
    expect(url).toContain('contact=c1');
  });
});

// --- push / pull request structure ---
describe('syncService.pushContact / pullContact request structure (T01)', () => {
  it('pushContact POSTs to action=sync&op=put with ContactCloudData body', async () => {
    localStorage.setItem(SYNC_CODE_KEY, JSON.stringify({ syncId: HEX10, token: HEX22, full: FULL }));
    localStorage.setItem(SYNC_PROXY_URL_KEY, 'https://real.example.com/sync');
    localStorage.setItem('speakup_msgs_c1', JSON.stringify([
      { id: 'm1', role: 'user', text: 'hi', timestamp: '2020-01-01T00:00:00.000Z' },
    ]));
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }));
    vi.stubGlobal('fetch', fetchMock);

    await sync.pushContact('c1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('action=sync');
    expect(url).toContain('op=put');
    expect(url).toContain(`syncId=${HEX10}`);
    expect(url).toContain(`token=${HEX22}`);
    expect(url).toContain('contact=c1');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.v).toBe(1);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(Array.isArray(body.reviews)).toBe(true);
  });

  it('pullContact GETs action=sync&op=get and returns merged local messages', async () => {
    localStorage.setItem(SYNC_CODE_KEY, JSON.stringify({ syncId: HEX10, token: HEX22, full: FULL }));
    localStorage.setItem(SYNC_PROXY_URL_KEY, 'https://real.example.com/sync');
    localStorage.setItem('speakup_msgs_c1', JSON.stringify([
      { id: 'm1', role: 'user', text: 'local', timestamp: '2020-01-01T00:00:00.000Z' },
    ]));
    const fetchMock = vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        v: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        messages: [{ id: 'm2', role: 'them', text: 'cloud', timestamp: '2021-01-01T00:00:00.000Z' }],
        reviews: [],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await sync.pullContact('c1');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('action=sync');
    expect(url).toContain('op=get');
    expect(result.messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('pullContact treats 404 as empty cloud (no throw, no crash)', async () => {
    localStorage.setItem(SYNC_CODE_KEY, JSON.stringify({ syncId: HEX10, token: HEX22, full: FULL }));
    localStorage.setItem(SYNC_PROXY_URL_KEY, 'https://real.example.com/sync');
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await sync.pullContact('c1', []);
    expect(result.messages).toEqual([]);
    expect(result.changed).toBe(true);
  });
});
