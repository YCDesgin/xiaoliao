# 虾聊 · CosyVoice 逼真 TTS 部署与运维手册（功能2）

> 适用对象：虾聊（speakup-app）维护者 / 运维。
> 关联代码：`aliyun-tts-proxy/index.js`（阿里云函数计算 FC 代理）。
> 设计依据：架构文档 `docs/tts-architecture-2026-07-11.md`（功能2：更逼真的 TTS）。

---

## 1. 目标与现状

- **现状**：虾聊云端 TTS 走阿里云 **NLS** 语音合成，发音自然度一般（神经语音但偏"播音腔"）。
- **目标**：切换到阿里云百炼 **CosyVoice**（cosyvoice-v3-flash），发音更逼真、更接近真人，提升口语陪练沉浸感。
- **策略**：**双 provider 共存 + 优雅兜底**。默认仍走 NLS（生产稳定），通过设置环境变量 `TTS_PROVIDER=cosyvoice` 切换到 CosyVoice；CosyVoice 调用失败时，若已配置阿里云 AK，则**自动回退 NLS**，保证不中断服务。

## 2. 前端改动（零新增依赖）

前端**无需任何代码改动**即可上线 CosyVoice——所有切换发生在云端代理侧：

- 前端只把阿里云发音人名（`cally`/`abby`/`andy`/`harry`/`eric`）传给云端代理；
- `getCloudTtsUrl()` / `useCloud()` 等入口完全不变；
- 真正的 CosyVoice 音色 id 由代理侧 `COSYVOICE_VOICE_MAP` 映射（初值占位 `''`，待用户在百炼试听后填真实 id）；
- 单词 🔊（`speakWord`）默认走浏览器 `speechSynthesis`，运营可在前端 localStorage 设置 `speakup_word_tts_provider=cosyvoice` 切到 CosyVoice（失败自动回退浏览器，不静音）。

## 3. 阿里云侧前置准备

### 3.1 开通百炼 CosyVoice

1. 登录【阿里云百炼控制台】→ 模型服务 → 语音合成 → CosyVoice（或「CosyVoice v3」）。
2. 确认模型 `cosyvoice-v3-flash` 已开通（若实际是 v2，请同步把 `aliyun-tts-proxy/index.js` 与 `src/data/voices.js` 的 `COSYVOICE_MODEL` 改为 `cosyvoice-v2`，**v3 与 v2 音色名不通用**）。
3. 在【API-KEY 管理】创建 **DashScope API Key**（`sk-...`），下一步要用。

### 3.2 试听并取 CosyVoice 音色 id（可选但推荐）

- 在百炼控制台用同一个发音人描述（如「温柔女声 / 美式」「沉稳男声」）试听，记录下每个发音人对应的 **CosyVoice voice id**（形如 `cosyvoice-xxxx-xxxx`）。
- 若暂未取得，可先不填 id（占位 `''`），此时模型使用默认音色，仍能正常合成，只是 5 个发音人音色一致；后续填上即可逐一区分。

### 3.3 保留 NLS 兜底所需配置（已有，勿删）

以下功能2 兜底回退 NLS 依赖既有配置，保持原样即可：

| 环境变量 | 说明 |
| --- | --- |
| `ALIYUN_REGION` | NLS 区域，默认 `cn-shanghai` |
| `ALIYUN_APPKEY` | NLS AppKey |
| `ALIYUN_ACCESS_KEY_ID` | 阿里云 AK ID |
| `ALIYUN_ACCESS_KEY_SECRET` | 阿里云 AK Secret |

## 4. 部署 / 更新 FC 函数（aliyun-tts-proxy）

### 4.1 准备部署包

```bash
cd aliyun-tts-proxy
# 仅 ASR 转码需要 ffmpeg-static；TTS/CosyVoice 零额外依赖
npm install   # 安装 ffmpeg-static（可选，仅当你要用语音输入 ASR）
```

部署目录需包含：`index.js`（已含 CosyVoice 逻辑）、`package.json`。
**无需** 安装 `@alicloud/dashscope`——CosyVoice 直调 DashScope HTTP API，仅用 Node 内置 `https`，零额外依赖。

### 4.2 上传到函数计算

- 方式 A（控制台）：把 `index.js` + `package.json` 打包（如需 ASR 一并包含 `node_modules/ffmpeg-static`）→ 函数计算控制台「上传代码」→ 运行时选 **Node.js 18/20** → 请求处理程序填 `index.handler`。
- 方式 B（Serverless Devs / fun）：`s deploy` 即可，handler 同 `index.handler`。
- HTTP 触发器：创建「HTTP 触发器」拿到公网 URL，填到虾聊设置 → 云端 TTS 地址。

### 4.3 配置环境变量（关键）

在函数计算「环境变量」中设置：

| 变量名 | 值 | 说明 |
| --- | --- | --- |
| `TTS_PROVIDER` | `cosyvoice` | **开启** CosyVoice；留空 / `nls` 则走原 NLS |
| `DASHSCOPE_API_KEY` | `sk-xxxxxxxx` | 3.1 创建的百炼 API Key |
| `COSYVOICE_MODEL` | `cosyvoice-v3-flash` | 与 3.1 开通模型一致；v2 则改 v2 |
| `COSYVOICE_VOICE_MAP` | 见下 | 可选，整体覆盖音色映射 |

`COSYVOICE_VOICE_MAP` 示例（JSON 字符串，仅填你试听过的 id，其余留空）：

```json
{"cally":"<cally 的 cosyvoice id>","abby":"","andy":"","harry":"","eric":""}
```

> 未填的音色 id 保持 `''`，命中时模型用默认音色（不会报错）。

> NLS 兜底变量 `ALIYUN_APPKEY` / `ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET` / `ALIYUN_REGION` 保持原有配置（CosyVoice 失败回退 NLS 时需要）。

### 4.4 验证

函数上线后，用浏览器或 curl 验证：

```bash
# 1) 健康/调试：返回 event 结构（确认触发器可达）
curl "https://<你的FC域名>/?__debug=1"

# 2) 合成一句话（CosyVoice 应返回 audio/mpeg 二进制）
curl -o /tmp/tts.mp3 "https://<你的FC域名>/?text=Hello%20nice%20to%20meet%20you&voice=cally"
file /tmp/tts.mp3        # 应为 MPEG audio / Audio file
```

- 听到更逼真发音 = 成功。
- 若 `DASHSCOPE_API_KEY` 未配或 CosyVoice 报错，且 NLS 变量齐全，应自动回退为 NLS 发音（日志含 `[CosyVoice 失败，回退 NLS]`）。

## 5. 回滚

- 临时关闭 CosyVoice：把环境变量 `TTS_PROVIDER` 改回 `nls`（或直接删除该变量）→ 重新部署/生效，立即切回 NLS，无需改前端。
- 长期回退：前端 `speakup_word_tts_provider` 保持默认 `browser`（单词 🔊 走浏览器），句子 TTS 由 `TTS_PROVIDER` 控制。

## 6. 常见排查

| 现象 | 可能原因 / 处置 |
| --- | --- |
| 仍是"播音腔"（没变逼真） | `TTS_PROVIDER` 未设为 `cosyvoice`；或函数未重新部署生效。检查日志是否走到 `synthesizeCosyVoice`。 |
| 完全没声音 / 500 | `DASHSCOPE_API_KEY` 缺失或错误 → CosyVoice 抛错；若同时未配 NLS AK 则无法兜底。补 AK 或回退 `TTS_PROVIDER=nls`。 |
| 5 个发音人音色一样 | `COSYVOICE_VOICE_MAP` 全是 `''`（未填真实 id），模型用默认音色。去百炼试听后填 id。 |
| 报 `cosyvoice-v3-flash` 不存在 | 你实际开通的是 v2。把 `COSYVOICE_MODEL` 与前端 `COSYVOICE_MODEL` 一同改为 `cosyvoice-v2`，并重新部署 FC。 |
| 语音输入（ASR）报错 | 仅影响 ASR，与 TTS 无关；确认 `ffmpeg-static` 已随部署包安装、`ALIYUN_*` NLS 变量齐全。 |

## 7. 单测（代理侧）

代理目录提供 Node 原生测试（无需 ffmpeg-static）：

```bash
cd aliyun-tts-proxy
node --test index.test.cjs
```

覆盖：`buildCosyVoicePayload` 请求体结构 / 映射缺失回退默认 / 语速 clamp；
`extractCosyVoiceAudio` 非流式与流式解析 / 失败码抛错；`TTS_PROVIDER` 默认 `nls`。

## 8. 源码与文档索引

- 代理实现：`aliyun-tts-proxy/index.js`（含 `buildCosyVoicePayload` / `extractCosyVoiceAudio` / `synthesizeCosyVoice` 导出，供单测）
- 前端音色映射：`src/data/voices.js`（`ALIYUN_VOICE_OPTIONS[].cosyVoiceId`、`getCosyVoiceId`、`COSYVOICE_MODEL`）
- 前端单词朗读入口：`src/services/speech.js`（`speakWord` / `getWordTtsProvider` / `setWordTtsProvider`）
- 架构设计：`docs/tts-architecture-2026-07-11.md`
