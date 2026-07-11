/**
 * 阿里云 TTS 代理 — CosyVoice 相关函数单元测试（Node 原生 test runner）。
 *
 * 运行：在 aliyun-tts-proxy/ 目录执行 `node --test index.test.cjs`
 * 依赖：仅 Node 内置模块（node:test / node:assert）；ffmpeg-static 为惰性 require，
 *       本测试不涉及 ASR 转码，故无需安装 ffmpeg-static 即可运行。
 *
 * 覆盖（架构 T9 验收点）：
 *   - buildCosyVoicePayload：请求体结构正确；cosyVoiceId 缺失省略 voice（回退默认音色）；
 *     语速倍率 clamp 到 [0.5, 2.0]；
 *   - extractCosyVoiceAudio：非流式 JSON（output.audio）与流式 SSE 两种返回均能解析为 Buffer；
 *     失败码抛错；
 *   - TTS_PROVIDER 默认 'nls'（NLS 行为不变 / 兜底）。
 */

const test = require('node:test');
const assert = require('node:assert');

// index.js 使用 module.exports（CommonJS），require 即可（ffmpeg-static 惰性加载，不影响此处）。
// 本测试文件位于 aliyun-tts-proxy/ 目录内，故用同目录相对路径 ./index.js。
const proxy = require('./index.js');

test('buildCosyVoicePayload — 结构正确，缺失 cosyVoiceId 省略 voice（回退默认音色）', () => {
  const p = proxy.buildCosyVoicePayload('hello world', '', 1, 'cosyvoice-v3-flash');
  assert.strictEqual(p.model, 'cosyvoice-v3-flash');
  assert.strictEqual(p.input.text, 'hello world');
  // 占位未填 → 省略 voice，交由模型使用默认音色（设计 §3 / §7 映射缺失回退默认）
  assert.strictEqual(p.input.voice, undefined);
  assert.strictEqual(p.parameters.format, 'mp3');
  assert.strictEqual(p.parameters.sample_rate, 16000);
  assert.strictEqual(p.parameters.rate, 1);
  assert.strictEqual(p.parameters.volume, 50);
});

test('buildCosyVoicePayload — 提供 cosyVoiceId 时写入 input.voice', () => {
  const p = proxy.buildCosyVoicePayload('hi', 'cv-abc-123', 0.8);
  assert.strictEqual(p.input.voice, 'cv-abc-123');
  assert.strictEqual(p.parameters.rate, 0.8);
});

test('buildCosyVoicePayload — 语速倍率 clamp 到 [0.5, 2.0]', () => {
  assert.strictEqual(proxy.buildCosyVoicePayload('x', '', 5).parameters.rate, 2.0);
  assert.strictEqual(proxy.buildCosyVoicePayload('x', '', 0.1).parameters.rate, 0.5);
  // 缺省 / 非法 → 1
  assert.strictEqual(proxy.buildCosyVoicePayload('x', '', undefined).parameters.rate, 1);
});

test('extractCosyVoiceAudio — 非流式 JSON（output.audio base64）解析为 Buffer', () => {
  const audioB64 = Buffer.from('ABC').toString('base64');
  const res = {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ output: { audio: audioB64 } })),
  };
  const buf = proxy.extractCosyVoiceAudio(res);
  assert.ok(Buffer.isBuffer(buf));
  assert.strictEqual(buf.toString(), 'ABC');
});

test('extractCosyVoiceAudio — 流式 SSE 逐行 data: 拼接 audio', () => {
  const a = Buffer.from('AA').toString('base64');
  const b = Buffer.from('BB').toString('base64');
  const sse =
    `data: ${JSON.stringify({ output: { audio: a } })}\n\n` +
    `data: ${JSON.stringify({ output: { audio: b } })}\n\n`;
  const res = { contentType: 'text/event-stream', body: Buffer.from(sse) };
  const buf = proxy.extractCosyVoiceAudio(res);
  assert.strictEqual(buf.toString(), 'AABB');
});

test('extractCosyVoiceAudio — 失败码抛错', () => {
  const res = {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ code: '40000', message: 'bad request' })),
  };
  assert.throws(() => proxy.extractCosyVoiceAudio(res), /合成失败/);
});

test('extractCosyVoiceAudio — 非流式但缺 audio 字段抛错', () => {
  const res = {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ output: { code: '200' } })),
  };
  assert.throws(() => proxy.extractCosyVoiceAudio(res), /缺少 audio/);
});

test('TTS_PROVIDER 默认 nls（行为不变 / 兜底），CosyVoice 映射含 5 个发音人', () => {
  assert.strictEqual(proxy.__test.TTS_PROVIDER, 'nls');
  assert.strictEqual(proxy.__test.COSYVOICE_MODEL, 'cosyvoice-v3-flash');
  assert.deepStrictEqual(
    Object.keys(proxy.__test.COSYVOICE_VOICE_MAP),
    ['cally', 'abby', 'andy', 'harry', 'eric'],
  );
  // 初值占位均为 ''（用户尚未在百炼取真实 id）
  Object.values(proxy.__test.COSYVOICE_VOICE_MAP).forEach((v) => assert.strictEqual(v, ''));
});
