<div align="center">

# Metapi 重构版

**聚焦代理、路由与可观测性的自托管 AI API 聚合网关**

将 OpenAI、Claude、Gemini 兼容上游汇聚为统一入口，为下游客户端提供统一密钥、模型发现、智能路由和故障转移。

<p>
  <a href="https://github.com/yang208115/metapi"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-yang208115%2Fmetapi-181717?logo=github"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-brightgreen"></a>
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript">
</p>

<p>
  <strong>中文</strong> · <a href="README_EN.md">English</a> ·
  <a href="LICENSE">许可证</a>
</p>

</div>

> [!IMPORTANT]
> 本仓库是 [cita-777/metapi](https://github.com/cita-777/metapi) 的独立重构版，并非上游官方发行版。
> 两个项目的功能范围、数据库结构和部署产物已经不同；问题反馈请提交到[本仓库](https://github.com/yang208115/metapi/issues)。

## 为什么做这个重构版

上游项目覆盖大量平台适配、自动化和桌面端场景。本分支主动收缩边界，把维护重点放回一条更清晰的主链路：

```text
下游请求
  -> 协议入口与转换
  -> 路由候选与健康判定
  -> 上游执行、重试与故障转移
  -> 用量、成本、请求结果与运行日志
```

主要调整：

- 只保留 OpenAI、Claude、Gemini 三类协议适配器，减少平台特例。
- 移除签到、WebDAV、搜索/视频代理、桌面端和旧式账号 Token 管理等辅助功能。
- 将代理编排集中到 `src/server/proxy-core/`，路由文件只负责 HTTP 适配。
- 强化请求级遥测、运维指标、终端日志和数据库聚合，便于定位真实故障。
- 保留旧数据库中的部分历史字段与表，仅用于升级和导入兼容，不代表对应功能仍然可用。

如果需要上游完整功能或上游预构建镜像，请使用[原项目](https://github.com/cita-777/metapi)。

## 核心能力

### 统一代理

- OpenAI Chat Completions、Responses、Completions、Embeddings、Images、Files、Models 与 Rerank。
- Anthropic Messages 与 Token Count。
- Gemini 原生代理入口。
- SSE 流式传输与 OpenAI / Claude 协议转换。

### 模型与路由

- 从上游自动发现模型并生成路由。
- 支持精确匹配、模式路由、多通道优先级与概率分配。
- 综合成本、余额、用量和健康状态选择通道。
- 请求失败时自动重试、切换通道并进入冷却期。
- 为下游密钥配置模型范围、额度和路由策略。

### 账号与凭证

- 多站点、多连接管理。
- 支持 Session、API Key 和受支持提供商的 OAuth 凭证。
- 凭证加密存储；生产环境可使用独立的 `ACCOUNT_CREDENTIAL_SECRET`。
- 手动刷新余额、模型与连接状态。

### 运行观测

- 工作台展示请求量、成功率、TTFT、延迟、Token 和成本趋势。
- 请求日志记录每次代理尝试及最终请求结果。
- 系统日志通过受保护的管理接口实时展示服务端输出。
- SQLite / MySQL / PostgreSQL 共用同一套 Schema 合约和聚合口径。

## 快速开始

### 从源码运行

要求：Node.js 22 或更高版本。

```bash
git clone https://github.com/yang208115/metapi.git
cd metapi

cp .env.example .env
# 修改 .env，至少设置 AUTH_TOKEN、PROXY_TOKEN 和 ACCOUNT_CREDENTIAL_SECRET

npm ci
npm run db:migrate
npm run dev
```

开发服务启动后访问 `http://localhost:5173`；生产构建默认监听 `http://localhost:4000`。

### Docker Compose

本仓库不把上游 `1467078763/metapi` 镜像当作重构版发布物。Compose 默认从当前源码构建镜像：

```bash
git clone https://github.com/yang208115/metapi.git
cd metapi
cp .env.example .env

# 修改三个必需密钥；可用 openssl rand -hex 32 生成凭证加密密钥
docker compose --env-file .env -f docker/docker-compose.yml up -d --build
```

启动后访问 `http://localhost:4000`，使用 `AUTH_TOKEN` 登录后台。

> [!WARNING]
> 不要在公网环境使用示例密钥。`AUTH_TOKEN`、`PROXY_TOKEN` 与 `ACCOUNT_CREDENTIAL_SECRET` 应分别生成，且不要提交到 Git。

### 最小环境变量

| 变量 | 用途 |
| --- | --- |
| `AUTH_TOKEN` | 管理后台和 `/api/*` 的管理员令牌 |
| `PROXY_TOKEN` | 未配置独立下游密钥时的代理令牌 |
| `ACCOUNT_CREDENTIAL_SECRET` | 账号凭证加密密钥，建议使用 32 字节以上随机值 |
| `PORT` | 服务端口，默认 `4000` |
| `DATA_DIR` | SQLite、缓存和本地数据目录，默认 `./data` |
| `TZ` | 时区，默认 `Asia/Shanghai` |

MySQL、PostgreSQL、OAuth、通知与代理参数以 `.env.example`、`src/server/config.ts` 和运行时错误提示为准。

## 客户端接入

OpenAI 兼容客户端通常只需配置：

```text
Base URL: http://localhost:4000/v1
API Key:  <PROXY_TOKEN 或后台创建的下游密钥>
```

示例请求：

```bash
curl http://localhost:4000/v1/models \
  -H "Authorization: Bearer $PROXY_TOKEN"
```

## 项目结构

```text
src/
├── server/
│   ├── proxy-core/       # 代理编排、执行器、协议入口与请求遥测
│   ├── routes/           # Fastify API / 代理路由适配层
│   ├── services/         # 路由、账号、模型、日志和聚合服务
│   ├── transformers/     # OpenAI / Claude / Gemini 协议转换
│   └── db/               # Drizzle Schema 与跨数据库产物
├── web/                  # React 管理界面
scripts/
├── dev/                  # Schema、漂移检查与开发工具
└── tests/                # 关键架构和遥测测试
drizzle/                  # SQLite 迁移历史
```

更多约定见仓库根目录的 [AGENTS.md](AGENTS.md)。

## 开发与校验

项目交付链路以 `npm` 和 `package-lock.json` 为准。

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run repo:drift-check
git diff --check
```

数据库结构变更必须同时更新 Drizzle Schema、SQLite 迁移和已检入的跨数据库 Schema 产物。

## 上游同步与兼容

这是功能边界已经分叉的重构版，不保证与上游配置、备份或数据库双向兼容。升级前请备份 `DATA_DIR`；导入旧数据后应重新检查站点、连接、路由和下游密钥。

提交上游同步改动时，请按模块吸收并通过本仓库的架构守卫，不要直接假设上游页面、定时任务或平台适配器仍然存在。

## 许可证与致谢

本项目遵循 [MIT License](LICENSE)。感谢 [cita-777/metapi](https://github.com/cita-777/metapi) 原项目及其贡献者提供的基础实现。

### 本重构版贡献者

<!-- metapi-contributors:start -->
<p align="left">
  <sub>贡献者列表将在公开仓库可访问后通过 <code>npm run readme:contributors</code> 更新。</sub>
</p>
<!-- metapi-contributors:end -->
