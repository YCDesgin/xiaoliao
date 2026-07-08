# 虾聊（XiaLiao）部署到 GitHub Pages 步骤手册

本文档帮助你在 **GitHub Pages** 上部署虾聊英语口语 Web App，使其可以通过公网链接（例如微信里）打开使用。

> 默认假设：你新建的 GitHub 仓库名为 **`xiaoliao`**，GitHub 用户名为 `ycdesgin`，最终访问地址为：
> **https://ycdesgin.github.io/xiaoliao/**
>
> 若想部署到其他路径，请见文末「更换部署路径」一节。

---

## 前提

- 你已拥有 GitHub 账号 `ycdesgin`（页面 `ycdesgin.github.io` 已开启或准备开启 Pages）。
- 本机已安装 Git 与 Node.js（建议 Node 22+）。
- 本目录（speakup-app）即为虾聊的前端源码（Vite + React + Tailwind）。

---

## 步骤 1：在 GitHub 新建仓库

1. 登录 GitHub，点击右上角 **New repository**（新建仓库）。
2. **Repository name** 填写：`xiaoliao`
3. 可见性选择 **Public**（GitHub Pages 免费版要求公开仓库）。
4. 不要勾选 "Add a README file"（我们稍后会用本目录代码初始化）。
5. 点击 **Create repository**。

---

## 步骤 2：把本目录代码推送到仓库的 `main` 分支

在 **speakup-app 目录**下打开终端，依次执行：

```bash
# 初始化 git（若本目录已有 .git 可跳过这一句）
git init

# 关联远程仓库（替换为你自己的仓库地址，用户名 ycdesgin）
git remote add origin https://github.com/ycdesgin/xiaoliao.git

# 添加所有文件（node_modules 与 dist 已被 .gitignore 忽略）
git add .

# 提交
git commit -m "init: 虾聊 XiaLiao 初始版本"

# 推送到 main 分支（-u 设置上游，之后直接 git push 即可）
git push -u origin main
```

> ⚠️ 提示：`node_modules` 和 `dist` 已被根目录的 `.gitignore` 忽略，不会被提交。
> 若你的 `.gitignore` 缺失，请至少包含以下内容：
>
> ```gitignore
> node_modules
> dist
> ```

---

## 步骤 3：开启 GitHub Pages（使用 Actions 部署）

1. 进入仓库 `xiaoliao` 的 **Settings**（设置）。
2. 左侧选择 **Pages**。
3. **Source（源）** 选择：**GitHub Actions**。
4. 保存即可（无需再选分支，部署由 Actions 完成）。

---

## 步骤 4：等待自动构建部署

- 推送 `main` 分支后，GitHub Actions 会自动执行「Deploy to GitHub Pages」工作流。
- 在仓库 **Actions** 标签页可查看进度，通常需要约 **1 分钟**。
- 部署成功后，访问：

  **https://ycdesgin.github.io/xiaoliao/**

---

## 步骤 5：在微信中使用

- 在微信聊天里直接发送或打开上面的链接，即可访问虾聊。
- **文字版完全可用**：文字聊天、图片、复盘、翻译等功能正常。
- ⚠️ **已知限制（公网/微信环境）**：
  - **语音录入**（浏览器语音识别）在微信内置浏览器中通常不可用。
  - **Edge-TTS 本地朗读服务**（`edge_tts_server.py`）是本地服务，公网/微信环境下无法访问。
  - 以上两项属于已知限制；纯**文字聊天**不受影响，可正常使用。

---

## 安全提醒（非常重要）

当前版本中，DeepSeek API Key 以**前端明文**形式存储在浏览器 `localStorage` 中：

- 部署到公网后，**任何人按 F12 打开开发者工具都能看到你的 Key**。
- 你已知此风险并选择「暂明文 + 小额度试水」。

建议：

1. **使用一个额度较小的、独立的 DeepSeek Key**，不要把主账号的大额 Key 暴露在前端。
2. 日后如需更安全的方案，可在前端与 DeepSeek 之间加一层 **Serverless 代理**（如 Cloudflare Workers / Vercel Functions），由代理持有 Key，前端只调用代理。

> 注意：本文档及部署配置**未改动** Key 的读取逻辑——应用仍从 `localStorage` 读取 Key，保持与原本地版本一致。

---

## 更换部署路径（如适用）

部署路径由 `vite.config.js` 中的 `base` 与 GitHub 仓库名共同决定。若你想换位置，只需改这两处：

### 情况 A：放到已有仓库 `yichuan-portfolio` 下的子路径 `/xialiao/`

1. 把代码推到 `yichuan-portfolio` 仓库的 `main` 分支。
2. 修改 `vite.config.js`：

   ```js
   base: process.env.GITHUB_PAGES === 'true' ? '/xialiao/' : '/',
   ```

3. 最终访问地址变为：`https://ycdesgin.github.io/yichuan-portfolio/xialiao/`

### 情况 B：用作**用户主页**（即 `ycdesgin.github.io` 根路径）

1. 新建仓库，仓库名必须为 **`ycdesgin.github.io`**。
2. 修改 `vite.config.js`（base 设为根路径 `/`）：

   ```js
   base: process.env.GITHUB_PAGES === 'true' ? '/' : '/',
   ```

3. 最终访问地址直接为：`https://ycdesgin.github.io/`

> 无论哪种情况，只要在 CI 构建时设置环境变量 `GITHUB_PAGES=true`，`base` 即会生效；本地 `npm run dev` / `npm run build` 默认仍为 `/`，不受影响。

---

## 本地预览已构建产物

想先在本地看看「部署后样子」（带 `/xiaoliao/` 前缀路径）：

```bash
# 方式一：用 vite preview（默认 base 为本地构建时的 base）
GITHUB_PAGES=true npm run build && npx vite preview --base=/xiaoliao/

# 方式二：仅预览（使用当前 dist，需先按上面方式构建）
npm run preview
```

---

## 附：本次部署相关改动清单

- `vite.config.js`：新增 `base`，通过环境变量 `GITHUB_PAGES` 切换（部署时 `/xiaoliao/`，本地 `/`）。
- `.github/workflows/deploy.yml`：新增 GitHub Actions 工作流，push 到 `main` 自动构建并部署到 GitHub Pages。
- 本文件 `DEPLOY.md`：部署步骤手册。
- 未改动任何业务逻辑、`speakup_*` localStorage Key、产品名「虾聊」或 API Key 读取逻辑。
