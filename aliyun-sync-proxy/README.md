# 虾聊同步代理 (aliyun-sync-proxy)

虾聊（speakup-app）「同步码跨端同步」的云端代理：基于阿里云 **函数计算 FC** + **对象存储 OSS**，
实现「文字聊天记录 + 复盘资料」的多端同步（语音二进制仅留本地，不同步）。

前端只做 `fetch`，不引入 `ali-oss`；所有鉴权与 OSS 读写都发生在这里。

---

## 1. 它做什么

- 按命名空间 `syncId`（来自同步码）组织数据，键形如 `syncId/contactId.json`。
- 双因子鉴权：每个读写请求都校验 `token`，`syncId/.meta.json` 存 `tokenHash = sha256(token)`。
- 首次 `put` 惰性创建命名空间并记录 token 哈希；`get`/`list` 在命名空间缺失时返回 `404`。
- CORS 开 `*`，与现有 `tts-proxy` 的代理头风格一致。

### API

| 操作 | 方法 | Query | 成功 | 失败 |
|---|---|---|---|---|
| 拉取某联系人 | GET | `action=sync&op=get&syncId&token&contact` | `200 {v,messages,reviews}` | `401 / 404` |
| 上传某联系人 | POST | `action=sync&op=put&syncId&token&contact`（body=JSON） | `200 {ok,updatedAt}` | `401 / 400` |
| 列出已同步联系人 | GET | `action=sync&op=list&syncId&token` | `200 {contacts:[...]}` | `401` |

---

## 2. 用户侧阿里云操作清单（AI 沙箱无法代劳）

> 以下都需要在阿里云控制台手动完成，本仓库不代填任何真实凭据。

### ① 建 OSS Bucket
1. 进入 **对象存储 OSS 控制台** → 创建 Bucket（如 `xiaoliao-sync`）。
2. 区域选 **cn-hangzhou**（与 FC 同区，延迟最低；也可选其他，但需与 `s.yaml` 的 `OSS_REGION` 一致）。
3. 存储类型「标准」，读写权限「私有」。

### ② RAM 授权
- 方案 A（推荐）：创建 **RAM 角色** 并授予该 Bucket 的
  `oss:GetObject / PutObject / ListObjects / DeleteObject`，再把该角色绑给 FC 服务。
  此时 `s.yaml` 里的 `OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET` 可留空（函数用角色 STS 临时凭证）。
- 方案 B：创建 **RAM 用户** 并授权上述 OSS 权限，把 `AccessKeyId / AccessKeySecret`
  填到 `s.yaml` 的 `environmentVariables`（建议放 FC 控制台的环境变量里，勿提交明文到仓库）。

### ③ 部署函数
准备 **Serverless Devs CLI (`s`)**：
```bash
# 安装（已装可跳过）
npm install @serverless-devs/s -g

# 在 aliyun-sync-proxy/ 目录
s config add            # 首次：配置阿里云账号
s deploy               # 部署（按 s.yaml）
```
部署成功后，FC 控制台「HTTP 触发器」会给出一个 URL，形如
`https://<random>.cn-hangzhou.fcapp.run`。

也可以不走 `s`，直接在 FC 控制台「创建函数 → 上传代码包（本目录 zip）」，
运行时选 **Node.js 20**，请求处理程序填 `index.handler`，并配置下面的环境变量：

- `OSS_REGION` = `oss-cn-hangzhou`（⚠️ 必须是带 `oss-` 前缀的规范写法，如 `oss-cn-hangzhou`；
  若误填 `cn-hangzhou`，新版 `index.js` 会自动补全前缀，但建议直接填规范值避免歧义）
- `OSS_BUCKET` = 你的 Bucket 名（如 `xiaoliao-sync`）
- `OSS_ACCESS_KEY_ID` = RAM 用户的 AccessKeyId
- `OSS_ACCESS_KEY_SECRET` = RAM 用户的 AccessKeySecret

### ④ 填代理地址到 App
把第 ③ 步拿到的触发器 URL 填入 App：
**设置 → 数据同步 → 同步代理地址**（存到 `localStorage['speakup_sync_proxy_url']`）。
不填则用代码里的默认占位符（不会真正发起请求）。

### ⑤ 运行参数建议
内存 **128MB+**，超时 **10s**，单实例并发 **1**（个人同步足够，避免并发写冲突）。

---

## 3. 本地联调（可选）

FC 代码是标准 Node.js，可用任意 HTTP 工具模拟请求：
```bash
# 生成一对 syncId/token（10 hex + 22 hex），假设：
SYNC_ID=0123456789
TOKEN=abcdef0123456789abcdef0123
PROXY=https://<your-fc>.cn-hangzhou.fcapp.run

# 上传
curl -X POST "$PROXY?action=sync&op=put&syncId=$SYNC_ID&token=$TOKEN&contact=alex" \
  -H 'Content-Type: application/json' \
  -d '{"v":1,"updatedAt":"2026-07-05T12:00:00.000Z","messages":[],"reviews":[]}'

# 拉取
curl "$PROXY?action=sync&op=get&syncId=$SYNC_ID&token=$TOKEN&contact=alex"
```

---

## 4. 目录说明

| 文件 | 说明 |
|---|---|
| `index.js` | FC `handler`：op=list/get/put + token 校验（`.meta.json`）+ OSS 读写 |
| `package.json` | 仅依赖 `ali-oss` |
| `s.yaml` | Serverless Devs 部署配置（含 `OSS_BUCKET/OSS_REGION` 与 RAM 角色） |
| `README.md` | 本文件 |

> 本函数与前端的 `src/services/syncConfig.js` 的契约（整码格式、API 参数、错误码）保持一致，
> 修改任意一侧前请对照 `docs/system_design.md` 的 §3.3。
