/**
 * syncConfig.js
 * 同步码跨端同步 — 共享常量与工具函数。
 *
 * 所有同步相关常量集中在此（设计 §7 共享知识），避免散落各处。
 * 前端零新增运行时依赖：仅用原生 fetch，同步代理 URL 可经 localStorage 覆盖。
 */

// localStorage key：存 { syncId, token, full }（整码 = syncId.token）
export const SYNC_CODE_KEY = 'speakup_sync_code';

// localStorage key：同步代理地址覆盖（与 speakup_cloud_tts_url 同模式）
export const SYNC_PROXY_URL_KEY = 'speakup_sync_proxy_url';

// 同步代理默认地址（已部署的阿里云 FC 函数，无需认证 + CORS*）。
// 仍可用 speakup_sync_proxy_url 覆盖；若此处地址变更，用户可在「设置→数据同步」重新填入。
export const SYNC_PROXY_URL = 'https://aliyun-nc-proxy-fxiiveelsb.cn-hangzhou.fcapp.run';

// 防抖上传窗口（毫秒）
export const DEBOUNCE_MS = 2000;

// 云端对象 schema 版本
export const SCHEMA_VERSION = 1;

// 错误码（与 FC HTTP 状态对齐）
export const ERROR_CODES = {
  NOT_BOUND: 1,
  NETWORK: 2,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  SERVER: 500,
};

// 整码正则：syncId(10 hex) . token(22 hex)
const CODE_REGEX = /^([0-9a-f]{10})\.([0-9a-f]{22})$/;

/**
 * 组装整码。
 * @param {string} syncId
 * @param {string} token
 * @returns {string} "syncId.token"
 */
export function formatCode(syncId, token) {
  return `${syncId}.${token}`;
}

/**
 * 解析整码。
 * @param {string} full
 * @returns {{syncId:string, token:string, full:string}|null} 非法返回 null
 */
export function parseCode(full) {
  if (typeof full !== 'string') return null;
  const m = full.trim().match(CODE_REGEX);
  if (!m) return null;
  return { syncId: m[1], token: m[2], full: `${m[1]}.${m[2]}` };
}

/**
 * 读取同步代理地址：localStorage 覆盖默认占位（沿用 cloudTtsUrl 模式）。
 * @returns {string}
 */
export function getProxyUrl() {
  try {
    const stored = localStorage.getItem(SYNC_PROXY_URL_KEY);
    if (stored && stored.trim()) return stored.trim();
  } catch {
    /* ignore storage errors */
  }
  return SYNC_PROXY_URL;
}

/**
 * 是否真正配置了代理（排除默认占位符 / 空白）。
 * 未配置时不发起同步请求，避免无意义的网络错误与状态报错。
 * @returns {boolean}
 */
export function isProxyConfigured() {
  const url = getProxyUrl();
  if (!url || !url.trim()) return false;
  if (url.includes('<') || url.includes('your-sync-proxy')) return false;
  return true;
}

/**
 * 写入 / 清除同步代理地址覆盖。
 * @param {string} url
 */
export function setSyncProxyUrl(url) {
  try {
    if (url && url.trim()) localStorage.setItem(SYNC_PROXY_URL_KEY, url.trim());
    else localStorage.removeItem(SYNC_PROXY_URL_KEY);
  } catch {
    /* ignore storage errors */
  }
}
