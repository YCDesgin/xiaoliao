# 虾聊 · 阿里云语音合成代理（云端 TTS）

让虾聊的 AI 英文语音走**阿里云智能语音交互（TTS）**——自然神经语音、国内可直连、
华为手机也能出声。代理零依赖（纯 Node.js 内置模块），直接用阿里云函数计算（FC）
控制台粘贴部署，无需本地 npm。

---

## 一、准备阿里云账号与密钥（需你本人操作）

1. **注册并实名**阿里云：https://www.aliyun.com （国内用户，实名认证后可用）。
2. **开通「智能语音交互」**：
   进入 https://nls-portal.console.aliyun.com/applist
   → 创建项目 → 记下 **AppKey**（页面上叫"项目 Appkey"）。
   > 新用户有试用额度，英文神经语音 `cally` 等通常包含在免费/低成本额度内。
3. **创建 AccessKey**（代理用它换 Token）：
   - 主账号：https://usercenter.console.aliyun.com/#/manage/ak
   - 或 RAM 用户：需授予「智能语音交互」相关权限（如 `AliyunNLSFullAccess`）。
   - 记下 **AccessKeyId** 和 **AccessKeySecret**。
4. 确认项目地域为 **cn-shanghai**（默认）。若选了其他地域，部署时改 `ALIYUN_REGION`。

---

## 二、部署到函数计算（FC）

1. 打开 https://fc.console.aliyun.com → 选择/创建**服务**（地域选 **华东2（上海）**，
   与 AppKey 地域一致）。
2. 创建**函数**：
   - 创建方式：**使用内置运行时创建**（"事件函数"或"HTTP 函数"均可）。
   - 运行环境：**Node.js 18 或 20**。
   - 函数代码：选「在线编辑 / 代码编辑器」，**把 `index.js` 内容整段粘贴**进去
     （本目录的 `index.js`）。处理函数名填 `index.handler`。
   - **不要绑定 VPC**（保持默认"无"），这样函数才能访问公网 `nls-gateway` 域名。
3. 配置 **HTTP 触发器**：
   - 认证方式：**匿名访问**（否则浏览器会被拦）。
   - 请求方法：勾选 **GET**（顺便勾 OPTIONS 也行，代码已处理预检）。
   - 触发器创建后会给出一个 URL，形如：
     `https://<accountId>.<region>.fc.aliyuncs.com/<service>/<function>/`
4. 配置**环境变量**（函数配置 → 环境变量）：
   | 键 | 值 |
   |----|----|
   | `ALIYUN_ACCESS_KEY_ID` | 你的 AccessKeyId |
   | `ALIYUN_ACCESS_KEY_SECRET` | 你的 AccessKeySecret |
   | `ALIYUN_APPKEY` | 项目 AppKey |
   | `DEFAULT_VOICE` | 可选，默认 `cally`（美式女声·口语）。可改 `abby`/`andy`/`harry`/`eric` |
   | `ALIYUN_REGION` | 可选，默认 `cn-shanghai` |
   > 密钥只存在 FC 环境变量里，不会进代码仓库，安全。
5. 保存并**部署/发布**。

---

## 三、接入虾聊

1. 复制上面 HTTP 触发器的完整 URL（例如 `https://abc123.cn-shanghai.fc.aliyuncs.com/xiaoliao-tts/`）。
2. 打开虾聊 App → **设置** → 「云端 TTS 地址」粘贴进去 → 保存。
   > 由于 app 已改为"配了云端地址就优先走云端"，保存后即生效；无需切换模式。
   > （若想临时退回浏览器语音，把该地址清空即可。）
3. **手机/电脑强刷**页面 → 发消息测试 → 应听到自然英文发音。

---

## 四、接口说明（兼容原 Cloudflare Worker）

- `GET /tts?text=<文本>&voice=<发音人>&rate=<±N%>`
  - 返回 `audio/mpeg` 二进制（多段自动拼接）。
  - `voice` 仅接受 `cally/abby/andy/harry/eric`，其余忽略用默认 `DEFAULT_VOICE`。
  - `rate` 用相对百分比（如 `-25%` ≈ 0.75 倍速），自动换算为阿里云语速。
  - 文本超过 300 字符会自动按词切分后拼接。
- `GET /voices` → 返回可用英文发音人 JSON 列表。

## 五、排错

- **返回 500 JSON**：看 `error` 字段。
  - `Token 为空 / CreateToken HTTP 4xx` → AccessKey 错误或缺少 NLS 权限。
  - 含 `voice` / `Invalid` → `DEFAULT_VOICE` 或传入的 voice 不被支持，改环境变量。
  - `CLIENT_ERROR` / 超时 → 检查函数是否绑定了 VPC（应"无"），或网络出口。
- **虾聊仍走浏览器语音**：确认「云端 TTS 地址」已正确填写且以保存；发消息时看
  Console 是否有 `[XiaLiao TTS]` 报错（代理地址不可达会回退浏览器并提示）。
