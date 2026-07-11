/**
 * 阿里云 TTS 代理 — CosyVoice 相关函数单元测试（Node 原生 test runner）。
 *
 * 运行：在 aliyun-tts-proxy/ 目录执行 `node --test index.test.cjs`
 * 依赖：仅 Node 内置模块（node:test / node:assert / node:http）；ffmpeg-static 为惰性 require，
 *       本测试不涉及 ASR 转码，故无需安装 ffmpeg-static 即可运行。
 *
 * 覆盖（正确行为验收点）：
 *   - buildCosyVoicePayload：传入 cosyVoiceId 时必写 input.voice；语速倍率 clamp 到 [0.5, 2.0]；
 *     缺省 / 非法 speed → 1；
 *   - resolveCosyVoiceId：5 个发音人映射到内置默认英文音色（loong*）；未知 → 兜底 loongcally_v3；
 *     环境变量 COSYVOICE_VOICE_MAP 覆盖优先；
 *   - extractCosyVoiceAudio（async）：
 *       · 非流式 base64 字符串分支解析为 Buffer（兼容旧格式）；
 *       · 非流式 audio.url 对象分支：GET 该 http(s) url 取回真实 mp3 字节（关键）；
 *       · 流式 SSE 逐行 data: 拼接 → 正确 Buffer；
 *       · 失败码抛错；缺 audio 字段抛错；
 *   - TTS_PROVIDER 默认 'nls'（NLS 行为不变 / 兜底），模型为 cosyvoice-v3-flash，映射含 5 个发音人。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// index.js 使用 module.exports（CommonJS），require 即可（ffmpeg-static 惰性加载，不影响此处）。
// 本测试文件位于 aliyun-tts-proxy/ 目录内，故用同目录相对路径 ./index.js。
const proxy = require('./index.js');

test('buildCosyVoicePayload — 传入 cosyVoiceId 时必写 input.voice', () => {
  const p = proxy.buildCosyVoicePayload('hi', 'loongcally_v3', 0.8);
  assert.strictEqual(p.model, 'cosyvoice-v3-flash');
  assert.strictEqual(p.input.text, 'hi');
  // 修复后：handler 永远传入非空 id，故 voice 必须被写入（空 voice 会 418）。
  assert.strictEqual(p.input.voice, 'loongcally_v3');
  assert.strictEqual(p.parameters.format, 'mp3');
  assert.strictEqual(p.parameters.sample_rate, 16000);
  assert.strictEqual(p.parameters.rate, 0.8);
  assert.strictEqual(p.parameters.volume, 50);
});

test('buildCosyVoicePayload — 语速倍率 clamp 到 [0.5, 2.0]，缺省/非法 → 1', () => {
  assert.strictEqual(proxy.buildCosyVoicePayload('x', 'v', 5).parameters.rate, 2.0);
  assert.strictEqual(proxy.buildCosyVoicePayload('x', 'v', 0.1).parameters.rate, 0.5);
  // 缺省 / 非法 → 1
  assert.strictEqual(proxy.buildCosyVoicePayload('x', 'v', undefined).parameters.rate, 1);
  assert.strictEqual(proxy.buildCosyVoicePayload('x', 'v', null).parameters.rate, 1);
  assert.strictEqual(proxy.buildCosyVoicePayload('x', 'v', 'bad').parameters.rate, 1);
});

test('resolveCosyVoiceId — 内置默认英文音色映射（性别/口音对齐）', () => {
  assert.strictEqual(proxy.resolveCosyVoiceId('cally'), 'loongcally_v3');
  assert.strictEqual(proxy.resolveCosyVoiceId('abby'), 'loongabby_v3');
  assert.strictEqual(proxy.resolveCosyVoiceId('andy'), 'loongandy_v3');
  assert.strictEqual(proxy.resolveCosyVoiceId('harry'), 'loongluca_v3');
  assert.strictEqual(proxy.resolveCosyVoiceId('eric'), 'loongeric_v3');
});

test('resolveCosyVoiceId — 未知发音人兜底为非空 loongcally_v3（避免空 voice 触发 418）', () => {
  assert.strictEqual(proxy.resolveCosyVoiceId('未知发音人'), 'loongcally_v3');
  assert.strictEqual(proxy.resolveCosyVoiceId(''), 'loongcally_v3');
  assert.strictEqual(proxy.resolveCosyVoiceId('zzz'), 'loongcally_v3');
});

test('resolveCosyVoiceId — 环境变量 COSYVOICE_VOICE_MAP 覆盖优先', () => {
  const original = process.env.COSYVOICE_VOICE_MAP;
  process.env.COSYVOICE_VOICE_MAP = JSON.stringify({ cally: 'override_cally_xyz' });
  // 重新加载模块以应用环境变量（模块级 COSYVOICE_VOICE_MAP 在 require 时合并）。
  delete require.cache[require.resolve('./index.js')];
  const fresh = require('./index.js');
  try {
    // 覆盖值优先于内置默认
    assert.strictEqual(fresh.resolveCosyVoiceId('cally'), 'override_cally_xyz');
    // 未覆盖的发音人仍取内置默认
    assert.strictEqual(fresh.resolveCosyVoiceId('andy'), 'loongandy_v3');
    assert.strictEqual(fresh.resolveCosyVoiceId('eric'), 'loongeric_v3');
  } finally {
    if (original === undefined) delete process.env.COSYVOICE_VOICE_MAP;
    else process.env.COSYVOICE_VOICE_MAP = original;
    delete require.cache[require.resolve('./index.js')];
  }
});

test('extractCosyVoiceAudio — 非流式 base64 字符串分支解析为 Buffer（兼容旧格式）', async () => {
  const audioB64 = Buffer.from('ABC').toString('base64');
  const res = {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ output: { audio: audioB64 } })),
  };
  const buf = await proxy.extractCosyVoiceAudio(res);
  assert.ok(Buffer.isBuffer(buf));
  assert.strictEqual(buf.toString(), 'ABC');
});

test('extractCosyVoiceAudio — 非流式 audio.url 对象分支：GET http url 取回真实字节（关键）', async () => {
  const known = Buffer.from('ID3fake'); // 模拟 mp3 字节（含 ID3 头）
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.end(known);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/x.mp3`;
  try {
    const res = {
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify({ output: { audio: { data: '', url, id: 'audio_1' } } }),
      ),
    };
    const buf = await proxy.extractCosyVoiceAudio(res);
    assert.ok(Buffer.isBuffer(buf));
    // 验证它确实 GET 了 http url 并取回了字节
    assert.ok(buf.equals(known));
  } finally {
    // 测试结束必须关闭 http server，避免句柄泄漏
    server.close();
  }
});

test('extractCosyVoiceAudio — 流式 SSE 逐行 data: 拼接 audio', async () => {
  const a = Buffer.from('AA').toString('base64');
  const b = Buffer.from('BB').toString('base64');
  const sse =
    `data: ${JSON.stringify({ output: { audio: a } })}\n\n` +
    `data: ${JSON.stringify({ output: { audio: b } })}\n\n`;
  const res = { contentType: 'text/event-stream', body: Buffer.from(sse) };
  const buf = await proxy.extractCosyVoiceAudio(res);
  assert.strictEqual(buf.toString(), 'AABB');
});

test('extractCosyVoiceAudio — 失败码抛错', async () => {
  const res = {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ code: '40000', message: 'bad request' })),
  };
  await assert.rejects(() => proxy.extractCosyVoiceAudio(res), /合成失败/);
});

test('extractCosyVoiceAudio — 缺 audio 字段抛错', async () => {
  const res = {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ output: { code: '200' } })),
  };
  await assert.rejects(() => proxy.extractCosyVoiceAudio(res), /缺少 audio/);
});

test('TTS_PROVIDER 默认 nls（行为不变 / 兜底），CosyVoice 映射含 5 个发音人', () => {
  assert.strictEqual(proxy.__test.TTS_PROVIDER, 'nls');
  assert.strictEqual(proxy.__test.COSYVOICE_MODEL, 'cosyvoice-v3-flash');
  assert.deepStrictEqual(
    Object.keys(proxy.__test.COSYVOICE_VOICE_MAP),
    ['cally', 'abby', 'andy', 'harry', 'eric'],
  );
  // 新增：内置默认英文音色映射应包含 5 个发音人
  assert.deepStrictEqual(
    Object.keys(proxy.__test.COSYVOICE_DEFAULT_VOICE_MAP).sort(),
    ['abby', 'andy', 'cally', 'eric', 'harry'],
  );
  assert.strictEqual(proxy.__test.COSYVOICE_DEFAULT_VOICE_MAP.cally, 'loongcally_v3');
  assert.strictEqual(proxy.__test.COSYVOICE_DEFAULT_VOICE_MAP.eric, 'loongeric_v3');
});
