# 上游接入

Metapi 仅保留三类上游适配：

- **OpenAI**：OpenAI 兼容接口，适用于标准 `/v1` 网关；
- **Claude**：Claude / Anthropic Messages 接口；
- **Gemini**：Gemini / Google AI 接口。

在「站点」页面创建连接时，可以选择平台类型，也可以留空让 Metapi 根据 URL 自动检测。平台类型只影响协议适配，不代表某个具体供应商。

## OpenAI

填写：

- 站点名称；
- Base URL（例如 `https://api.example.com/v1`）；
- API Key 或账号 Token；
- 可选的模型、价格和路由配置。

OpenAI 适配支持模型列表和标准代理请求。若上游使用自定义路径，请填写上游实际可访问的 Base URL。

## Claude / Anthropic

填写 Anthropic 兼容接口地址和凭证。Metapi 会在下游 OpenAI 与上游 Claude 协议之间完成必要的请求和响应转换。


## Gemini / Google AI

填写 Gemini 兼容接口地址和凭证。Metapi 支持 Google AI 的模型发现，并将 Gemini 请求纳入统一路由。


## 公共能力

三类适配器共享以下能力：

- 模型发现与路由表刷新；
- 统一的代理入口和故障转移；
- 站点、账号和 Token 管理；
- 余额、使用量和通知能力（以对应上游接口实际支持为准）。

Metapi 不再注册或自动识别其他聚合面板、第三方网关和专用 CLI 适配器。历史数据库中的旧平台记录不会被新建站点入口继续扩展；如需迁移，请将连接改为 OpenAI、Claude 或 Gemini 兼容接口。
