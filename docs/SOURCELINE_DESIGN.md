# SourceLine 设计方案与技术选型

最后更新：2026-06-09

## 1. 项目定义

**项目名：** SourceLine

**Slogan：** Every claim, traced.

**一句话定位：** SourceLine 把 AI 回答、文章、论文草稿、学习笔记和政策说明，转换成逐条断言可追溯的证据报告。

SourceLine 不是聊天产品，也不是普通内容生成器。它的核心价值是回答一个具体问题：

> 这段文字里的每一句事实性说法，有没有可追溯的来源？

项目第一阶段应做成开源基础工具，优先 CLI 和核心引擎，等验证流程跑通后再做 Web demo。

## 2. 核心用户

优先服务：

- 大学生、研究生：检查 AI 回答、论文草稿、学习笔记是否有证据。
- 写作者、研究人员：检查文章和报告中的事实性说法是否有来源。
- 社区工作者、政策阅读者：核对公开说明和政策解读是否可靠。
- 开发者：用 CLI 或 CI 检查 README、文档、技术说明中的事实性断言。

后续可服务：

- 教师：让学生看到逐条证据，而不是只看到一个笼统分数。
- 开源维护者：检查项目文档、教程和 README 里的事实性陈述。

## 3. 产品原则

1. **证据优先于分数。** 分数只能辅助判断，用户必须能看到每条判断背后的证据。
2. **逐条断言，而不是整文打分。** SourceLine 的最小工作单元是一条事实性 claim。
3. **默认保留人工复核。** 工具给出支持、反驳、证据不足和风险提示，不伪装成最终裁判。
4. **核心引擎与供应商解耦。** LLM、搜索 API、本地检索、报告输出都必须可替换。
5. **报告可导出。** Markdown 和 JSON 从第一版开始就是一等输出。
6. **支持本地/自带来源。** 后续必须允许用户只基于本地资料库核查，降低隐私和可信度风险。

## 4. 第一版不做什么

MVP 不做：

- 不做通用聊天机器人。
- 不做完整论文管理器。
- 不做浏览器插件。
- 不做全自动事实裁决。
- 不承诺“某个来源一定真实”，只判断检索到的来源与 claim 的关系。
- 不在第一版支持所有文件格式，先支持 Markdown、txt 和 stdin。

## 5. MVP 范围

第一版目标命令：

```bash
npx sourceline check answer.md --report markdown --out sourceline-report.md
```

MVP 输入：

- Markdown 文件。
- txt 文件。
- HTML 文件。
- stdin 管道输入。

MVP 处理流程：

- 解析输入文本。
- 按段落和行号保留上下文锚点。
- 提取需要验证的事实性断言。
- 为每条断言生成搜索关键词。
- 调用检索供应商查找候选来源。
- 调用 LLM 按严格 schema 判断证据关系。
- 输出逐条 claim 报告。

MVP 输出：

- 终端摘要。
- Markdown 报告。
- JSON 报告。

MVP 状态标签：

- `supported`：证据直接支持该断言。
- `partially_supported`：证据支持一部分，或只支持更弱版本。
- `unsupported`：没有找到支持证据。
- `contradicted`：可信来源与该断言冲突。
- `not_enough_evidence`：现有证据不足以判断。

## 6. 推荐技术选型

### 6.1 语言与运行时

推荐：

- TypeScript。
- Node.js 24 LTS。
- ESM-first。

理由：

- CLI、Web、schema、报告渲染、LLM/search provider 都能共享类型。
- TypeScript 适合维护长期稳定的数据结构和 provider 接口。
- SourceLine 要发布 npm CLI，Node 生态天然匹配。

### 6.2 包管理与仓库结构

推荐：

- pnpm workspace。
- 后续包变多后再引入 Turborepo。

第一阶段可以先保持简单，但目录要按 monorepo 思路预留：

```text
sourceline/
  apps/
    web/
  packages/
    cli/
    core/
    providers/
    report/
    config/
  examples/
  docs/
```

依赖方向：

- `cli` 依赖 `core`、`providers`、`report`、`config`。
- `web` 依赖 `core`、`providers`、`report`、`config`。
- `core` 不依赖任何具体 LLM/search SDK。
- `report` 只消费标准 `SourceLineReport` 数据。

### 6.3 CLI 技术栈

推荐：

- `commander`：命令行解析。
- `picocolors`：终端颜色。
- `ora`：长任务 spinner，但 CI 中自动关闭。
- `zod`：配置和报告 schema 校验。
- `unified` / `remark`：Markdown 解析。
- `vitest`：测试。

初始命令：

```bash
sourceline check <input>
sourceline check <input> --json
sourceline check <input> --report markdown
sourceline check <input> --out report.md
sourceline check <input> --provider tavily
sourceline check <input> --sources ./sources
sourceline init
```

默认值：

- 默认终端输出摘要。
- `--json` 输出机器可读 JSON。
- `--report markdown` 输出完整 Markdown。
- 默认最多检查 30 条 claim。
- 默认每条 claim 最多保留 5 条候选来源。
- 默认置信阈值 0.65。

### 6.4 LLM 层

第一版推荐：

- OpenAI Responses API。
- Structured Outputs / JSON Schema。

理由：

- 断言提取和证据判断必须返回稳定对象，不能依赖自由文本解析。
- schema 失败可以重试、降级和记录错误。
- 后续可增加本地模型或其他云模型 adapter。

Provider 接口：

```ts
export type LlmProvider = {
  extractClaims(input: ExtractClaimsInput): Promise<ExtractClaimsResult>;
  verifyClaim(input: VerifyClaimInput): Promise<ClaimCheck>;
};
```

第一版需要同时提供：

- `openai` provider：真实在线能力。
- `mock` provider：测试、demo、CI 使用。

### 6.5 检索层

推荐顺序：

1. Tavily：开发者体验较好，适合第一版快速接入。
2. Brave Search API：作为第二个通用 web search provider。
3. 本地 source folder：用户自带资料库，后续重点能力。
4. 后续再考虑 SerpAPI、Exa、Zotero、机构数据库。

Provider 接口：

```ts
export type SearchProvider = {
  name: string;
  search(query: SearchQuery): Promise<SearchResult[]>;
};
```

检索结果必须包含：

- `url`
- `title`
- `snippet`
- `provider`
- `retrievedAt`
- `rank`

注意：

- 报告中要区分“检索到的来源”和“被验证为相关的证据”。
- 同一次运行内要做查询缓存，避免重复请求。

### 6.6 本地资料库

MVP 暂不做复杂向量库，先支持：

- `--sources ./sources`
- Markdown/txt/HTML 文件夹。
- 基于关键词或轻量 BM25 的匹配。
- 跨 CLI 运行的增量索引缓存：缓存文件位于 `<sources>/.sourceline/cache/local-index.json`，按相对路径、mtime 和文件大小判断是否复用已分块内容；缓存损坏或写入失败时自动回退到重新索引。

后续再引入：

- 缓存统计、清理命令和可观测性。
- LanceDB 或 SQLite vec。
- 按标题、段落、引用块 chunking。
- PDF 文档入库。

### 6.7 Web demo

Web demo 放在核心 CLI 稳定之后。

推荐：

- Next.js App Router。
- TypeScript。
- Tailwind CSS。
- 必要时再引入 shadcn/ui。

第一屏必须是可用工具，而不是营销落地页：

- 粘贴文本。
- 上传文件。
- 选择检索/模型 provider。
- claim 列表。
- 证据详情抽屉。
- Markdown/JSON 导出。

## 7. 核心数据模型

```ts
export type VerificationStatus =
  | "supported"
  | "partially_supported"
  | "unsupported"
  | "contradicted"
  | "not_enough_evidence";

export type EvidenceRelation =
  | "supports"
  | "partially_supports"
  | "contradicts"
  | "related"
  | "irrelevant";

export type SourceDocument = {
  id: string;
  title?: string;
  url?: string;
  path?: string;
  publisher?: string;
  publishedAt?: string;
  retrievedAt: string;
  snippet?: string;
  text?: string;
};

export type Claim = {
  id: string;
  text: string;
  sourceSpan?: {
    startLine?: number;
    endLine?: number;
    quote?: string;
  };
  claimType:
    | "statistical"
    | "historical"
    | "scientific"
    | "legal_or_policy"
    | "biographical"
    | "technical"
    | "general_factual";
  importance: "high" | "medium" | "low";
  searchQueries: string[];
};

export type EvidenceItem = {
  source: SourceDocument;
  relation: EvidenceRelation;
  confidence: number;
  quotedSupport?: string;
  explanation: string;
};

export type RiskFlag =
  | "no_source_found"
  | "weak_source"
  | "stale_source"
  | "source_paywalled"
  | "ambiguous_claim"
  | "overgeneralized_claim"
  | "requires_expert_review";

export type ClaimCheck = {
  claim: Claim;
  status: VerificationStatus;
  confidence: number;
  evidence: EvidenceItem[];
  explanation: string;
  riskFlags: RiskFlag[];
};

export type SourceLineReport = {
  schemaVersion: "1.0";
  input: {
    kind: "file" | "stdin" | "url" | "text";
    name?: string;
    hash: string;
  };
  generatedAt: string;
  summary: {
    totalClaims: number;
    supported: number;
    partiallySupported: number;
    unsupported: number;
    contradicted: number;
    notEnoughEvidence: number;
  };
  checks: ClaimCheck[];
};
```

## 8. 核心流程

```text
输入
  -> 解析文档
  -> 分段并保留位置锚点
  -> 提取候选事实断言
  -> 去重与规范化
  -> 生成搜索 query
  -> 检索候选来源
  -> 排序和过滤来源
  -> 判断证据与 claim 的关系
  -> 汇总报告
  -> 渲染 terminal / markdown / json / html
```

核心模块：

- `parseInput`：读取 file、stdin、text，后续支持 url/pdf。
- `segmentDocument`：保留段落、行号、原文引用。
- `extractClaims`：提取事实性断言。
- `generateQueries`：生成搜索关键词。
- `retrieveEvidence`：调用 web search 或本地 source provider。
- `verifyClaim`：判断证据关系和最终状态。
- `scoreReport`：汇总数量和可选覆盖率。
- `renderReport`：输出 terminal、Markdown、JSON、HTML。

## 9. 配置设计

环境变量：

```bash
OPENAI_API_KEY=
SOURCELINE_SEARCH_PROVIDER=tavily
TAVILY_API_KEY=
BRAVE_SEARCH_API_KEY=
```

配置文件示例：

```ts
import { defineConfig } from "sourceline/config";

export default defineConfig({
  llm: {
    provider: "openai",
    model: "gpt-4.1-mini"
  },
  search: {
    provider: "tavily",
    maxResultsPerClaim: 5
  },
  checks: {
    maxClaims: 30,
    minConfidence: 0.65
  },
  reports: {
    defaultFormat: "markdown"
  }
});
```

优先级：

1. CLI flags。
2. 配置文件。
3. 环境变量。
4. 内置默认值。

## 10. 报告设计

Markdown 报告示例：

```markdown
# SourceLine Report

Input: answer.md
Generated: 2026-06-07T08:00:00.000Z

## Summary

- Claims found: 12
- Supported: 7
- Partially supported: 2
- Unsupported: 1
- Contradicted: 0
- Not enough evidence: 2

## Claims

### 1. TypeScript became one of the most-used languages on GitHub.

Status: partially_supported
Confidence: 0.78

Evidence:

- GitHub Octoverse report: ...

Explanation:

The source supports TypeScript's high usage, but does not prove the exact ranking claimed.

Risk flags:

- overgeneralized_claim
```

终端摘要示例：

```text
SourceLine Report
Input: answer.md
Claims: 12 | Supported: 7 | Partial: 2 | Unsupported: 1 | Review: 2

Needs review:
- [unsupported] Most nonprofits already have mature AI strategies.
- [not_enough_evidence] TypeScript became the most-used language on GitHub in 2025.

Full report: sourceline-report.md
```

## 11. 评分策略

第一版不突出单一“可信分”，因为它容易造成虚假的确定感。

如果后续需要分数，建议叫 **evidence coverage**，也就是证据覆盖率，而不是 truth score：

```text
evidenceCoverage = weightedSupportedClaims / weightedTotalClaims
```

权重：

- high：3
- medium：2
- low：1

任何分数都必须和 claim 明细同时展示。

## 12. 安全与隐私

必须做到：

- 不打印 API key。
- 日志和报告中自动脱敏疑似 secret。
- 发送本地文件到云端 LLM/search 前给出明确提示。
- 支持 `--sources` 模式，允许用户只基于本地资料核查。
- 本地检索缓存只写在 source folder 内的 `.sourceline/cache/`，可随时删除，并且不会把 `.sourceline/` 自身重新索引为证据。
- 默认不长期保存用户输入。

后续能力：

- `--offline` 本地模型 + 本地检索。
- `.sourcelineignore`。
- Web demo 的数据保留和删除策略。

## 13. 错误处理

常见情况：

- 缺少 API key：显示对应 provider 的配置方法。
- 搜索额度耗尽：已有证据继续生成报告，剩余 claim 标为 `not_enough_evidence`。
- LLM schema 校验失败：重试一次，仍失败则记录失败项。
- 未发现 claim：输出 0 claim 报告，不视为程序错误。
- 文件解析失败：JSON 保留错误详情，终端输出友好摘要。

## 14. 测试策略

测试工具：

- Vitest。

必须覆盖：

- 数据 schema 校验。
- Markdown/txt 输入解析。
- claim 去重与规范化。
- mock provider 下的完整 pipeline。
- Markdown report snapshot。
- JSON report golden file。
- CLI 参数解析。

CI 默认不调用真实 API。真实 provider 测试必须通过显式环境变量开启。

## 15. 开发路线

### 第 1 周：CLI 骨架和离线闭环

- 初始化 TypeScript workspace。
- 实现 `sourceline check <file>`。
- 支持 Markdown/txt/stdin。
- 实现 mock claim extractor。
- 实现 terminal、Markdown、JSON report。
- 加入 Vitest 和 golden tests。

### 第 2 周：LLM 断言提取

- 接入 OpenAI provider。
- 使用 Structured Outputs。
- claim 保留原文行号和段落锚点。
- 生成搜索 query。
- 加 schema 校验、失败重试和错误记录。

### 第 3 周：检索与证据判断

- 接入 Tavily。
- 预留 Brave provider。
- 实现 evidence ranking。
- 实现 claim verification。
- 输出完整 Markdown/JSON 报告。

### 第 4 周：开源发布准备

- 实现 `sourceline init`。
- 加配置文件。
- 加 examples。
- 写 README。
- 写隐私说明和限制说明。
- 发布 npm 包。

### 后续：Web demo

- 新增 Next.js App Router 应用。
- 做粘贴/上传入口。
- 做 claim table 和 evidence drawer。
- 支持 Markdown/JSON 导出。

## 16. 首个公开版本验收标准

必须有：

- `npx sourceline check answer.md`
- Markdown 输入。
- txt 输入。
- 终端摘要。
- Markdown 报告。
- JSON 报告。
- OpenAI provider。
- 一个 search provider。
- mock provider。
- examples。
- README quickstart。
- 隐私与限制说明。

可以延后：

- HTML 报告。
- Web demo。
- GitHub Action。
- PDF 输入。
- 浏览器插件。
- Zotero/CSL 引用格式。

## 17. README 首屏建议

````markdown
# SourceLine

Every claim, traced.

SourceLine turns AI answers, essays, reports, and policy text into claim-by-claim evidence reports.

```bash
npx sourceline check answer.md --report markdown --out report.md
```

It extracts factual claims, searches for sources, checks whether evidence supports each claim, and exports a readable Markdown or JSON report.
````

README 需要突出：

- 一条命令可运行。
- 输出是逐条 claim。
- 有证据、有风险、有解释。
- 不承诺自动判定真理。
- 支持本地/自带来源是后续重点。

## 18. 开放问题

开发中需要再确认：

- npm 包名用 `sourceline` 还是 `@sourceline/cli`。
- 第一版默认 search provider 用 Tavily 还是 Brave。
- 是否提供零 API key 的 sample/mock demo。
- 报告中默认展示多少短引用。
- 对时效性很强的 claim，证据多旧就标记为 `stale_source`。

当前建议：

- 优先尝试 `sourceline` 包名。
- 第一版真实链路用 OpenAI + Tavily。
- 一定提供 mock/sample 模式，方便无 key 用户体验。
- 报告只放短引用和链接，避免大段复制来源内容。
- 快速变化事实默认更保守，必要时标为 `requires_expert_review`。

## 19. 参考链接

技术基线参考：

- Node.js releases: https://nodejs.org/en/about/previous-releases
- pnpm workspace: https://pnpm.io/workspaces
- Next.js App Router: https://nextjs.org/docs/app
- OpenAI Structured Outputs: https://platform.openai.com/docs/guides/structured-outputs
- OpenAI Responses API: https://platform.openai.com/docs/api-reference/responses/create
- Commander.js: https://github.com/tj/commander.js
- Zod: https://zod.dev/
- Vitest: https://vitest.dev/
- Tavily API docs: https://docs.tavily.com/
- Brave Search API docs: https://api-dashboard.search.brave.com/app/documentation/web-search/get-started

## 20. 当前实现状态

截至 2026-06-08，SourceLine 已经完成第一阶段 CLI MVP 的主要骨架：

- TypeScript + Node.js 24 + pnpm workspace。
- `sourceline check <file>` 与 `sourceline init`。
- Markdown、txt、HTML、stdin 和 http(s) URL 输入。
- mock LLM provider 和 mock search provider，用于无 key 演示与测试。
- OpenAI-compatible LLM provider，可通过 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` 配置。
- 本地 Markdown/txt/HTML source folder 检索：`--search local --sources ./sources`。
- Tavily search provider：`--search tavily`，读取 `TAVILY_API_KEY`。
- Brave Search provider：`--search brave`，读取 `BRAVE_SEARCH_API_KEY`。
- terminal、Markdown、JSON 报告。
- HTML 单文件报告，包含 claim index、完整状态过滤、搜索、可见 claim 计数、键盘快捷键、可见 claim 复制、重置视图、JSON 下载、打印样式和可访问性 landmark。
- `sourceline.config.json` 配置加载，优先级为 CLI flags > config > env > defaults。
- `.sourcelineignore` 过滤本地 source folder 中不应进入检索的文件，支持 `!` 反选规则。
- 同一次运行内对相同搜索 query 做缓存，减少重复 search provider 调用。
- 本地检索使用内存倒排索引缩小候选 chunk，并输出 BM25 风格 score、matched terms、标题/短语命中加权和更短的命中片段，方便解释证据为何被选中。
- 本地检索会把已分块的 Markdown/txt/HTML 源文件快照缓存到 `<sources>/.sourceline/cache/local-index.json`；后续 CLI 运行按相对路径、mtime 和文件大小复用未变化文件，缓存损坏或索引 schema 版本不兼容时自动忽略并重建。
- 本地资料库支持 `.html`/`.htm` 文件，入库前会去除 script/style 等页面噪声，并从 `<title>` 或 `<h1>` 提取标题用于检索加权。
- `sourceline cache info --sources <dir>` 可查看本地检索缓存状态、当前/过期/缺失条目、chunk 数和缓存大小；`sourceline cache clear --sources <dir>` 可删除该 source folder 的缓存文件。
- 云端 provider 调用前的隐私确认：交互模式会询问，非交互模式需要 `--yes` 或 `SOURCELINE_ALLOW_CLOUD=1`。
- CLI 错误输出统一为面向用户的 `SourceLine error: ...`，参数解析更严格，并可用 `SOURCELINE_DEBUG=1` 打开 stack trace。
- CI gate 支持：`--fail-on never|review|unsupported|contradicted`，报告仍会写出，命中门槛时退出码为 2。
- GitHub Actions CI workflow：覆盖 build/typecheck、Vitest、CLI smoke 和 composite action smoke。
- release 准备材料已补齐：根目录和各 workspace package metadata、Node engines、action branding、CI package smoke、`docs/RELEASE_CHECKLIST.md`，以及本地 `release:check` 脚本。

下一轮优先级：

- 确认 license、npm 包名和 repository URL 后，再切换 package public 发布配置。
- PDF 输入。
- 启动 Next.js Web demo / Web report demo。
