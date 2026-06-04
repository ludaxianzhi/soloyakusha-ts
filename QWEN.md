# soloyakusha-ts — 翻译工程管理工具

## 项目概述

**soloyakusha-ts** 是一个 LLM 驱动的视觉小说/游戏翻译工程管理工具，使用 TypeScript 实现。项目从 Python 版 `soloyakusha` 移植而来，核心能力包括：

- **LLM客户端层**：统一抽象 OpenAI / Anthropic / Gemini API，支持流式解析、重试、限流、故障转移、工具循环
- **翻译工程**：Pipeline 编排、多步骤工作队列、上下文网络、术语表管理、进度追踪、断点续跑
- **文件解析**：支持 NatureDialog / M3T / DBL-TP1/TP2 / VNT JSON / 纯文本等多种视觉小说文件格式
- **术语表**：多格式持久化（JSON/CSV/TSV/YAML/XML）、全文扫描、增量更新、对齐修复
- **文本对齐**：基于 Embedding 的原文↔译文逐句对齐与自动修复
- **重复模式分析**：全文重复模式扫描，确保翻译一致性
- **向量检索**：ChromaDB / Qdrant / SQLite 内存模式后端，提供语义检索
- **WebUI**：React 前端 + Hono API 服务端，支持工作区管理、编辑器、看板、SSE 事件推送

**运行时**：Bun（运行时 + 打包器）

**技术栈**：TypeScript 5, React 19, Ant Design 6, Hono 4, Vite 8, LiquidJS, Monaco Editor, CodeMirror, @xyflow/react

---

## 构建与运行

### 安装依赖

```bash
bun install
```

### 类型检查

```bash
bun x tsc --noEmit
```

### 运行测试

```bash
bun test                                    # 全量测试
bun test src/project/translation-processor.test.ts  # 单文件测试
```

> **已知问题**：`src/glossary/glossary.test.ts` 中有一个已有的测试失败。

### WebUI

```bash
bun run webui              # 构建前端 → 单端口 8000 托管前后端
bun run webui:dev          # 开发模式：前端 5173 + 后端 8000 同时启动
bun run webui:build        # 构建单文件可执行程序 → dist/soloyakusha-webui.exe (Windows)
```

### CI/CD

`.github/workflows/build-linux-webui.yml` — 手动触发的 Linux 可执行程序构建工作流。

---

## 项目结构

```
E:\Github\soloyakusha-ts\
├── index.ts                          # 根导出模块（统一暴露所有公共 API）
├── package.json / tsconfig.json      # 项目配置
├── vite.webui.config.ts              # WebUI 前端 Vite 构建配置
├── scripts/                          # 构建/开发辅助脚本
│   ├── build-webui.ts                # WebUI 单文件可执行程序构建
│   └── dev-webui.ts                  # 开发环境启动（后端 + 前端并行）
├── src/
│   ├── config/                       # 全局配置管理（GlobalConfigManager）
│   ├── llm/                          # LLM 客户端层（OpenAI / Anthropic / Gemini）
│   ├── project/                      # 翻译工程核心（最复杂模块）
│   │   ├── pipeline/                 # Pipeline 编排、TranslationProject
│   │   ├── processing/               # 翻译/校对/风格迁移处理器
│   │   ├── context/                  # 上下文网络、故事拓扑、术语级联匹配
│   │   ├── analysis/                 # 全局重复模式扫描
│   │   ├── document/                 # 文档管理（章节/片段持久化）
│   │   └── storage/                  # SQLite 工程存储
│   ├── glossary/                     # 术语表管理（Glossary、Scanner、Persister）
│   ├── file-handlers/                # 文件格式解析器（Factory 模式）
│   ├── prompts/                      # 提示词管理（YAML 资源 + LiquidJS 渲染）
│   ├── consistency/                  # 翻译一致性检查与修复
│   ├── style-library/                # 翻译风格库
│   ├── utils/                        # 文本对齐工具（对齐器、对齐修复、预处理/后处理）
│   ├── vector/                       # 向量数据库层（ChromaDB / Qdrant / SQLite）
│   └── webui/                        # WebUI（Hono 服务端 + React 客户端）
│       ├── app.ts / server.ts        # 服务端入口
│       ├── routes/                   # API 路由（config / project / workspace 等）
│       ├── services/                 # 服务层（project-service 为核心）
│       └── client/                   # React 前端
│           ├── index.html
│           └── src/
│               ├── app/              # 根组件、API 封装、类型定义
│               ├── components/       # 通用 UI 组件
│               ├── features/         # 功能页面（章节编辑器、工作区创建）
│               └── styles.css
├── docs/                             # 设计文档
│   ├── pre-processor-id-field.md     # 预处理器 id 字段丢失问题分析
│   └── workspace-scope-isolation-analysis.md  # 工作区作用域隔离分析
└── pca_train/                        # PCA 训练（嵌入降维）
```

---

## 架构要点

### 模块依赖关系

```
file-handlers/  →  项目文件解析
glossary/       →  术语表管理
llm/            →  LLM 客户端抽象
prompts/        →  提示词模板
      │
      └──→ project/  (翻译工程核心)
              ├── pipeline/      → 管线编排
              ├── processing/    → 翻译/校对处理器
              ├── context/       → 上下文网络
              ├── analysis/      → 重复模式扫描
              ├── document/      → 文档管理
              └── storage/       → SQLite 持久化
      │
vector/         →  向量检索（语义上下文）
consistency/    →  一致性检查
style-library/  →  风格库
utils/          →  文本对齐工具
config/         →  全局配置
      │
      └──→ webui/  (React + Hono 前端)
```

### 关键设计决策

- **单入口导出**：`index.ts` 是公共库表面，统一 re-export 所有模块
- **WebUI 薄层原则**：WebUI 不应包含业务逻辑，所有领域逻辑在 `src/project/`、`src/llm/` 等共享模块中实现
- **工作区持久化**：每个工作区在自身目录的 `Data/` 下存储状态（workspace-config.json、project-state.json、Chapters/{id}.json）
- **全局用户配置**：独立于工作区，存储在 `%USERPROFILE%\.soloyakusha-ts\config.json`，通过 `GlobalConfigManager` 管理
- **异步作用域隔离**：`ProjectService` 使用 `AsyncLocalStorage` 实现多工作区并发操作的状态隔离
- **测试文件随源文件放置**：采用 `*.test.ts` 命名模式，使用 `bun:test`

---

## 关键约定

### 代码规范

| 约定 | 说明 |
|---|---|
| 模块导出 | 每个模块应有 `index.ts` 统一导出 |
| 类型定义 | 独立 `types.ts` 文件而非散落在各处 |
| 类/模块风格 | ES 类 + TypeScript 模块，贴近 Python 原版的可读性设计 |
| 路径分隔符 | 代码和文档中使用 Windows 风格 `\`（当前项目在 Windows 上开发） |
| 测试框架 | `bun:test`，测试文件放在源文件旁，命名 `*.test.ts` |
| 配置规范化 | `config/document-codec.ts` 中统一处理新配置字段的 `normalize/clone/prune` |
| 处理器注册 | 新增翻译工作流需在 `TranslationProcessorFactory` 中注册 |

### 重要注意事项

1. **预处理器 id 字段**：`PreProcessPipelineBuilder` 表单中 `id` 字段无对应 `Form.Item`，提交时会丢失。`src/webui/client/src/app/App.tsx` 的 `onFinish` 中有补全逻辑，但新增预处理器类型时需要同步更新。详情见 `docs/pre-processor-id-field.md`。

2. **工作区作用域隔离**：`ProjectService` 的 `currentState` 代理模式存在状态漂移风险。多个工作区并发操作时需注意 `runInWorkspace` 作用域绑定。详情见 `docs/workspace-scope-isolation-analysis.md`。

3. **上下文网络阈值**：最小连接强度阈值默认 `0.5`。如需修改，需要同步三个位置：
   - UI 默认值（`WorkspaceDashboardTab.tsx`）
   - 服务端默认值（`project-service.ts`）
   - Builder 默认值（`context-network-builder.ts`）

4. **SQLite 存储**：当配置 `"storageType": "sqlite"` 时使用 `sqlite-project-storage.ts`，否则使用 JSON 文件存储。

### CI 状态

- `bun run webui:build` ✅ 成功
- `bun test` ⚠️ 有一个已知失败（`src/glossary/glossary.test.ts`）
- `bun x tsc --noEmit` ✅ 通过

---

## 翻译流程概览

```
用户创建/打开工作区
  → TranslationFileHandlerFactory 解析原文文件
  → TranslationDocumentManager 切分章节/片段
  → Glossary 加载术语表
  → ContextNetworkBuilder 构建上下文网络
  → FullTextGlossaryScanner 全文扫描术语
  → GlobalAssociationPatternScanner 扫描重复模式
  → TranslationProject.startTranslation()
      → 按 Pipeline 调度 WorkQueue
      → TranslationProcessor 调用 LLM 翻译
      → GlossaryUpdater 增量更新术语表
      → 进度持久化（支持断点续跑）
  → 结果展示在 WebUI 章节编辑器中
```

---

## 常用命令速查

| 命令 | 用途 |
|---|---|
| `bun install` | 安装依赖 |
| `bun x tsc --noEmit` | TypeScript 类型检查 |
| `bun test` | 运行全量测试 |
| `bun test <file>` | 运行指定测试文件 |
| `bun run webui` | 构建并启动单端口 WebUI |
| `bun run webui:dev` | 开发模式启动 |
| `bun run webui:build` | 构建单文件可执行程序 |
