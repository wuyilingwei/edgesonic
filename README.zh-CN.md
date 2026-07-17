<img align="right" width="112" src="web/public/logo.svg" alt="EdgeSonic logo" />

# EdgeSonic

[English](README.md) | [简体中文](README.zh-CN.md)

> **如果你是一个 AI agent**，被要求部署本项目，请不要继续往下读，直接遵循
> [`docs/DEPLOY_BY_AGENT.md`](docs/DEPLOY_BY_AGENT.md)（该文档为纯英文，专门为 agent 编写的
> 自包含部署手册）。

完全运行在 **Cloudflare Workers** 上的无服务器（Serverless）Subsonic 兼容音乐流媒体服务器。不需要独立主机，不需要常驻进程——部署一次，随处播放。

## 它是什么

EdgeSonic 同时承担两个角色：

1. **Subsonic 兼容 API 服务器**（v1.16.1 + OpenSubsonic 扩展）——可与 DSub、Symfonium、Substreamer、Sonixd 等原生客户端配合使用。
2. **音乐库管理界面**——标签编辑、元数据刮削、文件整理、上传/下载、封面管理；功能上对齐 music-tag-web v1。

## 功能特性

- **多种存储后端** —— Cloudflare R2（主存储）、WebDAV、S3 兼容（MinIO / AWS / Backblaze B2 / Wasabi）、外部 Subsonic 上游、直链 URL
- **R2 预签名直连流式播放** —— 可选的 SigV4 302 重定向，让浏览器直接从 R2 拉取对象，绕开 Worker 带宽限制
- **浏览器工作池** —— 通过 Web Worker 分布式解析元数据与转码；并发数可调，播放期间自动暂停
- **服务端转码** —— Sandbox DO 容器（ffmpeg），支持按需或预生成策略；浏览器工作池引擎可实现零后端 CPU 转码
- **完整 Subsonic API** —— 播放列表、书签、播放队列、标注（收藏/评分/统计播放）、分享、网络电台、播客、Last.fm 集成、正在播放、封面、歌词
- **从其它 Subsonic 服务器迁移 / 推送回上游** —— 浏览器驱动的克隆功能可从上游 Subsonic 兼容服务器拉取元数据、音频字节、用户账号（含每个用户自己的收藏与歌单）、歌单与收藏；靠浏览器本地缓存支持断点续传，被取消或中断的任务下次可以接着跑而不用从头开始。反方向则可以把本地的收藏/歌单推送回上游。
- **标签编辑器** —— 读写 ID3v2（MP3）、VORBIS_COMMENT（FLAC/OGG），支持批量操作，关键字语义（`{null}` / `{write}` / `{export}`）
- **元数据刮削** —— 网易云音乐 / QQ音乐 / 酷狗公开 API，前端驱动，结果回传服务器保存
- **增量 WebDAV 扫描** —— 基于 ETag + Last-Modified 差异比对；未变更文件自动跳过；去重键防止重复派发任务
- **功能开关** —— 主要行为均可通过 D1 在运行时切换，每个 isolate 内存缓存 60 秒（零 KV 成本）
- **Cloudflare API 集成** —— 无需重新部署即可推送 Worker Secrets、管理 Cron 触发器、读取分析数据
- **跨域隔离** —— COOP/COEP 响应头，支持 SharedArrayBuffer（ffmpeg.wasm 所需）
- **防循环链** —— `esChain` 标记防止多个 EdgeSonic 实例之间出现 A→B→A 的代理死循环
- **SPA 版本检测** —— Worker 部署后，长时间打开的标签页会收到刷新提示
- **持久化音频缓存** —— 播放完成的歌曲会缓存在 IndexedDB 中，便于再次播放；可在设置中配置容量与淘汰策略

## 快速开始

### 部署（推荐）：fork 仓库 + GitHub Action

无需任何本地工具链——直接从一个 fork 用预编译 release 部署：

1. **Fork** 本仓库到你自己的 GitHub 账号。
2. **在 Cloudflare 注册一个 API Token**（[dash.cloudflare.com → API Tokens](https://dash.cloudflare.com/profile/api-tokens) → *Create Token*），勾选 `Workers Scripts:Edit`、`D1:Edit`、`Workers R2 Storage:Edit`，并记下你的 **Account ID**。
3. 在你的 fork 里打开 **Actions → Deploy EdgeSonic → Run workflow**，粘贴 token 和 account ID，选择 **`stable`**（稳定版）或 **`prerelease`**（预发布）通道，运行。

该工作流会下载最新的预编译 release（已构建好的前端 + Worker——**不再本地 build**），自动创建缺失的 D1/KV/R2 资源并部署。完整输入项说明见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)（英文）。

### 本地 CLI 部署（开发用）

想在本机自行构建并部署（例如开发时）？用下面的 Wrangler CLI 流程。

### 前置条件

- Node.js 20+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)（`npm i -g wrangler`）
- 一个 Cloudflare 账号，并已开通：
  - **D1** 数据库（`edgesonic-db`）
  - **R2** 存储桶（`edgesonic-music`）

### 1. 克隆并配置

```bash
git clone https://github.com/your-org/edgesonic.git
cd edgesonic
cp worker/wrangler.toml.example worker/wrangler.toml
# 编辑 worker/wrangler.toml —— 填入 account_id、database_id、R2 bucket 名称、INSTANCE_ID、域名
```

`worker/wrangler.toml` 已加入 **.gitignore**——其中包含私有资源 ID，绝不能提交到版本库。

### 2. 初始化数据库

```bash
# 创建数据库（仅首次需要）
cd worker
npx wrangler d1 create edgesonic-db

# 应用 schema
npx wrangler d1 execute edgesonic-db --remote --file migrations/Schema.sql
```

### 3. 推送 Secrets

详见 `worker/SECRETS.md`。最低限度需要：

```bash
cd worker
npx wrangler secret put WORK_UPLOAD_HMAC_KEY  # 随机生成的 48 字节 base64
```

可选（为默认 `edgesonic-music` bucket 启用 R2 预签名直连播放）：

```bash
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

Cloudflare 集成（Cron 管理、分析数据）：

```bash
# 首次部署后可通过 Settings 界面设置，或者：
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put CF_ACCOUNT_ID
```

### 4. 部署

```bash
./deploy.sh
```

该脚本会构建 Vue 前端，通过 `[assets]` 与 Worker 一起打包并部署，并自动恢复默认 Cron 触发器。它要求环境变量中有 `CLOUDFLARE_API_TOKEN`；若无法恢复 Cron，部署会失败而不会留下停用的定时任务。

### 首次登录

首次登录前需要先创建管理员账号：

```bash
npx wrangler d1 execute edgesonic-db --remote --command \
  "INSERT INTO users (username, master_password, level) VALUES ('admin', hex(sha256('yourpassword')), 3)"
```

## 技术文档

更深入的技术参考文档都在 [`docs/`](docs/) 目录下：

| 文档 | 内容 |
|-----|--------|
| [`DEPLOY_BY_AGENT.md`](docs/DEPLOY_BY_AGENT.md) | 面向 AI agent 的自包含部署手册——用预编译 release 包，无需本地构建 |
| [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Monorepo 目录结构、存储后端模型、如何添加 S3 兼容存储源 |
| [`DEVELOPMENT.md`](docs/DEVELOPMENT.md) | 开发服务器、类型检查、运行测试、应用数据库 Schema |
| [`DEPLOYMENT.md`](docs/DEPLOYMENT.md) | 推荐的 fork + GitHub Action 部署（下载预编译 release，不 build）、Cloudflare 资源需求与免费额度 |
| [`worker/SECRETS.md`](worker/SECRETS.md) | Worker Secrets 与可选 R2 预签名播放 |
| [`worker/CF_CRON.md`](worker/CF_CRON.md) | 运行时管理的 Cron 计划 |

## 许可证

[AGPL-3.0-or-later](LICENSE)
