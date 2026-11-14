# OCProxy

---

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-OCProxy-181717?logo=github)](https://github.com/Zhidongli-A/OCProxy)
[![Bun](https://img.shields.io/badge/Bun-1.2%2B-black?logo=bun)](https://bun.sh)
[![npm](https://img.shields.io/badge/npm-ocproxy-CB3837?logo=npm)](https://www.npmjs.com/package/ocproxy)

> 把 OpenCode Zen 的免费模型，接成任何客户端都能用的标准接口。

> [!NOTE]
> 项目仍处于早期迭代阶段，接口与默认行为以本 README 为准。

> [!WARNING]
> 免费模型通道仅限 OpenCode 客户端使用。本项目通过伪装请求头复用匿名免费额度，可能违反 OpenCode 服务条款，**仅供个人学习研究**，请勿用于商业或滥用场景。

> [!IMPORTANT]
> 运行时必须使用 **Bun**（TLS/HTTP 指纹要求）。Node 启动器只负责调用 Bun，服务本体不能在 Node 下运行。

## 总体架构

**下游链路**：OpenAI Chat Completions · OpenAI Responses · Anthropic Messages · Google Gemini `generateContent` → 适配器 → 统一 `ChatRequest`

**上游链路**：OpenCode V2 身份（UA / session / project / trace）→ 最小 `<env>` 块 + 一个 `read` 工具 → 强制 `stream: true` → SSE 归一化 → 还原为下游原生格式

**设计特色**：零运行时依赖 · 实时免费模型目录（不缓存）· 不写死任何模型数据 · 请求头全自动计算 · 工具名上游别名化并回包还原 · 429 换新会话重试一次 · 本地估算 token · 多格式图片 / 思考 / 工具调用

## 文件目录

```
OCProxy/
├── src/
│   ├── index.ts          入口 · 启动日志 · 优雅退出
│   ├── server.ts         路由 · 模型解析 · 上下文守卫 · 429 重试
│   ├── config.ts         运行时配置（监听 / 上游地址 / 代理 / 超时 / 日志）
│   ├── types.ts          规范类型（ChatRequest / UpstreamEvent / Adapter …）
│   ├── identity.ts       OpenCode V2 指纹 · 会话 ID · trace 头（全自动）
│   ├── environment.ts    project id 计算（当前工作目录）
│   ├── harness.ts        最小 <env> / read 注入 · 工具别名与还原
│   ├── upstream.ts       上游请求 · 强制流式 · SSE 解析
│   ├── models.ts         免费模型目录 · 实时拉取 · 免费过滤
│   ├── sse.ts            SSE 解析 / 编码
│   ├── collect.ts        流事件聚合
│   └── adapters/
│       ├── openai.ts     OpenAI Chat Completions
│       ├── responses.ts  OpenAI Responses
│       ├── anthropic.ts  Anthropic Messages
│       ├── gemini.ts     Gemini generateContent
│       └── shared.ts     适配器公共工具
├── assets/
│   └── read-tool.json    官方 OpenCode `read` 工具定义（门控要求）
├── bin/
│   └── ocproxy.mjs       npm / 全局命令启动器（调用 Bun）
├── .github/workflows/    GitHub Release 与 npm 发布工作流
├── .env.example
├── LICENSE
├── package.json
└── README.md
```

## 使用方法

### 一、安装

运行时只依赖 Bun；安装包本身零运行依赖。直接从 GitHub 仓库安装：

```bash
npm install -g github:Zhidongli-A/OCProxy
```

安装后命令为 `ocproxy`；Windows 下 `OCProxy` 同样可用（大小写不敏感）。

### 二、启动

```bash
cp .env.example .env   # 可选，Bun 会自动加载
ocproxy                # 默认 http://127.0.0.1:8787
```

仪表盘：<http://127.0.0.1:8787/>

健康检查：

```bash
curl http://127.0.0.1:8787/health
# {"status":"ok","service":"OCProxy",...}
```

### 三、下游接口

| 格式 | 方法与路径 | 说明 |
| --- | --- | --- |
| OpenAI Chat Completions | `POST /v1/chat/completions` | 主流客户端（Cline / Roo / Continue / Aider / DSH / Cherry Studio…） |
| OpenAI Responses | `POST /v1/responses` | Codex 风格客户端 |
| Anthropic Messages | `POST /v1/messages` | Claude Code / Anthropic SDK |
| Gemini generateContent | `POST /v1beta/models/{model}:generateContent` | Gemini SDK；流式路径为 `:streamGenerateContent` |
| 模型目录 | `GET /v1/models`、`GET /v1beta/models` | 仅返回当前免费模型 |

下游 API Key 完全忽略：任意 key、错误 key、甚至不传 key 都可以调用。

### 四、客户端接入

OpenAI 兼容客户端：

```yaml
base_url: http://127.0.0.1:8787/v1
api_key: any-value
model: deepseek-v4.1-flash-free
```

Anthropic 兼容客户端：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_API_KEY=any-value
```

Gemini SDK：把 `base_url` 指向 `http://127.0.0.1:8787`，模型 id 用目录中的免费模型。

DeepSeek Harness（DSH）的 provider 示例：

```yaml
providers:
  ocproxy:
    api: openai-completions
    baseURL: http://127.0.0.1:8787/v1
    apiKeyEnv: OCPROXY_API_KEY   # 任意值，relay 不校验
    models:
      - id: deepseek-v4.1-flash-free
        name: DeepSeek V4.1 Flash Free
```

### 五、配置

复制 `.env.example` 为 `.env`，或直接设置环境变量。**只有下面几项可配**：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` / `PORT` | `0.0.0.0` / `8787` | 监听地址 |
| `UPSTREAM_BASE_URL` | `https://opencode.ai/inference/openai/v1` | 上游 OpenAI 兼容入口 |
| `UPSTREAM_MODELS_URL` | `https://opencode.ai/inference/v1/models` | 免费模型目录 |
| `UPSTREAM_PROXY` | 空 | 可选 HTTP CONNECT 代理，如 `http://127.0.0.1:7890`；支持 `user:pass@` |
| `REQUEST_TIMEOUT_MS` | `300000` | 上游超时（毫秒） |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## 许可证

本仓库以 [MIT 许可](LICENSE) 发布，版权 © 2026 Zhidongli。
仅限学习研究，使用者需自行承担合规责任。

