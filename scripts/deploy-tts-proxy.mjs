#!/usr/bin/env node
/**
 * scripts/deploy-tts-proxy.mjs
 * ---------------------------------------------------------------------------
 * 虾聊（XiaLiao）阿里云 TTS/ASR 代理自动部署脚本（ESM）。
 *
 * Deploy script for the XiaLiao Aliyun TTS/ASR proxy to Alibaba Cloud Function
 * Compute (FC 3.0). It reads a ZIP package and uploads it to the FC function
 * `tts-proxy` (region `cn-hangzhou`) via the official SDK
 * `@alicloud/fc20230330` -> `client.updateFunction(...)`.
 *
 * 用法 / Usage:
 *   node scripts/deploy-tts-proxy.mjs [<zip-path>] [--dry-run]
 *   node scripts/deploy-tts-proxy.mjs tts-proxy-deploy.zip
 *   node scripts/deploy-tts-proxy.mjs tts-proxy-deploy.zip --dry-run
 *
 * 参数 / Arguments:
 *   <zip-path>   待上传的 zip 路径（相对 cwd 或绝对路径）。默认: tts-proxy-deploy.zip
 *   --dry-run    只校验/生成 ZIP、打印 functionName/region/大小、断言 base64<=50MB，
 *                【不】真正发起请求，无需 AK。Default path if omitted.
 *
 * 凭据 / Credentials (only needed in real-deploy mode):
 *   ALIBABA_CLOUD_ACCESS_KEY_ID       阿里云 AccessKeyId
 *   ALIBABA_CLOUD_ACCESS_KEY_SECRET   阿里云 AccessKeySecret
 *   (通过 GitHub Secrets 注入，不落盘、不进日志)
 *
 * 依赖 / Dependencies (installed into aliyun-tts-proxy/node_modules):
 *   @alicloud/fc20230330  ^4.7.8
 *   @alicloud/openapi-client ^0.4.15
 *   SDK 通过 createRequire 从 aliyun-tts-proxy 目录解析（见 resolveSdk），
 *   因此这些依赖必须装在 aliyun-tts-proxy 子目录下，而不是仓库根。
 * ---------------------------------------------------------------------------
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----- 固定参数 / Fixed deployment parameters -------------------------------
const REGION = 'cn-hangzhou'; // 地域（固定）Region (fixed)
const FUNCTION_NAME = 'tts-proxy'; // 函数名（固定）Function name (fixed)
// 注意：@alicloud/openapi-client 的 Config.endpoint 只接受【主机名】，
// SDK 会自行拼接 `https://`。若此处带上协议前缀会被拼成
// `https://https://...` 导致 DNS 解析失败（EAI_AGAIN）。
// NOTE: endpoint MUST be a bare hostname; the SDK adds the scheme itself.
//
// 主机名必须是 FC 3.0（API 2023-03-30）的接入域名 `fcv3.cn-hangzhou.aliyuncs.com`。
// `cn-hangzhou.fc.aliyuncs.com` 是 FC 2.0 的格式，公网无法解析（ENOTFOUND）。
const ENDPOINT = 'fcv3.cn-hangzhou.aliyuncs.com'; // FC 3.0 杭州 endpoint (hostname only)
// FC UpdateFunctionCode/UpdateFunction 的 zipFile(base64) 上限：50MB。
// Max base64-encoded size allowed by FC for the code package.
const MAX_BASE64_BYTES = 50 * 1024 * 1024;
const DEFAULT_ZIP = 'tts-proxy-deploy.zip';

// ----- 小工具 / Helpers ------------------------------------------------------

/**
 * 打印信息日志到 stdout。
 * Log an informational message to stdout.
 * @param {string} msg
 */
function log(msg) {
  process.stdout.write(`${msg}\n`);
}

/**
 * 打印错误并带非零退出码结束进程。
 * Print an error message to stderr and exit with a non-zero code.
 * @param {string} msg
 */
function fail(msg) {
  process.stderr.write(`[deploy-tts-proxy] ERROR: ${msg}\n`);
  process.exit(1);
}

/**
 * 格式化字节数为人类可读字符串。
 * Format a byte count into a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(2)} ${units[i]} (${bytes} bytes)`;
}

/**
 * 解析命令行参数。
 * Parse CLI arguments.
 * @param {string[]} argv
 * @returns {{ zipPath: string, dryRun: boolean }}
 */
function parseArgs(argv) {
  let dryRun = false;
  let zipPath = null;
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n') {
      dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      log(
        'Usage: node scripts/deploy-tts-proxy.mjs [<zip-path>] [--dry-run]\n' +
          '  <zip-path>   path to the zip to upload (default: tts-proxy-deploy.zip)\n' +
          '  --dry-run    validate only, no network request (no AK needed)'
      );
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      zipPath = arg;
    }
  }
  return { zipPath: zipPath || DEFAULT_ZIP, dryRun };
}

/**
 * 从多个候选目录解析一个 npm 模块（优先 aliyun-tts-proxy/node_modules）。
 * Resolve an npm module from candidate base paths, preferring the proxy
 * sub-directory's node_modules (where the SDK is installed by the CI).
 *
 * 因为脚本从仓库根运行，而 SDK 装在 aliyun-tts-proxy/node_modules，
 * 标准 ESM import 无法跨目录找到它，这里用 createRequire 指定基准目录来解析。
 *
 * @param {string} spec module specifier, e.g. '@alicloud/fc20230330'
 * @returns {any}
 */
function resolveSdk(spec) {
  const candidates = [
    // 1) 优先：aliyun-tts-proxy 子目录（CI 里 npm ci 安装的位置）
    path.resolve(process.cwd(), 'aliyun-tts-proxy', 'package.json'),
    // 2) 备选：相对脚本位置的 aliyun-tts-proxy
    path.resolve(__dirname, '..', 'aliyun-tts-proxy', 'package.json'),
    // 3) 兜底：仓库根 / 脚本自身（已装在根 node_modules 时）
    path.resolve(process.cwd(), 'package.json'),
    __filename,
  ];
  let lastErr = null;
  for (const base of candidates) {
    try {
      const req = createRequire(base);
      return req(spec);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * 真实部署：调用 FC OpenAPI 上传代码包。
 * Real deploy: call FC OpenAPI to upload the code package.
 * @param {string} zipPath
 * @param {Buffer} zipBuffer
 */
async function deploy(zipPath, zipBuffer) {
  const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
  if (!accessKeyId || !accessKeySecret) {
    fail(
      '缺少阿里云凭据 / Missing credentials.\n' +
        '请设置环境变量 ALIBABA_CLOUD_ACCESS_KEY_ID 与 ALIBABA_CLOUD_ACCESS_KEY_SECRET\n' +
        '(在 GitHub Actions 中通过 secrets 注入)。'
    );
  }

  // 延迟加载 SDK（仅真实部署时需要；--dry-run 不需要安装 SDK）。
  // Lazily load the SDK so --dry-run works even without the SDK installed.
  let fcModule;
  let openapiModule;
  try {
    fcModule = resolveSdk('@alicloud/fc20230330');
    openapiModule = resolveSdk('@alicloud/openapi-client');
  } catch (err) {
    fail(
      '无法加载阿里云 SDK / Failed to load Aliyun SDK.\n' +
        '请先在 aliyun-tts-proxy 执行 `npm ci` 安装 @alicloud/fc20230330 与 @alicloud/openapi-client。\n' +
        `原始错误 / Original error: ${err && err.message ? err.message : err}`
    );
  }

  const Client = fcModule.default || fcModule; // @alicloud/fc20230330 以 default 导出 Client 类
  const OpenApi = openapiModule;
  const Config = OpenApi.Config || (OpenApi.default && OpenApi.default.Config);

  // 初始化 FC 3.0 客户端（函数是一级资源，不需要 serviceName）。
  // Init FC 3.0 client (functions are top-level resources; no serviceName needed).
  const config = new Config({
    accessKeyId,
    accessKeySecret,
    regionId: REGION,
    endpoint: ENDPOINT,
    // 上传 45MB base64 代码包时，SDK 默认 readTimeout=3000ms 会从 Azure→杭州超时。
    // 调大读取/连接超时以容纳大包上传。
    connectTimeout: 10000,   // 连接超时 10s
    readTimeout: 60000,     // 读取（含上传）超时 60s
  });
  const client = new Client(config);

  // FC 3.0 用 UpdateFunction 更新代码：body.code.zipFile = base64。
  // 仅传 code 字段，FC 会保留其余函数配置（部分更新 / partial update）。
  // In FC 3.0, use updateFunction with body.code.zipFile = base64.
  const base64 = zipBuffer.toString('base64');
  const request = new fcModule.UpdateFunctionRequest({
    body: new fcModule.UpdateFunctionInput({
      code: new fcModule.InputCodeLocation({ zipFile: base64 }),
    }),
  });

  log(
    `[deploy-tts-proxy] 正在上传代码到 FC / Uploading code to FC -> ` +
      `function=${FUNCTION_NAME} region=${REGION}`
  );
  try {
    // updateFunction(functionName, request) 内部使用默认 runtime/headers。
    const resp = await client.updateFunction(FUNCTION_NAME, request);
    log(
      `[deploy-tts-proxy] 部署成功 / Deploy succeeded: ` +
        `${FUNCTION_NAME} @ ${REGION}`
    );
    if (resp && typeof resp.toMap === 'function') {
      log(`[deploy-tts-proxy] response: ${JSON.stringify(resp.toMap())}`);
    }
  } catch (err) {
    const detail =
      (err && err.message) ||
      (err && err.code) ||
      err;
    fail(
      `上传失败 / Upload failed.\n` +
        `请确认：1) 函数 ${FUNCTION_NAME} 已在 ${REGION} 存在；` +
        `2) 凭据有 fc:UpdateFunction 权限；3) base64 未超过 50MB。\n` +
        `原始错误 / Original error: ${detail}`
    );
  }
}

// ----- 主流程 / Main ----------------------------------------------------------

async function main() {
  const { zipPath, dryRun } = parseArgs(process.argv.slice(2));

  // 读取 zip 文件 / Read the zip file.
  let absZipPath;
  try {
    absZipPath = path.resolve(process.cwd(), zipPath);
    if (!fs.existsSync(absZipPath)) {
      fail(`找不到 zip 文件 / ZIP not found: ${absZipPath}`);
    }
  } catch (err) {
    fail(`读取 zip 路径出错 / Failed to resolve zip path: ${err}`);
    return;
  }

  const zipBuffer = fs.readFileSync(absZipPath);
  const zipBytes = zipBuffer.length;
  const base64 = zipBuffer.toString('base64');
  const base64Bytes = base64.length; // base64 全为 ASCII，字节数即字符串长度

  // 打印摘要 / Print summary.
  log('[deploy-tts-proxy] ------------------------------------------------');
  log(`  functionName : ${FUNCTION_NAME}`);
  log(`  region       : ${REGION}`);
  log(`  zip path     : ${absZipPath}`);
  log(`  zip size     : ${formatBytes(zipBytes)}`);
  log(`  base64 size  : ${formatBytes(base64Bytes)} (limit ${formatBytes(MAX_BASE64_BYTES)})`);

  // 断言 base64 不超过 50MB / Assert base64 does not exceed 50MB.
  if (base64Bytes > MAX_BASE64_BYTES) {
    fail(
      `base64 超出 50MB 限制 / base64 exceeds 50MB limit.\n` +
        `当前 / current: ${base64Bytes} bytes, 上限 / limit: ${MAX_BASE64_BYTES} bytes.\n` +
        `请改用 OSS 中转或精简依赖（如剔除 node_modules 中无关内容）。`
    );
    return;
  }
  log(`  => base64 在 50MB 限制内 / within 50MB limit: OK`);

  if (dryRun) {
    log('[deploy-tts-proxy] DRY-RUN：未发起真实请求（未使用 AK）。/ no network request made.');
    log('[deploy-tts-proxy] ------------------------------------------------');
    process.exit(0);
  }

  // 真实部署 / Real deploy.
  log('[deploy-tts-proxy] ------------------------------------------------');
  await deploy(absZipPath, zipBuffer);
}

main().catch((err) => {
  fail(`未捕获异常 / Uncaught error: ${err && err.stack ? err.stack : err}`);
});
