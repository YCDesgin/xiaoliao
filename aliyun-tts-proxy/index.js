// 虾聊 (XiaLiao) — 阿里云语音合成代理 (Aliyun TTS Proxy)
// 零依赖：仅使用 Node.js 内置模块 (https / crypto / url)，可直接粘贴到阿里云
// 函数计算 (FC) 控制台，无需 npm install。
//
// 作用：作为虾聊的"云端 TTS"地址。接口兼容原 Cloudflare Worker：
//   GET /tts?text=...&voice=...&rate=...   返回 audio/mpeg 二进制
//   GET /voices                      返回可用英文发音人列表 (JSON)
//
// 部署后，把 FC 触发器的 URL 填到虾聊「设置 → 云端 TTS 地址」即可。
// 国内的函数计算域名可直连，华为手机也能听到自然英文发音。

const https = require('https');
const crypto = require('crypto');
const { URLSearchParams } = require('url');

const REGION = process.env.ALIYUN_REGION || 'cn-shanghai';
const APPKEY = process.env.ALIYUN_APPKEY || '';
const AK_ID = process.env.ALIYUN_ACCESS_KEY_ID || '';
const AK_SECRET = process.env.ALIYUN_ACCESS_KEY_SECRET || '';
// 默认发音人：cally = 美式英文女声，专为英语口语对话设计
const DEFAULT_VOICE = process.env.DEFAULT_VOICE || 'cally';

// 阿里云 NLS 可用英文发音人（仅这些名称会直接采用，其余回退 DEFAULT_VOICE）
const KNOWN_EN_VOICES = ['cally', 'abby', 'andy', 'harry', 'eric'];

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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
  };
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
};

// --- FC HTTP 触发器入口 ---
// 路由策略（兼容不同 FC 版本对子路径的转发差异）：
//   GET /?text=xxx&voice=cally&rate=-25%   返回 audio/mpeg  ← 主入口（根路径 + query）
//   GET /tts?text=xxx                       兼容旧子路径路由
//   GET /voices 或 /?action=voices          返回英文发音人列表
// 采用「根路径 + query」为主，避免部分 FC 版本不转发子路径导致 404。
function getQueryValue(qs, key) {
  const v = qs[key];
  if (Array.isArray(v)) return v.length ? v[0] : undefined;
  return v;
}

module.exports.handler = async function (event, context, callback) {
  let e = event;
  if (typeof event === 'string') {
    try {
      e = JSON.parse(event);
    } catch (err) {
      e = {};
    }
  }
  const method = (
    e.httpMethod ||
    (e.requestContext && e.requestContext.http && e.requestContext.http.method) ||
    'GET'
  ).toUpperCase();

  // FC 的 query 字段可能是数组（queryParameters: { text: ['hello'] }），统一取首值
  const rawQs = e.queryString || e.queryStringParameters || e.queryParameters || {};
  const qs = {};
  for (const k of Object.keys(rawQs)) qs[k] = getQueryValue(rawQs, k);

  // path 兼容多种字段：rawPath / path / requestURI(去 query)
  const path =
    e.rawPath ||
    e.path ||
    (typeof e.requestURI === 'string' ? e.requestURI.split('?')[0] : '') ||
    '/';

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

    // 语速：app 传 "±N%"（相对百分比），换算为阿里云 speech_rate
    let speed = 1;
    if (qs.rate) {
      const m = String(qs.rate).match(/-?\d+(\.\d+)?/);
      if (m) speed = 1 + parseFloat(m[0]) / 100;
    }
    const speechRate = toAliyunRate(speed);

    try {
      const chunks = splitText(text, 280);
      const parts = [];
      for (const c of chunks) {
        parts.push(await synthesizeChunk(c, voice, speechRate));
      }
      const audio = Buffer.concat(parts);
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

  return send(callback, 404, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Not Found' }));
};
