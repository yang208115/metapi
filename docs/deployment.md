# 🚢 部署指南

[返回文档中心](./README.md)

---

## 支持的运行方式

| 场景 | 推荐方式 | 对外访问方式 | 数据位置 |
|------|----------|--------------|----------|
| 云服务器 / NAS / 家用主机长期运行 | Docker / Docker Compose | 固定服务地址，例如 `http://your-host:4000` 或反向代理域名 | 你挂载的 `DATA_DIR` / 持久化卷 |
| 二次开发 / 调试 | 本地开发 | 前端 `http://localhost:5173`，后端默认 `http://localhost:4000` | 仓库内 `./data` 或自定义 `DATA_DIR` |

> [!NOTE]
> - 当前不再提供 `Release` 压缩包 + Node.js 运行时的独立部署路径。


如果你现在只是一个最普通的 Docker / Docker Compose 部署，请先跳过这节。

这套能力只适用于：

- 你已经在 K3s / Kubernetes 中部署了 Metapi
- 而且当前 Metapi 是通过 Helm release 管理的

它不适用于：

- 只有一个裸 Docker Compose 容器
- 想直接从管理后台更新外部 Docker 主机上的容器


如果你已经通过 Helm 在 K3s / Kubernetes 中部署 Metapi，并希望在管理后台中：

- 查看当前运行版本
- 通过集群内 helper 手动触发一次升级

请直接阅读：


这页会单独说明 helper 部署、主服务 token 对齐、设置页字段含义、实际升级顺序和已知限制。

## Docker Compose 部署（推荐）

### 标准步骤

```bash
mkdir metapi && cd metapi

# 创建 docker-compose.yml（参见快速上手）
# 设置环境变量
export AUTH_TOKEN=your-admin-token
export PROXY_TOKEN=your-proxy-sk-token

# 启动
docker compose up -d
```

### 使用 `.env` 文件

如果不想每次 export，可以创建 `.env` 文件：

```bash
# .env
AUTH_TOKEN=your-admin-token
PROXY_TOKEN=your-proxy-sk-token
TZ=Asia/Shanghai
PORT=4000
```

```bash
docker compose --env-file .env up -d
```

> ⚠️ `.env` 文件包含敏感信息，请勿提交到 Git 仓库。

## Docker 命令部署

```bash
docker run -d --name metapi \
  -p 4000:4000 \
  -e AUTH_TOKEN=your-admin-token \
  -e PROXY_TOKEN=your-proxy-sk-token \
  -e TZ=Asia/Shanghai \
  -v ./data:/app/data \
  --restart unless-stopped \
  1467078763/metapi:latest
```

> **路径说明：**
> - `./data:/app/data` — 相对路径，数据存到当前目录下的 `data` 文件夹
> - 也可以使用绝对路径：`/your/custom/path:/app/data`
## 本地开发运行（源码调试）

开发、调试或提交 PR 的完整流程见 [快速上手 → 本地开发启动](./getting-started.md#方式三-本地开发启动) 和 [CONTRIBUTING.md](../CONTRIBUTING.md)。

> [!NOTE]
> 这条路径是开发流程，不是下载 `Release` 包后再手动跑 Node.js 的替代说法。

---

## 反向代理


### Nginx

流式请求（SSE）需要关闭缓冲，否则流式输出会异常：

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:4000;

        # SSE 关键配置
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header Connection '';
        proxy_http_version 1.1;
        chunked_transfer_encoding off;

        # 标准代理头
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 超时设置（长对话场景）
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

### Caddy

```
your-domain.com {
    reverse_proxy localhost:4000 {
        flush_interval -1
    }
}
```

## 升级

```bash
# 拉取最新镜像
docker compose pull

# 重新启动（数据不受影响）
docker compose up -d

# 清理旧镜像
docker image prune -f
```

## 回滚

如果升级后出现问题，请参考 [运维手册 → 数据备份与恢复](./operations.md#数据备份) 进行回滚。

核心思路：升级前备份数据目录（或数据库），出问题时停止服务、还原数据、指定旧版镜像重启。

## 数据持久化

不同运行方式的数据目录不同：

| 运行方式 | 数据目录 | 说明 |
|----------|----------|------|
| Docker / Docker Compose | 容器内 `DATA_DIR`（常见为 `/app/data`） | 需要映射到宿主机目录或平台持久化卷 |
| 本地开发 | `DATA_DIR`，默认 `./data` | 位于当前仓库工作目录 |


只要备份了对应的数据目录，升级、重启通常都不会丢失现有配置和 SQLite 数据。

完整备份策略见 [运维手册 → 数据备份](./operations.md#数据备份)。

---

## 下一步

- [配置说明](./configuration.md) — 详细环境变量
- [运维手册](./operations.md) — 日志排查、健康检查
