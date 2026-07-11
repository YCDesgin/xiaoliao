import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

// --- 手动桩：ali-oss 在沙箱未安装，node_modules/ali-oss 为内存版 FakeOSS ---
// 该桩用内存 Map 模拟 OSS；真实 sha256 由 FC handler 走 Node crypto 计算，
// 因此本测试可验证契约里的 tokenHash = sha256(token) 逻辑。
// 桩通过 globalThis.__aliOssStore 暴露共享 Map，测试与 handler 指向同一实例。
import 'ali-oss';
const store = globalThis.__aliOssStore;

import { handler } from '../../aliyun-sync-proxy/index.js';

beforeEach(() => {
  store.clear();
  vi.restoreAllMocks();
});

// 调用 FC handler（callback 风格），返回 HTTP 响应对象。
function callFc({ method = 'GET', query = {}, body = null, isBase64Encoded = false } = {}) {
  return new Promise((resolve) => {
    const event = { httpMethod: method, queryString: query };
    if (body !== null) {
      event.body = typeof body === 'string' ? body : JSON.stringify(body);
      event.isBase64Encoded = isBase64Encoded;
    }
    handler(event, {}, (err, res) => resolve(res));
  });
}

const SID = 'abcdef1234';
const TOK = '1122334455667788990011223344556677889900';
const tokHash = createHash('sha256').update(TOK).digest('hex');
const OTHER_TOK = 'aabbccddeeff0011223344556677889900aabbccddee';

describe('aliyun-sync-proxy 契约 (T03/A02/A05)', () => {
  it('CORS 响应头为 *', async () => {
    const res = await callFc({ query: { action: 'other' } });
    expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
  });

  it('未知 action → 400 bad_request', async () => {
    const res = await callFc({ query: { action: 'nope' } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('bad_request');
  });

  it('缺少 syncId/token → 400', async () => {
    const res = await callFc({ query: { action: 'sync', op: 'list' } });
    expect(res.statusCode).toBe(400);
  });

  it('op=put 首次写入惰性创建 .meta.json 并存储联系人数据 → 200 ok', async () => {
    const res = await callFc({
      method: 'POST',
      query: { action: 'sync', op: 'put', syncId: SID, token: TOK, contact: 'alex' },
      body: { v: 1, updatedAt: '2026-01-01T00:00:00.000Z', messages: [{ id: 'm1' }], reviews: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    // .meta.json 已被创建且 tokenHash 正确
    expect(store.has(`${SID}/.meta.json`)).toBe(true);
    const meta = JSON.parse(store.get(`${SID}/.meta.json`).toString());
    expect(meta.tokenHash).toBe(tokHash);
    // 联系人对象已落盘
    expect(store.has(`${SID}/alex.json`)).toBe(true);
  });

  it('op=get 命名空间不存在 → 404 not_found', async () => {
    const res = await callFc({ query: { action: 'sync', op: 'get', syncId: SID, token: TOK, contact: 'alex' } });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('not_found');
  });

  it('op=get 令牌错误 → 401 unauthorized', async () => {
    // 先用正确 token 建命名空间
    await callFc({ method: 'POST', query: { action: 'sync', op: 'put', syncId: SID, token: TOK, contact: 'alex' },
      body: { v: 1, messages: [], reviews: [] } });
    // 再用错误 token 读取
    const res = await callFc({ query: { action: 'sync', op: 'get', syncId: SID, token: OTHER_TOK, contact: 'alex' } });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('unauthorized');
  });

  it('op=get 令牌正确且联系人存在 → 200 返回数据', async () => {
    await callFc({ method: 'POST', query: { action: 'sync', op: 'put', syncId: SID, token: TOK, contact: 'alex' },
      body: { v: 1, updatedAt: '2026-01-01T00:00:00.000Z', messages: [{ id: 'm1', text: 'hi' }], reviews: [] } });
    const res = await callFc({ query: { action: 'sync', op: 'get', syncId: SID, token: TOK, contact: 'alex' } });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.messages[0].id).toBe('m1');
  });

  it('op=get 令牌正确但联系人不存在 → 404', async () => {
    await callFc({ method: 'POST', query: { action: 'sync', op: 'put', syncId: SID, token: TOK, contact: 'alex' },
      body: { v: 1, messages: [], reviews: [] } });
    const res = await callFc({ query: { action: 'sync', op: 'get', syncId: SID, token: TOK, contact: 'ghost' } });
    expect(res.statusCode).toBe(404);
  });

  it('op=list 返回已同步联系人（排除 .meta.json）', async () => {
    await callFc({ method: 'POST', query: { action: 'sync', op: 'put', syncId: SID, token: TOK, contact: 'alex' },
      body: { v: 1, messages: [], reviews: [] } });
    await callFc({ method: 'POST', query: { action: 'sync', op: 'put', syncId: SID, token: TOK, contact: 'sam' },
      body: { v: 1, messages: [], reviews: [] } });
    const res = await callFc({ query: { action: 'sync', op: 'list', syncId: SID, token: TOK } });
    expect(res.statusCode).toBe(200);
    const contacts = JSON.parse(res.body).contacts;
    expect(contacts.sort()).toEqual(['alex', 'sam']);
  });

  it('op=put body 非法 JSON → 400 bad_request', async () => {
    const res = await callFc({
      method: 'POST',
      query: { action: 'sync', op: 'put', syncId: SID, token: TOK, contact: 'alex' },
      body: 'this is not json {{{',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('bad_request');
  });
});
