// 虾聊 (XiaLiao) — 阿里云语音合成代理 (Aliyun TTS Proxy)
// 零依赖：仅使用 Node.js 内置模块 (https / crypto / url)，可直接粘贴到阿里云
// 函数计算 (FC) 控制台，无需 npm install。
//
// 作用：作为虾聊的"云端语音"代理，同时提供 TTS（语音合成）与 ASR（语音识别）：
//   GET  /?text=xxx&voice=cally&rate=-25%   返回 audio/mpeg 二进制（TTS 语音合成）
//   GET  /?action=voices                    返回可用英文发音人列表 (JSON)
//   POST /?action=asr  (body=wav 16k mono)  返回 { result: "识别出的文本" }（ASR 语音识别）
//
// 部署后，把 FC 触发器的 URL 填到虾聊「设置 → 云端 TTS 地址」即可。
// 国内的函数计算域名可直连，华为手机也能听到自然英文发音、并发起语音输入
// （华为无 GMS，浏览器原生 SpeechRecognition 不可用，故识别也走云端）。

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URLSearchParams } = require('url');
const { spawn } = require('child_process');
const fs = require('fs');
// ffmpeg-static 自带预编译二进制：FC Node.js 运行时安装依赖后可直接 require 拿到二进制路径，
// 无需系统 apt / 额外安装。用于把前端上传的 opus/webm 音频转码成 NLS 要求的 16k/16bit/mono WAV。
// 注意：改为「惰性 require」，只在真正用到 ASR 转码时才加载，避免 ffmpeg-static 缺失时
// 连 TTS/CosyVoice 冷启动都失败（也便于无依赖环境下单元测试 CosyVoice 相关函数）。

const REGION = process.env.ALIYUN_REGION || 'cn-shanghai';
const APPKEY = process.env.ALIYUN_APPKEY || '';
const AK_ID = process.env.ALIYUN_ACCESS_KEY_ID || '';
const AK_SECRET = process.env.ALIYUN_ACCESS_KEY_SECRET || '';
// 默认发音人：cally = 美式英文女声，专为英语口语对话设计
const DEFAULT_VOICE = process.env.DEFAULT_VOICE || 'cally';

// 阿里云 NLS 可用英文发音人（仅这些名称会直接采用，其余回退 DEFAULT_VOICE）
const KNOWN_EN_VOICES = ['cally', 'abby', 'andy', 'harry', 'eric', 'broadcast_female', 'broadcast_male'];

// 播音腔音色：强制走 NLS 老风格，即使全局 TTS_PROVIDER=cosyvoice 也不走 CosyVoice。
const BROADCAST_VOICES = ['broadcast_female', 'broadcast_male'];
// 播音腔 → 实际 NLS 英文发音人（NLS 直接用阿里云发音人名作 voice 参数，见 synthesizeChunk 的 q.set('voice', voice)）。
const NLS_VOICE_ALIAS = { broadcast_female: 'cally', broadcast_male: 'andy' };

// --- CosyVoice（百炼）配置（功能2：更逼真的 TTS）---
// 默认仍走 NLS（兜底/生产）；设置 TTS_PROVIDER=cosyvoice 后切换到百炼 CosyVoice。
// 前端只传阿里云发音人名（cally/abby/...），真正的 CosyVoice 音色 id 在此映射。
const TTS_PROVIDER = (process.env.TTS_PROVIDER || 'nls').toLowerCase();
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';
const COSYVOICE_MODEL = process.env.COSYVOICE_MODEL || 'cosyvoice-v3-flash';
// 与前端 src/data/voices.js 的 cosyVoiceId 保持一致；初值占位 ''，由用户在百炼试听后填真实 id。
// 也可通过环境变量 COSYVOICE_VOICE_MAP（JSON 字符串）整体覆盖，例如：
//   {"cally":"<id>","abby":"<id>","andy":"<id>","harry":"<id>","eric":"<id>"}
// （环境变量的覆盖会在下方加载时合并进 COSYVOICE_VOICE_MAP，resolveCosyVoiceId 直接查表即可。）
let COSYVOICE_VOICE_MAP = { cally: '', abby: '', andy: '', harry: '', eric: '' };
try {
  if (process.env.COSYVOICE_VOICE_MAP) {
    const parsed = JSON.parse(process.env.COSYVOICE_VOICE_MAP);
    if (parsed && typeof parsed === 'object') {
      COSYVOICE_VOICE_MAP = { ...COSYVOICE_VOICE_MAP, ...parsed };
    }
  }
} catch (e) {
  // 环境变量非合法 JSON：沿用代码内占位，不阻断启动。
  console.error('[CosyVoice] COSYVOICE_VOICE_MAP 解析失败，沿用代码内占位:', e && e.message);
}

// CosyVoice v3 纯英文音色默认值（官方出海营销系列，性别/口音对齐）。
// 兜底：即便 COSYVOICE_VOICE_MAP 未配置真实 id，也保证请求体始终带非空 voice（空 voice 会 418）。
const COSYVOICE_DEFAULT_VOICE_MAP = {
  cally: 'loongcally_v3', // 美式女声
  abby:  'loongabby_v3', // 美式女声
  andy:  'loongandy_v3', // 美式男声
  harry: 'loongluca_v3', // 英式男声
  eric:  'loongeric_v3', // 英式男声
};

/**
 * 解析发音人对应的 CosyVoice 音色 id。
 * 优先级：合并后的 COSYVOICE_VOICE_MAP（含环境变量覆盖） > 内置默认英文音色 > 兜底 loongcally_v3。
 * 保证始终返回非空 id，使请求体必带 voice 字段，避免空 voice 触发的 418。
 * @param {string} voice 阿里云发音人名（cally/abby/andy/harry/eric）
 * @returns {string} 非空 CosyVoice 音色 id
 */
function resolveCosyVoiceId(voice) {
  return COSYVOICE_VOICE_MAP[voice] || COSYVOICE_DEFAULT_VOICE_MAP[voice] || 'loongcally_v3';
}

const DASHSCOPE_TTS_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';

const META_HOST = `nls-meta.${REGION}.aliyuncs.com`;
const GATEWAY_HOST = `nls-gateway.${REGION}.aliyuncs.com`;
const GATEWAY_PATH = '/stream/v1/tts';

// --- RFC3986 编码（与阿里云签名要求一致：空格→%20，保留 -_.~，其余百分号编码）---
function enc(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// --- 通用 HTTPS GET，返回 { status, contentType, body(Buffer) } ---
function httpsGet(urlStr, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlStr, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          body: Buffer.concat(chunks),
        })
      );
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
  });
}

// --- 协议感知的音频下载（OSS 预签名地址可能为 http:// 或 https://）---
// 注意：原有的 httpsGet 只支持 https，不要复用它拉取 OSS 音频地址。
function fetchUrl(urlStr, timeoutMs = 20000) {
  const mod = urlStr.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(urlStr, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('下载音频超时')));
  });
}

// --- 获取并缓存 Token（有效期约 1 天，提前 5 分钟刷新）---
let cachedToken = null;
let tokenExpire = 0;

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && tokenExpire > now + 300) return cachedToken;

  const params = {
    AccessKeyId: AK_ID,
    Action: 'CreateToken',
    Format: 'JSON',
    RegionId: REGION,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2019-02-28',
  };
  const sortedKeys = Object.keys(params).sort();
  const canonical = sortedKeys.map((k) => `${enc(k)}=${enc(params[k])}`).join('&');
  const stringToSign = `GET&${enc('/')}&${enc(canonical)}`;
  const signature = crypto.createHmac('sha1', AK_SECRET + '&').update(stringToSign).digest('base64');
  const url = `https://${META_HOST}/?${canonical}&Signature=${enc(signature)}`;

  const res = await httpsGet(url, 15000);
  if (res.status !== 200) throw new Error(`CreateToken HTTP ${res.status}`);
  let data;
  try {
    data = JSON.parse(res.body.toString('utf8'));
  } catch (e) {
    throw new Error('Token 响应解析失败');
  }
  if (!data.Token || !data.Token.Id) {
    throw new Error('Token 为空：请检查 AccessKey / AppKey 与 NLS 权限');
  }
  cachedToken = data.Token.Id;
  tokenExpire = data.Token.ExpireTime || 0;
  return cachedToken;
}

// --- 合成单段文本（≤300 字符）为 mp3 Buffer ---
async function synthesizeChunk(text, voice, speechRate) {
  const token = await getToken();
  const q = new URLSearchParams();
  q.set('appkey', APPKEY);
  q.set('token', token);
  q.set('text', text);
  q.set('format', 'mp3');
  q.set('sample_rate', '16000');
  q.set('voice', voice);
  q.set('volume', '50');
  q.set('speech_rate', String(Math.round(speechRate)));

  const url = `https://${GATEWAY_HOST}${GATEWAY_PATH}?${q.toString()}`;
  const res = await httpsGet(url, 25000);

  if (res.contentType.includes('audio/mpeg')) return res.body;

  // 失败：尝试解析 JSON 错误信息
  let msg = 'TTS 合成失败';
  try {
    const j = JSON.parse(res.body.toString('utf8'));
    msg = j.message || msg;
  } catch (e) {
    /* ignore */
  }
  throw new Error(msg);
}

// --- 通用 HTTPS POST（发送二进制 body，用于 ASR 音频上传）---
function httpsPostBuffer(urlStr, bodyBuffer, contentType, timeoutMs = 30000, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      urlStr,
      {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Content-Length': bodyBuffer.length,
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            contentType: res.headers['content-type'] || '',
            body: Buffer.concat(chunks),
          })
        );
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.write(bodyBuffer);
    req.end();
  });
}

// --- 确保 ffmpeg 二进制可执行（FC 从 Windows 打包的 zip 解压后可能丢失 +x 权限）---
let resolvedFfmpegPath = null;
function ensureFfmpegBinary() {
  if (resolvedFfmpegPath) return resolvedFfmpegPath;
  const rawPath = require('ffmpeg-static');
  // 1) 已具备执行权限：直接用
  try {
    fs.accessSync(rawPath, fs.constants.X_OK);
    resolvedFfmpegPath = rawPath;
    return rawPath;
  } catch {}
  // 2) 原地 chmod +x（/code 可写时生效）
  try {
    fs.chmodSync(rawPath, 0o755);
    fs.accessSync(rawPath, fs.constants.X_OK);
    resolvedFfmpegPath = rawPath;
    return rawPath;
  } catch {}
  // 3) /code 只读：复制到「可写且可执行」的候选目录再 chmod +x。
  //    FC 不同实例挂载策略不同（部分实例 /tmp 为 noexec），故依次尝试多个目录。
  for (const dir of ['/tmp', '/home']) {
    try {
      const tmpPath = dir + '/ffmpeg-' + crypto.randomBytes(4).toString('hex');
      fs.copyFileSync(rawPath, tmpPath);
      fs.chmodSync(tmpPath, 0o755);
      fs.accessSync(tmpPath, fs.constants.X_OK);
      resolvedFfmpegPath = tmpPath;
      return tmpPath;
    } catch {}
  }
  // 4) 全部失败：退回原始路径，让 spawn 抛出原始错误（便于排查）
  return rawPath;
}

// --- ffmpeg 转码：把任意前端音频（opus/webm 等）转成 NLS 要求的 16k/16bit/mono WAV ---
// 前端不再做解码/重采样，原样上传 opus/webm；后端用 ffmpeg-static 转码后再送阿里云。
function detectFfmpegFormat(buf) {
  // 根据魔数猜测封装格式，给 ffmpeg 一个明确的 -f 提示（stdin 无扩展名时尤其有用）
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'OggS') return 'ogg';
  return ''; // 让 ffmpeg 自行探测（含 WAV/RIFF 等情况）
}

function transcodeToWav(inputBuffer, forcedFmt = '') {
  return new Promise((resolve, reject) => {
    let ffmpeg;
    try {
      // 惰性加载：仅 ASR 转码路径需要，缺失时不阻断 TTS / CosyVoice 冷启动。
      // 同时确保二进制有执行权限（Windows 打包的 zip 会丢失 +x）。
      ffmpeg = ensureFfmpegBinary();
    } catch {
      reject(new Error('ffmpeg 不可用：请在函数目录执行 npm install ffmpeg-static 后重新部署'));
      return;
    }
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (forcedFmt) args.push('-f', forcedFmt);
    args.push('-i', 'pipe:0');
    args.push('-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1');
    let proc;
    try {
      proc = spawn(ffmpeg, args);
    } catch (e) {
      reject(new Error('ffmpeg 启动失败：' + (e && e.message ? e.message : e) + '（确认已 npm install ffmpeg-static 且二进制有执行权限）'));
      return;
    }
    const out = [];
    const errOut = [];
    proc.stdout.on('data', (c) => out.push(c));
    proc.stderr.on('data', (c) => errOut.push(c));
    proc.on('error', (e) => reject(new Error('ffmpeg 进程错误：' + (e && e.message ? e.message : e))));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('ffmpeg 转码失败 (code=' + code + ')：' + Buffer.concat(errOut).toString('utf8').slice(0, 600)));
        return;
      }
      const buf = Buffer.concat(out);
      if (!buf || buf.length < 44) {
        reject(new Error('ffmpeg 未输出有效 WAV（音频可能为空或损坏）'));
        return;
      }
      resolve(buf);
    });
    proc.stdin.on('error', () => {}); // 忽略对端提前关闭
    proc.stdin.write(inputBuffer);
    proc.stdin.end();
  });
}

// --- 阿里云「一句话识别」：上传 wav(16k, 16bit, mono) 返回识别文本 ---
async function recognizeChunk(wavBuffer) {
  const token = await getToken();
  const q = new URLSearchParams();
  q.set('appkey', APPKEY);
  q.set('format', 'wav');
  q.set('sample_rate', '16000');
  q.set('enable_punctuation_prediction', 'true');
  const url = `https://${GATEWAY_HOST}/stream/v1/asr?${q.toString()}`;
  const res = await httpsPostBuffer(url, wavBuffer, 'application/octet-stream', 30000, { 'X-NLS-Token': token });

  let data;
  try {
    data = JSON.parse(res.body.toString('utf8'));
  } catch (e) {
    throw new Error('ASR 响应解析失败');
  }
  // 阿里云一句话识别：status=20000000 表示成功
  if (data.status !== 20000000) {
    throw new Error('ASR 失败: status=' + data.status + ' msg=' + (data.message || ''));
  }
  return data.result || '';
}

// --- 长文本按词切分（每段 ≤ max 字符，阿里云单次上限 300）---
function splitText(text, max = 280) {
  const words = text.split(/\s+/);
  const chunks = [];
  let buf = '';
  for (const w of words) {
    if (buf && (buf + ' ' + w).length > max) {
      chunks.push(buf);
      buf = '';
    }
    buf = buf ? buf + ' ' + w : w;
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [text];
}

// --- 语速换算：app 传 "±N%"（相对百分比）→ 阿里云 speech_rate（-500~500）---
function toAliyunRate(speed) {
  if (!speed || speed <= 0) speed = 1;
  const r = speed < 1 ? (1 - 1 / speed) / 0.002 : (1 - 1 / speed) / 0.001;
  return Math.max(-500, Math.min(500, Math.round(r)));
}

// --- CORS 响应头 ---
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
  };
}

// --- CosyVoice（百炼）语音合成（功能2）---
// 直调 DashScope HTTP API（Node 内置 https，零额外依赖）。支持非流式（output.audio）
// 与流式（SSE，逐行 data: {...output.audio...}）两种返回，统一解析为 mp3 Buffer。

/**
 * 构造 CosyVoice 请求体。cosyVoiceId 缺省（占位未填）时省略 voice 字段，
 * 交由模型使用默认音色（设计 §3 / §7：映射缺失回退默认，不报错）。
 * 导出仅供单测（架构 T9）。
 */
function buildCosyVoicePayload(text, cosyVoiceId, speed, model) {
  const payload = {
    model: model || COSYVOICE_MODEL,
    input: { text },
    parameters: {
      format: 'mp3',
      sample_rate: 16000,
      // CosyVoice 语速为 0.5~2.0 倍率；speed 已是倍率（app 传 "±N%" 换算得来）
      rate: Math.max(0.5, Math.min(2.0, Number(speed) || 1)),
      volume: 50,
    },
  };
  if (cosyVoiceId) payload.input.voice = cosyVoiceId;
  return payload;
}

/**
 * 从 DashScope 响应中解析 mp3 音频 Buffer。
 * 兼容非流式 JSON（output.audio 字段）与流式 SSE（逐行 data: {...}）。
 * 非流式下：audio 为字符串时按 base64 解码（兼容旧格式）；audio 为对象时取其
 * 预签名 url（OSS 地址，可能是 http://）并下载真实 mp3 字节。
 * 导出仅供单测（架构 T9）。
 */
async function extractCosyVoiceAudio(res) {
  const ct = res.contentType || '';
  // 流式（SSE）：逐行拼接 output.audio
  if (ct.includes('text/event-stream')) {
    const lines = res.body.toString('utf8').split('\n');
    const chunks = [];
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const json = s.slice(5).trim();
      if (!json || json === '[DONE]') continue;
      try {
        const obj = JSON.parse(json);
        const a = obj.output && obj.output.audio;
        if (a) chunks.push(Buffer.from(a, 'base64'));
      } catch { /* 跳过非 JSON 行 */ }
    }
    if (chunks.length === 0) throw new Error('CosyVoice 流式响应未解析到音频');
    return Buffer.concat(chunks);
  }
  // 非流式 JSON
  let data;
  try {
    data = JSON.parse(res.body.toString('utf8'));
  } catch (e) {
    throw new Error('CosyVoice 响应解析失败');
  }
  const code = data.code || (data.output && data.output.code);
  if (code !== undefined && code !== null && String(code) !== '200' && String(code) !== '20000000') {
    throw new Error('CosyVoice 合成失败: ' + (data.message || JSON.stringify(data).slice(0, 200)));
  }
  const audio = data.output && data.output.audio;
  if (!audio) throw new Error('CosyVoice 响应缺少 audio 字段');
  // 兼容旧 base64 格式（audio 为字符串）
  if (typeof audio === 'string') return Buffer.from(audio, 'base64');
  // 真实格式（cosyvoice-v3-flash 非流式）：audio 为对象，音频二进制只在预签名 url 中
  if (audio && typeof audio === 'object' && audio.url) return await fetchUrl(audio.url);
  throw new Error('CosyVoice 响应缺少 audio 字段');
}

// 发送 JSON 的便捷封装（复用 httpsPostBuffer）。
function httpsPostJson(urlStr, payloadObj, extraHeaders = {}, timeoutMs = 30000) {
  const bodyBuffer = Buffer.from(JSON.stringify(payloadObj));
  return httpsPostBuffer(urlStr, bodyBuffer, 'application/json', timeoutMs, extraHeaders);
}

/**
 * 合成整段文本为 mp3 Buffer（CosyVoice）。长文本按词切分逐段合成再拼接。
 * @param {string} text
 * @param {string} cosyVoiceId 音色 id（'' 表示用默认音色）
 * @param {number} speed 语速倍率 0.5~2.0
 * @returns {Promise<Buffer>}
 */
async function synthesizeCosyVoice(text, cosyVoiceId, speed) {
  if (!DASHSCOPE_API_KEY) {
    throw new Error('未配置 DASHSCOPE_API_KEY，无法使用 CosyVoice（请在 FC 环境变量配置，或设 TTS_PROVIDER=nls 回退 NLS）');
  }
  const chunks = splitText(text, 280);
  const parts = [];
  for (const c of chunks) {
    const payload = buildCosyVoicePayload(c, cosyVoiceId, speed, COSYVOICE_MODEL);
    const res = await httpsPostJson(DASHSCOPE_TTS_URL, payload, {
      'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
      'Content-Type': 'application/json',
      'X-DashScope-DataInspection': 'disable',
    });
    parts.push(await extractCosyVoiceAudio(res));
  }
  return Buffer.concat(parts);
}

function send(callback, status, headers, body, isBase64) {
  callback(null, {
    statusCode: status,
    headers: { ...corsHeaders(), ...headers },
    body,
    isBase64Encoded: !!isBase64,
  });
}

const VOICE_LABELS = {
  cally: 'Cally (美式女声·口语)',
  abby: 'Abby (美式女声)',
  andy: 'Andy (美式男声)',
  harry: 'Harry (英式男声)',
  eric: 'Eric (英式男声)',
  broadcast_female: '播音腔（女）',
  broadcast_male: '播音腔（男）',
};

// --- FC HTTP 触发器入口 ---
// 路由策略（兼容不同 FC 版本对子路径的转发差异）：
//   GET /?text=xxx&voice=cally&rate=-25%   返回 audio/mpeg  ← 主入口（根路径 + query）
//   GET /tts?text=xxx                       兼容旧子路径路由
//   GET /voices 或 /?action=voices          返回英文发音人列表
// 采用「根路径 + query」为主，避免部分 FC 版本不转发子路径导致 404。
// 兼容多种 FC 版本的 query 字段来源，并支持 rawQueryString 兜底解析
function collectQuery(e) {
  const qs = {};
  const objQs =
    e.queryString ||
    e.queryStringParameters ||
    e.queryParameters ||
    (e.requestContext && e.requestContext.http && e.requestContext.http.queries) ||
    {};
  for (const k of Object.keys(objQs)) {
    let v = objQs[k];
    if (Array.isArray(v)) v = v[0];
    qs[k] = v;
  }
  // 原始查询串兜底（部分 FC 版本仅提供 rawQueryString）
  if (e.rawQueryString) {
    for (const pair of String(e.rawQueryString).split('&')) {
      if (!pair) continue;
      const idx = pair.indexOf('=');
      const k = decodeURIComponent(pair.slice(0, idx < 0 ? pair.length : idx));
      const v = decodeURIComponent(pair.slice(idx < 0 ? pair.length : idx + 1).replace(/\+/g, ' '));
      if (!(k in qs)) qs[k] = v;
    }
  }
  return qs;
}

// 兼容多种 FC 版本的 path 字段来源
function collectPath(e) {
  return (
    e.rawPath ||
    (e.requestContext && e.requestContext.http && e.requestContext.http.path) ||
    e.path ||
    (typeof e.requestURI === 'string' ? e.requestURI.split('?')[0] : '') ||
    '/'
  );
}

module.exports.BROADCAST_VOICES = BROADCAST_VOICES;
module.exports.NLS_VOICE_ALIAS = NLS_VOICE_ALIAS;
module.exports.handler = async function (event, context, callback) {
  let e = event;
  // FC HTTP 触发器可能把 event 作为 Buffer 传入（而非字符串/对象），需先转字符串再 JSON.parse
  if (Buffer.isBuffer(e)) {
    e = e.toString('utf8');
  }
  if (typeof e === 'string') {
    try {
      e = JSON.parse(e);
    } catch (err) {
      e = {};
    }
  }
  const qs = collectQuery(e);
  const path = collectPath(e);

  // 调试开关：?__debug=1 返回真实 event 结构，便于排查 FC 字段差异
  if (qs.__debug || qs.debug) {
    return send(
      callback,
      200,
      { 'Content-Type': 'application/json' },
      JSON.stringify({ rawPath: path, queryKeys: Object.keys(qs), event: e }, null, 2)
    );
  }

  const method = (
    e.httpMethod ||
    (e.requestContext && e.requestContext.http && e.requestContext.http.method) ||
    'GET'
  ).toUpperCase();

  if (method === 'OPTIONS') {
    return send(callback, 204, {}, '');
  }

  // 发音人列表
  const action = qs.action;
  if (action === 'voices' || path.endsWith('/voices')) {
    const voices = KNOWN_EN_VOICES.map((v) => ({ name: v, label: VOICE_LABELS[v] || v }));
    return send(callback, 200, { 'Content-Type': 'application/json' }, JSON.stringify(voices));
  }

  // TTS：子路径 /tts 或根路径带 text 参数
  if (path.endsWith('/tts') || (path === '/' && qs.text)) {
    const text = qs.text || '';
    if (!text || !text.trim()) {
      return send(callback, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: '缺少 text 参数' }));
    }

    const reqVoice = (qs.voice || '').toLowerCase();
    const voice = KNOWN_EN_VOICES.includes(reqVoice) ? reqVoice : DEFAULT_VOICE;
    // 播音腔音色（broadcast_*）或前端显式 provider=nls → 强制走 NLS 老风格，
    // 即使全局 TTS_PROVIDER=cosyvoice 也绕过 CosyVoice。
    const forceNls = qs.provider === 'nls' || BROADCAST_VOICES.includes(voice);

    // 语速：app 传 "±N%"（相对百分比），换算为倍率 speed（供 CosyVoice 直接使用）
    let speed = 1;
    if (qs.rate) {
      const m = String(qs.rate).match(/-?\d+(\.\d+)?/);
      if (m) speed = 1 + parseFloat(m[0]) / 100;
    }
    const speechRate = toAliyunRate(speed);

    try {
      let audio;
      if (!forceNls && TTS_PROVIDER === 'cosyvoice') {
        // 功能2：百炼 CosyVoice；始终解析到非空音色 id（默认英文音色 loong*），保证请求体带 voice。
        const cosyVoiceId = resolveCosyVoiceId(voice);
        try {
          audio = await synthesizeCosyVoice(text, cosyVoiceId, speed);
        } catch (cvErr) {
          // 兜底回退 NLS（前提是已配置阿里云 AK / APPKEY），保证生产可用。
          if (AK_ID && AK_SECRET && APPKEY) {
            console.error('[CosyVoice 失败，回退 NLS]:', cvErr && cvErr.message);
            const parts = [];
            for (const c of splitText(text, 280)) parts.push(await synthesizeChunk(c, NLS_VOICE_ALIAS[voice] || voice, speechRate));
            audio = Buffer.concat(parts);
          } else {
            throw cvErr;
          }
        }
      } else {
        // 默认 / 兜底 / 播音腔强制：阿里云 NLS（行为完全不变）。
        // 播音腔音色用 NLS_VOICE_ALIAS 映射到真实 NLS 发音人（andy/cally）。
        const parts = [];
        for (const c of splitText(text, 280)) parts.push(await synthesizeChunk(c, NLS_VOICE_ALIAS[voice] || voice, speechRate));
        audio = Buffer.concat(parts);
      }
      return send(
        callback,
        200,
        { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' },
        audio.toString('base64'),
        true
      );
    } catch (err) {
      return send(
        callback,
        500,
        { 'Content-Type': 'application/json' },
        JSON.stringify({ error: err.message || String(err) })
      );
    }
  }

  // ASR：子路径 /recognize 或根路径 POST + action=asr
  // 前端（无 Google 引擎的华为手机）把录音转成 wav(16k,16bit,mono) 后 POST 上来
  if (method === 'POST' && (path.endsWith('/recognize') || action === 'asr')) {
    const rawBody = e.body;
    if (rawBody == null) {
      return send(callback, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: '缺少音频数据' }));
    }
    let bodyBuf;
    if (Buffer.isBuffer(rawBody)) {
      // FC 直接二进制透传（罕见，仅非标准配置下）
      bodyBuf = rawBody;
    } else {
      // 超鲁棒解码：不依赖 isBase64Encoded 分支判断，兼容 FC 对任意大小/类型
      // 请求体的编码差异（原样透传 / 二次 base64 / 二进制 base64 化）。
      const s = typeof rawBody === 'string' ? rawBody : String(rawBody);
      let candidate = s;
      if (e.isBase64Encoded) {
        // FC 对较大的请求体可能再做一层 base64 编码并设置 isBase64Encoded=true，
        // 先剥掉这层，拿到「客户端真正发出的内容」。
        candidate = Buffer.from(s, 'base64').toString('latin1');
      }
      // candidate 现在是客户端发出的原始内容：
      //   · 前端走 text/plain 上传的是 base64(WAV) 字符串 → 按 base64 解即 WAV
      //   · 部分场景下二进制被文本化 → candidate 是 WAV 字节的 latin1 表示 → 直接还原
      const asWav = Buffer.from(candidate.replace(/\s+/g, ''), 'base64');
      if (asWav.slice(0, 4).toString('latin1') === 'RIFF') {
        bodyBuf = asWav;                       // 标准 base64(WAV)
      } else {
        bodyBuf = Buffer.from(candidate, 'latin1'); // 二进制被文本化，直接还原字节
      }
    }
    if (!bodyBuf || bodyBuf.length === 0) {
      return send(callback, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: '音频为空' }));
    }
    try {
      // 兼容旧版前端：若已是 WAV（RIFF 头）则直接识别；否则用 ffmpeg 转码成标准 WAV。
      let wavBuf = bodyBuf;
      if (bodyBuf.slice(0, 4).toString('latin1') !== 'RIFF') {
        const fmt = detectFfmpegFormat(bodyBuf);
        wavBuf = await transcodeToWav(bodyBuf, fmt);
      }
      const text = await recognizeChunk(wavBuf);
      return send(callback, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ result: text }));
    } catch (err) {
      // ffmpeg 转码失败 / NLS 调用失败都透传清晰错误信息，前端据此显示红字
      return send(
        callback,
        500,
        { 'Content-Type': 'application/json' },
        JSON.stringify({ error: err.message || String(err) })
      );
    }
  }

  // 兜底诊断：返回完整 event 结构（脱敏）以便定位 FC 字段差异
  const safeEvent = {};
  for (const k of Object.keys(e)) {
    const v = e[k];
    if (typeof v === 'string' && v.length > 200) { safeEvent[k] = v.slice(0, 200) + '...(truncated)'; }
    else if (typeof v === 'object' && v !== null) {
      try { safeEvent[k] = JSON.stringify(v).slice(0, 500); } catch (_) { safeEvent[k] = '[circular/unserializable]'; }
    } else { safeEvent[k] = v; }
  }
  return send(
    callback,
    404,
    { 'Content-Type': 'application/json' },
    JSON.stringify({ error: 'Not Found', _diag: { rawPath: path, queryKeys: Object.keys(qs), envRegion: REGION, eventKeys: Object.keys(e), eventPreview: safeEvent } })
  );
};

// 导出仅供单测（架构 T9）：不依赖 FC handler 即可验证 CosyVoice 请求体 / 音频解析。
module.exports.buildCosyVoicePayload = buildCosyVoicePayload;
module.exports.extractCosyVoiceAudio = extractCosyVoiceAudio;
module.exports.synthesizeCosyVoice = synthesizeCosyVoice;
module.exports.resolveCosyVoiceId = resolveCosyVoiceId;
module.exports.__test = { TTS_PROVIDER, COSYVOICE_MODEL, COSYVOICE_VOICE_MAP, COSYVOICE_DEFAULT_VOICE_MAP, DASHSCOPE_TTS_URL };
