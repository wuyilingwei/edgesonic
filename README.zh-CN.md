# EdgeSonic

[English](README.md) | [简体中文](README.zh-CN.md)

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

## Monorepo 结构

```
edgesonic/
├── worker/               # Cloudflare Worker（Hono + TypeScript）
│   ├── src/
│   │   ├── adapters/     # StorageAdapter 实现（r2 / webdav / s3 / subsonic / url）
│   │   ├── db/           # D1 查询辅助函数
│   │   ├── endpoints/    # 按 API 层级分组的路由处理器
│   │   │   ├── subsonic/ # Subsonic 协议端点（/rest/*）
│   │   │   ├── tag/      # 标签读/写/刮削（/tag/*）
│   │   │   ├── storage/  # 存储源与文件管理（/storage/*）
│   │   │   └── edgesonic/# 私有管理端点（/edgesonic/*）
│   │   ├── middleware/   # 鉴权、CORS、跨域隔离
│   │   ├── transcode/    # 转码引擎抽象（Sandbox / External / BrowserPool）
│   │   ├── utils/        # SigV4、标签读写、任务队列辅助函数等
│   │   └── index.ts      # Worker 入口
│   ├── migrations/
│   │   └── Schema.sql    # 单文件 schema（全新安装用）；同目录下还有每个版本的增量 .sql 文件
│   ├── wrangler.toml.example   # 脱敏模板 —— 复制为 wrangler.toml 后再填入实际 ID
│   └── SECRETS.md        # 需要设置哪些 Worker Secrets 及原因
│
├── web/                  # Vue 3 单页应用（Vite + Pinia + vue-i18n）
│   └── src/
│       ├── views/        # Dashboard / Library / Files / Sources / Settings 等页面
│       ├── stores/       # Pinia store（播放器、workerPool、更新提示条）
│       ├── workers/      # Web Worker（taskExecutor —— 元数据解析/转码）
│       ├── components/   # PlayerBar、UpdateBanner 等
│       └── locales/      # zh-CN / en 两套 i18n 文案
│
├── test/                 # 纯 tsx 测试脚本（worker）—— 每个文件自包含，需单独运行
├── docs/                 # DESIGN.md、cf-integration.md、external-transcoder.md
├── deploy.sh             # 手动部署脚本（wrangler CLI，不依赖 CF Git 集成）
└── package.json          # npm workspaces 根目录（worker + web）
```

## 存储后端

| 类型 | URI scheme | 扫描 | 播放 | 写入 |
|------|-----------|------|--------|-------|
| Cloudflare R2 | `r2://<key>` | —（直接上传） | ✅（代理或预签名 302） | ✅ |
| WebDAV | `webdav://<sourceId>/<path>` | ✅ PROPFIND | ✅（代理或预签名 302） | ✅ |
| S3 兼容 | `s3://<sourceId>/<key>` | ✅ ListObjectsV2 | ✅ SigV4 代理 | ✅ |
| Subsonic 上游 | `subsonic://<sourceId>/<id>` | ✅ | ✅ 代理 | ❌ |
| 直链 URL | `url://<url>` | — | ✅ | ❌ |

存储源的 `mode` 字段控制其在音乐库中的行为：
- `library`（默认）——扫描到的文件会被加入音乐库
- `sync_only` ——文件会被发现并同步，但不会加入音乐库（适合作为备份副本）

## 快速开始

### 前置条件

- Node.js 20+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)（`npm i -g wrangler`）
- 一个 Cloudflare 账号，并已开通：
  - **D1** 数据库（`edgesonic-db`）
  - **R2** 存储桶（`edgesonic-music`）
  - **KV** 命名空间（历史遗留绑定，仅为保持 schema 兼容而保留）

### 1. 克隆并配置

```bash
git clone https://github.com/your-org/edgesonic.git
cd edgesonic
cp worker/wrangler.toml.example worker/wrangler.toml
# 编辑 worker/wrangler.toml —— 填入 account_id、database_id、KV id、INSTANCE_ID、域名
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

可选（启用 R2 预签名直连播放）：

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

该脚本会构建 Vue 前端，通过 `[assets]` 与 Worker 一起打包并部署。部署完成后，记得恢复 Cron 触发器：

> **Settings → Cloudflare → "Ensure default cron"**

（`wrangler deploy` 会清空动态 Cron 计划——详见 `worker/CF_CRON.md`。）

### 5. 首次登录

访问你的 Worker 域名。默认管理员账号会在首次访问时创建——登录页会有说明，你也可以直接手动创建：

```bash
npx wrangler d1 execute edgesonic-db --remote --command \
  "INSERT INTO users (username, master_password, level) VALUES ('admin', hex(sha256('yourpassword')), 3)"
```

## CI/CD（GitHub Actions）

`.github/workflows/deploy.yml` 中的工作流是**纯手动触发**的（没有自动 push 触发器）。每次运行时所有凭据都作为工作流输入参数传入——仓库本身不存储任何凭据。

运行过程中，尚不存在的 D1 数据库、KV 命名空间、R2 存储桶会被**自动创建并绑定**。

### 如何部署

进入 **Actions → Deploy EdgeSonic → Run workflow**，填写：

| 输入项 | 是否必填 | 默认值 | 说明 |
|-------|----------|---------|-------------|
| `cf_api_token` | ✅ | — | CF API Token（需 Workers:Edit + D1:Edit + R2:Edit 权限） |
| `cf_account_id` | ✅ | — | Cloudflare 账号 ID |
| `worker_name` | 可选 | `edgesonic` | Worker 脚本名称 |
| `d1_database_name` | 可选 | `edgesonic-db` | D1 数据库（不存在则自动创建） |
| `kv_namespace_name` | 可选 | `edgesonic-kv` | KV 命名空间（不存在则自动创建） |
| `r2_bucket_name` | 可选 | `edgesonic-music` | R2 存储桶（不存在则自动创建） |
| `domain` | 可选 | — | 自定义域名；留空则使用 `<worker>.workers.dev` |
| `instance_id` | 可选 | — | 防循环用的 UUID；留空则自动生成 |

### 每次部署之后

> **Settings → Cloudflare → "Ensure default cron"**

`wrangler deploy` 会清空动态 Cron 计划。每次部署后请访问管理面板重新应用（详见 `worker/CF_CRON.md`）。

## 开发

```bash
npm install              # 安装所有 workspace 依赖

# 启动 worker 开发服务器（Miniflare + 本地 D1/R2）
npm run dev:worker

# 启动前端开发服务器（Vite HMR）
npm run dev:web

# worker 类型检查
npm run typecheck

# 运行单个 worker 测试（test/ 下每个文件都是自包含的，没有统一的测试运行器——
# 具体命令见每个 *.test.ts 文件顶部的 "Run:" 注释）
npx tsx test/subsonic/annotation.test.ts

# 运行全部测试文件
find test -name '*.test.ts' -exec npx tsx {} \;

# 前端类型检查
cd web && npx vue-tsc --noEmit
```

## 应用一次数据库迁移

```bash
./deploy.sh --migrate worker/migrations/0031_s3_source.sql
```

或者不做完整部署，只应用迁移：

```bash
cd worker
npx wrangler d1 execute edgesonic-db --remote --file migrations/0031_s3_source.sql
```

## 添加一个 S3 兼容存储源

1. 进入 **Settings → Storage Sources → Add Source**
2. 类型选择 **S3 Compatible**
3. 填写：
   - **Endpoint**：`https://s3.amazonaws.com`、`https://minio.example.com:9000`、`https://<account>.r2.cloudflarestorage.com` 等
   - **Access Key ID** / **Secret Access Key**：S3 凭据
   - **Bucket（根路径）**：存储桶名称，或 `bucket/prefix`
   - **Region**：AWS/MinIO 填 `us-east-1`；Cloudflare R2 填 `auto`
4. 保存后点击 **Scan** 扫描发现音乐文件

播放请求会通过 Worker 代理，并附带 SigV4 Authorization 请求头。统一使用 path-style URL（`{endpoint}/{bucket}/{key}`），可兼容包括 MinIO 在内的所有 S3 兼容实现。

## 安全注意事项

- `worker/wrangler.toml` —— **切勿提交**（包含私有资源 ID）
- `worker/.wrangler/` —— **切勿提交**（包含带真实数据的本地 Miniflare SQLite 状态）
- Secrets 一律通过 `wrangler secret put` 设置，不要写进 `wrangler.toml` 或源码
- 存储源密码（WebDAV / Subsonic）以明文形式存储在 D1 中——请使用数据库层面的访问控制，避免向不受信任的操作者暴露 D1 控制台
- 防循环链（`esChain`）防止多个 EdgeSonic 实例之间出现无限代理循环；链路深度上限由 `MAX_PROXY_DEPTH` 控制（默认 3）

## Cloudflare 资源需求

| 资源 | 用途 | 免费额度 |
|----------|---------|-----------|
| Workers | 运行时 | 每日 10 万次请求 |
| D1 | 数据库（全部状态） | 5 GB 存储，每日 2500 万次行读取 |
| R2 | 主要音乐存储 | 10 GB 存储，出站流量免费 |
| KV | 历史遗留绑定（已无实际读写） | — |

所有状态均仅存于 D1（KV 写入已在 090 号任务中移除）。功能开关、会话、API Key、限流、Last.fm 缓存、正在播放、Cron 时间戳等均存于 D1，并带有 60 秒的单 isolate 内存缓存。

## 许可证

[MIT](LICENSE)
