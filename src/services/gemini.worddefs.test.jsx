import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { reviewConversation } from './gemini.js';

// 模拟 DeepSeek 返回的「包裹在 choices[0].message.content 里的 JSON 字符串」。
function mockApiResponse(content, { ok = true, status = 200 } = {}) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve({ choices: [{ message: { content } }] }),
  })));
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('gemini.reviewConversation — wordDefs 容错 (T04/B01)', () => {
  const msgs = [{ role: 'user', text: 'I goes to school' }];

  it('无 API Key 直接返回 null（不抛）', async () => {
    expect(await reviewConversation('', 'sys', msgs)).toBeNull();
  });

  it('合法 JSON 且含 wordDefs → 原样透传该字段', async () => {
    const payload = JSON.stringify({
      summary: 'ok', summaryZh: '不错', score: 80,
      mistakes: [{ original: 'x', corrected: 'y', reason: 'r', reasonZh: 'z',
        wordDefs: [{ word: 'school', zh: '学校' }] }],
      newWords: ['a'], suggestions: ['b'],
    });
    mockApiResponse(payload);
    const r = await reviewConversation('key', 'sys', msgs);
    expect(r).not.toBeNull();
    expect(r.mistakes[0].wordDefs).toEqual([{ word: 'school', zh: '学校', phonetic: '' }]);
  });

  it('缺失 wordDefs → 规范化补 []（不抛、可降级）', async () => {
    const payload = JSON.stringify({
      summary: 'ok', score: 70,
      mistakes: [{ original: 'x', corrected: 'y', reason: 'r', reasonZh: 'z' }],
    });
    mockApiResponse(payload);
    const r = await reviewConversation('key', 'sys', msgs);
    expect(Array.isArray(r.mistakes[0].wordDefs)).toBe(true);
    expect(r.mistakes[0].wordDefs).toHaveLength(0);
  });

  it('wordDefs 含非法条目（缺 word/zh）→ 仅保留合法条目', async () => {
    const payload = JSON.stringify({
      summary: 'ok', score: 70,
      mistakes: [{ original: 'x', corrected: 'y', reason: 'r', reasonZh: 'z',
        wordDefs: [
          { word: 'go', zh: '去' },
          { word: 'bad' },            // 缺 zh
          { zh: '坏' },               // 缺 word
          'not-an-object',            // 非对象
          null,
        ] }],
    });
    mockApiResponse(payload);
    const r = await reviewConversation('key', 'sys', msgs);
    expect(r.mistakes[0].wordDefs).toEqual([{ word: 'go', zh: '去', phonetic: '' }]);
  });

  it('响应 content 不是合法 JSON → 返回 null（不抛）', async () => {
    mockApiResponse('这里不是 JSON {{{');
    expect(await reviewConversation('key', 'sys', msgs)).toBeNull();
  });

  it('HTTP 非 200 → 返回 null（不抛）', async () => {
    mockApiResponse('{}', { ok: false, status: 500 });
    expect(await reviewConversation('key', 'sys', msgs)).toBeNull();
  });

  it('fetch 抛异常 → 返回 null（不抛、不崩溃）', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network'))));
    expect(await reviewConversation('key', 'sys', msgs)).toBeNull();
  });
});
