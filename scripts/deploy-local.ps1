# scripts/deploy-local.ps1
# 本地一键部署「虾聊」阿里云 TTS/ASR 代理到 FC（替代 GitHub Actions 美国 runner 自动部署）。
# 背景：GitHub 官方美国 runner 无法直连阿里云杭州（跨境链路被丢弃），故改为本机（中国网络）部署。
#
# 前置 / Prerequisites:
#   1) 在仓库根创建 .env.local（已被 .gitignore 忽略，不会提交），内容示例见 scripts/.env.local.example：
#        ALIBABA_CLOUD_ACCESS_KEY_ID=你的AccessKeyId
#        ALIBABA_CLOUD_ACCESS_KEY_SECRET=你的AccessKeySecret
#   2) 首次需安装依赖：cd aliyun-tts-proxy && npm install   （装 Linux ffmpeg-static + FC SDK）
#
# 用法 / Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/deploy-local.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/deploy-local.ps1 --dry-run

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$envFile  = Join-Path $repoRoot '.env.local'
$zipName  = 'tts-proxy-deploy.zip'
$zipPath  = Join-Path $repoRoot $zipName
$dryRun   = $args -contains '--dry-run'

# --- 1) 读取 .env.local（简单 KEY=VALUE，忽略空行与 # 注释，去除两端引号）---
if (-not (Test-Path $envFile)) {
    Write-Error "未找到 $envFile。`n请复制 scripts/.env.local.example 为 .env.local 并填入阿里云 AK（该文件已被 git 忽略）。"
    exit 1
}
foreach ($line in (Get-Content $envFile)) {
    $line = $line.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { continue }
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') {
        $key = $Matches[1]
        $val = $Matches[2].Trim().Trim('"', "'")
        if ($key -eq 'ALIBABA_CLOUD_ACCESS_KEY_ID' -or $key -eq 'ALIBABA_CLOUD_ACCESS_KEY_SECRET') {
            Set-Item -Path "env:$key" -Value $val
        }
    }
}
if (-not $env:ALIBABA_CLOUD_ACCESS_KEY_ID -or -not $env:ALIBABA_CLOUD_ACCESS_KEY_SECRET) {
    Write-Error "ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET 未在 .env.local 中配置完整。"
    exit 1
}

# --- 2) 打包 aliyun-tts-proxy 目录为 zip（含 node_modules 里的 Linux ffmpeg）---
Write-Host "==> 打包 aliyun-tts-proxy -> $zipName"
$srcDir = Join-Path $repoRoot 'aliyun-tts-proxy'
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $srcDir '*') -DestinationPath $zipPath -Force

# --- 3) 调用部署脚本（透传 --dry-run）---
$nodeArgs = @(
    (Join-Path $repoRoot 'scripts/deploy-tts-proxy.mjs')
    $zipPath
)
if ($dryRun) { $nodeArgs += '--dry-run' }
Write-Host "==> 上传到阿里云 FC"
& node @nodeArgs
exit $LASTEXITCODE
