/**
 * Tests for chatWithAI({ withWordDefs }) + defineWords (架构 T02)。
 *
 * 覆盖：
 *   - chatWithAI 无 opts → 仍然返回纯文本字符串（旧调用 / 测试零影响）；
 *   - chatWithAI 带 withWordDefs → 返回 { text, wordDefs:[{word,zh,phonetic}] }；
 *   - 旧格式（无 phonetic）归一化为 phonetic: ''（容错）；
 *   - chatWithAI JSON 解析失败 → 回退 { text, wordDefs:[] }（不崩）；
 *   - defineWords 批量：合法数组归一化；缺 phonetic 补 ''；非法条目丢弃；失败返回 []。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chatWithAI, defineWords } from './gemini.js';

function mockApiResponse(content, { ok = true, status = 200 } = {}) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve({ choices: [{ message: { content } }] }),
  })));
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('chatWithAI — 向后兼容（无 opts 返回字符串）(T02)', () => {
  it('无 withWordDefs → 返回纯文本字符串', async () => {
    mockApiResponse('Hello, how can I help you?');
    const r = await chatWithAI('key', 'sys', [{ role: 'user', text: 'hi' }]);
    expect(typeof r).toBe('string');
    expect(r).toBe('Hello, how can I help you?');
  });
});

describe('chatWithAI — withWordDefs 返回结构 (T02)', () => {
  it('合法 JSON → 返回 { text, wordDefs }，phonetic 正确透传', async () => {
    mockApiResponse(JSON.stringify({
      reply: 'Nice to meet you!',
      wordDefs: [{ word: 'nice', zh: '很高兴', phonetic: '/naɪs/' }],
    }));
    const r = await chatWithAI('key', 'sys', [{ role: 'user', text: 'hi' }], { withWordDefs: true });
    expect(typeof r).toBe('object');
    expect(r.text).toBe('Nice to meet you!');
    expect(r.wordDefs).toEqual([{ word: 'nice', zh: '很高兴', phonetic: '/naɪs/' }]);
  });

  it('旧格式（无 phonetic）→ 归一化为 phonetic: ""', async () => {
    mockApiResponse(JSON.stringify({
      reply: 'See you!',
      wordDefs: [{ word: 'see', zh: '看见' }],
    }));
    const r = await chatWithAI('key', 'sys', [{ role: 'user', text: 'hi' }], { withWordDefs: true });
    expect(r.text).toBe('See you!');
    expect(r.wordDefs).toEqual([{ word: 'see', zh: '看见', phonetic: '' }]);
  });

  it('JSON 解析失败 → 回退为 { text: 原文, wordDefs: [] }（不抛）', async () => {
    mockApiResponse('这是一段普通回复，没有 JSON 结构');
    const r = await chatWithAI('key', 'sys', [{ role: 'user', text: 'hi' }], { withWordDefs: true });
    expect(r.text).toBe('这是一段普通回复，没有 JSON 结构');
    expect(r.wordDefs).toEqual([]);
  });

  it('HTTP 非 200 → 抛错（与旧行为一致，由调用方 catch）', async () => {
    mockApiResponse('{}', { ok: false, status: 500 });
    await expect(
      chatWithAI('key', 'sys', [{ role: 'user', text: 'hi' }], { withWordDefs: true }),
    ).rejects.toThrow();
  });
});

describe('defineWords — 批量查词 (T02)', () => {
  it('合法数组 → 归一化为 [{word,zh,phonetic}]', async () => {
    mockApiResponse(JSON.stringify([
      { word: 'garden', zh: '花园', phonetic: '/ˈɡɑːrdn/' },
      { word: 'yesterday', zh: '昨天', phonetic: '/ˈjestədeɪ/' },
    ]));
    const r = await defineWords('key', 'I went to the garden yesterday');
    expect(r).toEqual([
      { word: 'garden', zh: '花园', phonetic: '/ˈɡɑːrdn/' },
      { word: 'yesterday', zh: '昨天', phonetic: '/ˈjestədeɪ/' },
    ]);
  });

  it('缺 phonetic → 补 ""；非法条目（缺 word/zh）→ 丢弃', async () => {
    mockApiResponse(JSON.stringify([
      { word: 'hello', zh: '你好' },
      { word: 'bad' },
      { zh: '坏' },
      'not-object',
    ]));
    const r = await defineWords('key', 'hello');
    expect(r).toEqual([{ word: 'hello', zh: '你好', phonetic: '' }]);
  });

  it('fetch 失败 / HTTP 错误 → 返回 []（容错）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    const r = await defineWords('key', 'hello');
    expect(r).toEqual([]);
  });

  it('空文本 → 直接返回 []（不打 API）', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await defineWords('key', '   ');
    expect(r).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
