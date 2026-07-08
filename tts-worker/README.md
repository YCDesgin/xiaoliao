# 虾聊云端 TTS Worker（Cloudflare）

把微软 Edge-TTS 在线语音合成代理出来，让公网部署（GitHub Pages）下、尤其是国产
Android 手机（无 GMS、浏览器无英文语音引擎）也能听到 AI 的英文语音。

- 免费、无需 API Key
- 纯 Cloudflare Worker 原生 WebSocket 实现，不依赖任何 npm 包
- `GET /tts?text=...&voice=...&rate=...` 返回 `audio/mpeg` 语音流
- `GET /voices` 返回常用英文 Neural 嗓音列表（JSON）

## 部署步骤

1. 安装 wrangler（推荐用 npx，无需全局安装）：
   ```
   npm i -g wrangler
   ```
   或者直接每次用 `npx wrangler`。

2. 登录 Cloudflare 账号（会打开浏览器授权）：
   ```
   npx wrangler login
   ```

3. 进入本目录：
   ```
   cd tts-worker
   ```

4. 部署：
   ```
   npx wrangler deploy
   ```

5. 部署成功后终端会给出地址，形如：
   ```
   https://xiaoliao-tts.<你的子域名>.workers.dev
   ```

6. 打开虾聊 App → 设置 → 把上面的地址填入「云端 TTS 地址」，保存即可。
   之后 AI 回复会用云端语音播放，手机也能听到。

## 本地调试（可选）

```
npx wrangler dev
```
然后访问 `http://127.0.0.1:8787/voices` 或
`http://127.0.0.1:8787/tts?text=hello&voice=en-US-JennyNeural`。
