// 虾聊 (XiaLiao) — 阿里云同步代理 (Aliyun Sync Proxy)
// 零依赖本体（仅使用 Node.js 内置 crypto）；OSS SDK 在部署时安装（ali-oss）。
//
// 作用：作为虾聊「同步码跨端同步」的云端代理，按命名空间（syncId）读写
// 每个联系人的聊天与复盘数据（OSS 对象 syncId/contactId.json），并通过
// syncId/.meta.json 里的 tokenHash = sha256(token) 做双因子鉴权。
//
// API（HTTP 触发器，CORS 开 *）：
//   GET  ?action=sync&op=get&syncId=&token=&contact=   返回该联系人的 ContactCloudData
//   POST ?action=sync&op=put&syncId=&token=&contact=   body=ContactCloudData，惰性建命名空间
//   GET  ?action=sync&op=list&syncId=&token=          返回已同步联系人 id 列表
//
// 部署后，把 FC 触发器 URL 填到虾聊「设置 → 同步代理地址」即可。

const OSS = require('ali-oss');
const crypto = require('crypto');

const OSS_REGION = process.env.OSS_REGION || 'cn-hangzhou';
const OSS_BUCKET = process.env.OSS_BUCKET || '';
const OSS_ACCESS_KEY_ID = process.env.OSS_ACCESS_KEY_ID || '';
const OSS_ACCESS_KEY_SECRET = process.env.OSS_ACCESS_KEY_SECRET || '';

function createOss() {
  return new OSS({
    region: OSS_REGION,
    bucket: OSS_BUCKET,
    accessKeyId: OSS_ACCESS_KEY_ID,
    accessKeySecret: OSS_ACCESS_KEY_SECRET,
  });
}

// --- CORS 响应头 ---
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
  };
}

function send(callback, status, headers, body, isBase64) {
  callback(null, {
    statusCode: status,
    headers: { ...corsHeaders(), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: !!isBase64,
  });
}

// --- 兼容多种 FC 版本的 query 字段来源（参考现有 aliyun-tts-proxy）---
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

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// 读取命名空间元数据（.meta.json）。不存在 / 读失败 → 返回 null。
async function getMeta(oss, syncId) {
  try {
    const obj = await oss.get(`${syncId}/.meta.json`);
    return JSON.parse(obj.content.toString('utf8'));
  } catch (err) {
    if (err.code === 'NoSuchKey' || err.status === 404) return null;
    return null; // 其他错误按「缺失」处理，交由后续逻辑决定
  }
}

async function putMeta(oss, syncId, tokenHash) {
  await oss.put(
    `${syncId}/.meta.json`,
    Buffer.from(JSON.stringify({ tokenHash, createdAt: new Date().toISOString() })),
  );
}

// 鉴权：返回 'ok' | 'forbidden' | 'missing'
async function validate(oss, syncId, token) {
  const meta = await getMeta(oss, syncId);
  if (!meta) return 'missing';
  if (meta.tokenHash !== sha256Hex(token)) return 'forbidden';
  return 'ok';
}

module.exports.handler = async function (event, context, callback) {
  let e = event;
  if (Buffer.isBuffer(e)) e = e.toString('utf8');
  if (typeof e === 'string') {
    try { e = JSON.parse(e); } catch (err) { e = {}; }
  }

  const qs = collectQuery(e);
  const method = (
    e.httpMethod ||
    (e.requestContext && e.requestContext.http && e.requestContext.http.method) ||
    'GET'
  ).toUpperCase();

  if (method === 'OPTIONS') return send(callback, 204, {}, '');

  const action = qs.action;
  if (action !== 'sync') {
    return send(callback, 400, { 'Content-Type': 'application/json' },
      { error: 'bad_request', message: "expected action=sync" });
  }

  const op = qs.op; // get | put | list
  const syncId = qs.syncId;
  const token = qs.token;
  const contact = qs.contact; // contactId

  if (!syncId || !token) {
    return send(callback, 400, { 'Content-Type': 'application/json' },
      { error: 'bad_request', message: 'syncId and token required' });
  }

  const oss = createOss();

  try {
    const valid = await validate(oss, syncId, token);
    if (valid === 'forbidden') {
      return send(callback, 401, { 'Content-Type': 'application/json' }, { error: 'unauthorized' });
    }
    if (valid === 'missing') {
      // 命名空间不存在：仅 put 惰性创建，get/list 返回 404
      if (op === 'put') {
        await putMeta(oss, syncId, sha256Hex(token));
      } else {
        return send(callback, 404, { 'Content-Type': 'application/json' }, { error: 'not_found' });
      }
    }

    if (op === 'list') {
      const list = await oss.list({ prefix: `${syncId}/`, delimiter: '/' });
      const contacts = (list.objects || [])
        .map((o) => o.name.replace(`${syncId}/`, '').replace(/\.json$/, ''))
        .filter((n) => n && n !== '.meta.json');
      return send(callback, 200, { 'Content-Type': 'application/json' }, { contacts });
    }

    if (op === 'get') {
      if (!contact) {
        return send(callback, 400, { 'Content-Type': 'application/json' },
          { error: 'bad_request', message: 'contact required' });
      }
      try {
        const obj = await oss.get(`${syncId}/${contact}.json`);
        const data = JSON.parse(obj.content.toString('utf8'));
        return send(callback, 200, { 'Content-Type': 'application/json' }, data);
      } catch (err) {
        if (err.code === 'NoSuchKey' || err.status === 404) {
          return send(callback, 404, { 'Content-Type': 'application/json' }, { error: 'not_found' });
        }
        throw err;
      }
    }

    if (op === 'put') {
      if (!contact) {
        return send(callback, 400, { 'Content-Type': 'application/json' },
          { error: 'bad_request', message: 'contact required' });
      }
      let bodyStr = e.body;
      if (e.isBase64Encoded && typeof bodyStr === 'string') {
        bodyStr = Buffer.from(bodyStr, 'base64').toString('utf8');
      }
      let payload;
      try {
        payload = JSON.parse(bodyStr || '{}');
      } catch {
        return send(callback, 400, { 'Content-Type': 'application/json' },
          { error: 'bad_request', message: 'invalid json body' });
      }
      if (typeof payload !== 'object' || payload === null) {
        return send(callback, 400, { 'Content-Type': 'application/json' },
          { error: 'bad_request', message: 'body must be an object' });
      }
      const updatedAt = new Date().toISOString();
      payload.updatedAt = updatedAt;
      if (typeof payload.v !== 'number') payload.v = 1;
      if (!Array.isArray(payload.messages)) payload.messages = [];
      if (!Array.isArray(payload.reviews)) payload.reviews = [];
      await oss.put(`${syncId}/${contact}.json`, Buffer.from(JSON.stringify(payload)));
      return send(callback, 200, { 'Content-Type': 'application/json' },
        { ok: true, updatedAt });
    }

    return send(callback, 400, { 'Content-Type': 'application/json' },
      { error: 'bad_request', message: 'unknown op' });
  } catch (err) {
    return send(callback, 500, { 'Content-Type': 'application/json' },
      { error: 'server_error', message: String((err && err.message) || err) });
  }
};
