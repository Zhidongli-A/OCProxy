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

**设计特色**：零运行时依赖 · 实时免费模型目录 · 不写死任何模型数据 · 工具名上游别名化并回包还原 · 429 换新会话重试 · 本地上下文守卫 · 多格式图片 / 思考 / 工具调用

## 文件目录

```
OCProxy/
├── src/
│   ├── index.ts          入口 · 启动日志 · 优雅退出
│   ├── server.ts         路由 · 模型解析 · 上下文守卫 · 429 重试
│   ├── config.ts         环境变量配置
│   ├── types.ts          规范类型（ChatRequest / UpstreamEvent / Adapter …）
│   ├── identity.ts       OpenCode V2 指纹 · 会话 ID · trace 头
│   ├── environment.ts    project id 计算
│   ├── harness.ts        最小 <env> / read 注入 · 工具别名与还原
│   ├── upstream.ts       上游请求 · 强制流式 · SSE 解析
│   ├── models.ts         免费模型目录 · 缓存 · 过滤
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

运行时只依赖 Bun；安装包本身零运行依赖。

```bash
# 从源码
cd E:\ZenFreeProxy
npm install -g .

# 从 GitHub Release 的 tarball
npm install -g https://github.com/Zhidongli-A/OCProxy/releases/download/v1.0.0/ocproxy-1.0.0.tgz

# 直接从 GitHub 仓库安装（无需 npm 发布）
npm install -g github:Zhidongli-A/OCProxy

# 已发布到 npm 后
npm install -g ocproxy

# 用 Bun
bun add -g .
bunx ocproxy
```

安装后命令为 `ocproxy`；Windows 下 `OCProxy` 同样可用（大小写不敏感）。

作为项目依赖安装（不全局）：

```bash
npm install <tarball-url-or-github:owner/repo>
npx ocproxy
```

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

完全离线模式（不请求上游，用于测试客户端）：

```bash
UPSTREAM_DRY_RUN=1 ocproxy
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

复制 `.env.example` 为 `.env`，或直接设置环境变量。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` / `PORT` | `0.0.0.0` / `8787` | 监听地址 |
| `UPSTREAM_BASE_URL` | `https://opencode.ai/inference/openai/v1` | 上游 OpenAI 兼容入口 |
| `UPSTREAM_MODELS_URL` | `https://opencode.ai/inference/v1/models` | 模型目录 |
| `UPSTREAM_API_KEY` | `public` | 共享匿名密钥 |
| `UPSTREAM_PROXY` | 空 | 可选 HTTP CONNECT 代理，如 `http://127.0.0.1:7890`；支持 `user:pass@` |
| `OPENCODE_VERSION` | `2.2.6` | 伪装的 OpenCode 版本，UA 自动拼成 `opencode/latest/<v>/cli` |
| `OPENCODE_USER_AGENT` | `opencode/latest/2.2.6/cli` | 直接覆盖 UA（一般不用改） |
| `OPENCODE_CLIENT` | `cli` | `x-opencode-client` |
| `OPENCODE_PROJECT_ID` | 空 | 覆盖 `sha1("directory:<dir>")`；空则自动计算 |
| `OPENCODE_WORKING_DIRECTORY` | 当前工作目录 | project id 与最小 `<env>` 块的目录 |
| `CONTEXT_GUARD` | `true` | 本地估算 token，超模型窗口直接 400，不耗配额 |
| `RETRY_ON_429` | `true` | 上游 429 时换新 session 重试一次（不循环） |
| `CONTEXT_LIMIT_OVERRIDES` | 空 | JSON，按模型 id 覆盖目录里的 context/input/output |
| `OPENCODE_MAX_COMPLETION_TOKENS` | `32000` | 调用方未指定 token 上限时补上的值 |
| `FREE_MODELS_ONLY` | `true` | 拒绝非免费模型 |
| `UPSTREAM_INCLUDE_USAGE` | `true` | 请求 `stream_options.include_usage` |
| `MODEL_CACHE_TTL_MS` | `600000` | 目录缓存时间 |
| `REQUEST_TIMEOUT_MS` | `300000` | 上游超时 |
| `SESSION_AFFINITY` | `auto` | 优先复用真实下游 OpenCode 会话 ID，否则按对话派生 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

> [!TIP]
> 仓库不内置任何实际模型数据。目录完全来自上游 `/v1/models`；需要按实测值修正上下文时，用 `CONTEXT_LIMIT_OVERRIDES` 在运行时覆盖。

### 六、工具与图片

- **工具名**：调用方所有工具在上游统一改名为 `tool_1…tool_N`，仅保留门控要求的 `read`；回包时恢复原名与参数。这样可避开 `subagent_fork`、`terminal*` 等名字触发的上游 429。
- **工具拦截**：调用方没有对应实现的上游工具调用会被丢弃；整轮只剩误调时，返回一条可读提示并把 `finish_reason` 归为 `stop`。
- **图片**：OpenAI `image_url`、Anthropic base64 图片、Gemini `inlineData` 均会转换为上游 `image_url` data URI。
- **思考内容**：上游 `reasoning_content` 映射到 OpenAI 的 `reasoning_content`、Anthropic 的 `thinking` block、Gemini 的 `thought: true` part。

### 七、模型目录

`ModelRegistry` 实时拉取上游目录，保留 `cost.text.input.price === 0 && cost.text.output.price === 0` 且可经 Chat Completions 转发的模型；缓存 10 分钟，失败时保留上次成功的**内存快照**。

- 不内置兜底模型列表；
- 首次获取失败时目录为空，推理返回 `503 catalog_unavailable`；
- 付费模型在调用上游前直接返回 `404 model_not_found`。

## 工作原理

2026-11-08 对当前 Zen v2 网关做了变体二分，门控实际只要求：

| 条件 | 验证结果 |
| --- | --- |
| 完整 V2 身份头、session、project、trace | 必需 |
| Bun 的 TLS/HTTP 栈 | 必需 |
| 上游 `stream: true` | 必需 |
| 含 `Working directory:` 的完整 `<env>` 块 | 必需（49 字符即可） |
| 一个名为 `read` 的工具 | 必需 |
| 8.6KB 全文 preamble、日期、模型名 | **不需要** |

因此 `harness.ts` 只注入最小 `<env>` 块与一个 `read`，不再携带 OpenCode 的完整系统提示。

另外实测发现：**工具名本身也会触发 429**（例如 `subagent_fork`）。最稳的做法是把所有调用方工具名别名化，回包再还原，已在上文「工具与图片」说明。

## 限制与排障

- **429 语义歧义**：配额耗尽与门控拒绝返回同一段 `429 FreeUsageLimitError`。先确认出口 IP 干净：同一 IP 上官方 `opencode` CLI 若也 429，则与本项目无关（换 IP 或等 UTC 0 点）。
- **会话烧毁**：某个 `ses_` 被 429 后可能持续 429；relay 会丢弃该对话的 session 映射，并用全新 session 重试一次（`RETRY_ON_429`）。
- **出口 IP**：免费额度按 IP 计桶；不要在干净 IP 上反复探测，长上下文会更快消耗额度。
- **公开代理**：基本不可用；机房/共享 IP 通常已被耗尽或风控。需要稳定访问请使用住宅网络或可信代理。
- **DSH / 客户端集成**：若客户端报工具名错误，检查是否经过旧版 relay；新版本会自动别名化与还原。

## 实测记录（2026-11-08，WARP IPv6 出口）

| 测试 | 模型 | 结果 |
| --- | --- | --- |
| 文本 | `big-pickle` | 200，`OK`，`prompt_tokens=495` |
| 图片（OpenAI） | `deepseek-v4.1-flash-free` | 200，`Red`，prompt 688 |
| 图片（OpenAI） | `glm-5.3-flash-free` | 200，`Red`，prompt 388 |
| 图片（OpenAI） | `mimo-v2.6-flash-free` | 200，`Red`，prompt 317 |
| 图片（Anthropic） | `glm-5.3-flash-free` | 200，thinking + text `Red` |
| 图片（Gemini） | `mimo-v2.6-flash-free` | 200，thought + text `Red` |

## 质量检查

```bash
bun install
bun run typecheck
```

## 发布

```bash
npm pack --dry-run        # 检查内容
npm pack                  # 生成 ocproxy-1.0.0.tgz
npm publish --access public
```

包名 `ocproxy`；若 npm 网页不可用，可推送 `v*` tag 由 GitHub Actions 创建 Release 并附带 tarball，或配置 `NPM_TOKEN` 后手动触发 `publish-npm` workflow。

## 致谢

感谢 [OpenCode](https://opencode.ai) 提供 Zen 免费模型通道，以及以下社区项目与讨论提供的逆向结论与实现思路：

- [zen-proxy](https://github.com/12errh/zen-proxy)
- [opencode2api](https://github.com/jasonxu114514/opencode2api)
- [OCFreeRelay](https://github.com/kirafishy/OCFreeRelay)
- OpenCode 相关 issue：[#35991](https://github.com/anomalyco/opencode/issues/35991)、[#58751](https://github.com/anomalyco/opencode/issues/58751)、[#60991](https://github.com/anomalyco/opencode/issues/60991)

## 许可证

本仓库以 [MIT 许可](LICENSE) 发布，版权 © 2026 NatwayTeam。
仅限学习研究，使用者需自行承担合规责任。
