# soloyakusha-ts

当前项目已移植 `参考\soloyakusha` 中的 LLM 管理与封装主干能力，并改成了更贴近 TypeScript 的类/模块设计：

- `LlmClientProvider`：注册命名模型配置、延迟创建客户端、按配置缓存实例
- `OpenAIChatClient`：OpenAI-compatible chat completions，支持流式解析、重试、限流、观测与历史记录
- `AnthropicChatClient`：Anthropic messages API，支持流式解析、重试、限流、观测与历史记录
- `OpenAIEmbeddingClient`：embedding 请求、批处理和内存缓存
- `RateLimiter`：QPS + 并发限制
- `FileRequestHistoryLogger`：文本历史日志与简单轮转

同时也补上了翻译工程骨架的基础层：

- `TranslationDocumentManager`：章节/片段持久化、全文管理、翻译进度更新
- `TranslationProject`：面向任务的项目骨架，负责按 Pipeline / Work Queue 并发分发任务、统计进度、动态收集 glossary 和依赖译文上下文
- `TranslationPipeline` / `TranslationStepWorkQueue`：步骤定义与步骤级调度队列
- `startTranslation()` / `stopTranslation()`：翻译开始、停止与断点续跑生命周期控制
- `GlobalAssociationPatternScanner`：原文全文重复模式扫描（默认至少出现 3 次且长度至少 8）
- `getProjectSnapshot()` / `getQueueSnapshot()`：项目状态、队列状态与当前工作项快照

另外已迁移文件解析模块：

- `TranslationFileHandlerFactory`
- `NatureDialogFileHandler`
- `NatureDialogKeepNameFileHandler`
- `M3TFileHandler`
- `GaltranslJsonFileHandler`
- `PlainTextFileHandler`

以及 `utils/text_align`：

- `DefaultTextAligner`
- `DynamicTextAligner`
- `SimplifiedDynamicTextAligner`
- `AlignmentRepairTool`

以及术语表管理：

- `Glossary`
- `FullTextGlossaryScanner`
- `GlossaryPersisterFactory`
- JSON / CSV / TSV / YAML / XML 术语表持久化
- 术语状态（已翻译 / 未翻译）与出现统计（总出现次数 / 出现文本块数）

以及提示词管理：

- `PromptManager`：从 YAML 静态资源加载提示词目录
- 三类模板：`static`、`interpolate`、`liquid`（由 LiquidJS 渲染）
- 默认提示词资源：`src/prompts/resources/default-prompts.yaml`
- 所有 LLM 请求均显式区分 `systemPrompt` 与用户提示内容

## 安装依赖

```bash
bun install
```

## 类型检查

```bash
bunx tsc --noEmit
```

## 默认提示词资源

默认提示词以 YAML 静态资源形式随源码分发，位于 `src/prompts/resources/default-prompts.yaml`。

```ts
import { getDefaultPromptManager } from "./index.ts";

const promptManager = await getDefaultPromptManager();
const rendered = promptManager.renderPrompt("glossary.fullTextScan", {
  startLineLabel: "L00001",
  endLineLabel: "L00010",
  batchText: "L00001: 勇者来了",
});

console.log(rendered.systemPrompt);
console.log(rendered.userPrompt);
```

## 运行测试

```bash
bun test
```

## 示例

```ts
import {
  FileRequestHistoryLogger,
  LlmClientProvider,
} from "./index.ts";

const provider = new LlmClientProvider({
  historyLogger: new FileRequestHistoryLogger("logs"),
});

provider.register("writer", {
  provider: "openai",
  modelType: "chat",
  modelName: "gpt-4.1",
  endpoint: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_API_KEY",
  defaultRequestConfig: {
    temperature: 0.3,
    maxTokens: 2048,
  },
});

const writer = provider.getChatClient("writer");
const response = await writer.singleTurnRequest("给我一段简短的摘要");
console.log(response);
```

## 翻译工程骨架示例

```ts
import { TranslationProject } from "./index.ts";

const project = new TranslationProject({
  projectName: "demo",
  projectDir: "./workspace",
  chapters: [
    { id: 1, filePath: "sources\\01.txt" },
    { id: 2, filePath: "sources\\02.txt" },
  ],
  glossary: {
    path: "glossary.csv",
    autoFilter: true,
  },
});

await project.initialize();
await project.startTranslation();

const translationQueue = project.getWorkQueue("translation");
const workItems = await translationQueue.dispatchReadyItems();
console.log(workItems.map((item) => ({
  inputText: item.inputText,
  dependencyMode: item.metadata.dependencyMode,
  contexts: item.contextView?.getContexts(),
})));

await project.submitWorkResult({
  runId: workItems[0]!.runId,
  stepId: "translation",
  chapterId: workItems[0]!.chapterId,
  fragmentIndex: workItems[0]!.fragmentIndex,
  outputText: "这里写入译文",
});
```

## 多步骤 Pipeline 示例

```ts
import type { TranslationPipelineDefinition } from "./index.ts";
import { TranslationProject } from "./index.ts";

const pipeline: TranslationPipelineDefinition = {
  steps: [
    {
      id: "draft",
      description: "草稿翻译",
      buildInput: ({ chapterId, fragmentIndex, runtime }) =>
        runtime.getSourceText(chapterId, fragmentIndex),
    },
    {
      id: "polish",
      description: "润色定稿",
      buildInput: ({ previousStepOutput }) => previousStepOutput?.lines.join("\n") ?? "",
    },
  ],
  finalStepId: "polish",
};

const project = new TranslationProject({
  projectName: "demo",
  projectDir: "./workspace",
  chapters: [{ id: 1, filePath: "sources\\scene.txt" }],
}, {
  pipeline,
});

await project.initialize();
await project.startTranslation();

const draftQueue = project.getWorkQueue("draft");
const draftItems = await draftQueue.dispatchReadyItems();

await project.submitWorkResult({
  runId: draftItems[0]!.runId,
  stepId: "draft",
  chapterId: draftItems[0]!.chapterId,
  fragmentIndex: draftItems[0]!.fragmentIndex,
  outputText: "草稿结果",
});

const polishQueue = project.getWorkQueue("polish");
const polishItems = await polishQueue.dispatchReadyItems();
console.log(polishItems[0]?.inputText);
```

## 项目状态快照示例

```ts
import { TranslationProject } from "./index.ts";

const project = new TranslationProject({
  projectName: "demo",
  projectDir: "./workspace",
  chapters: [{ id: 1, filePath: "sources\\scene.txt" }],
});

await project.initialize();

console.log(project.getLifecycleSnapshot());
console.log(project.getProjectSnapshot());
console.log(project.getQueueSnapshot("translation"));
console.log(project.getReadyWorkItemSnapshots());
console.log(project.getActiveWorkItems());
```

## 对齐检查 + 补充翻译示例

```ts
import {
  AlignmentRepairTool,
  DefaultTextAligner,
  LlmClientProvider,
  OpenAIEmbeddingClient,
} from "./index.ts";

const provider = new LlmClientProvider();
provider.register("repair", {
  provider: "openai",
  modelType: "chat",
  modelName: "gpt-4.1",
  endpoint: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_API_KEY",
});

const aligner = new DefaultTextAligner(
  new OpenAIEmbeddingClient({
    provider: "openai",
    modelName: "text-embedding-3-small",
    apiKey: process.env.OPENAI_API_KEY!,
    endpoint: "https://api.openai.com/v1",
    modelType: "embedding",
    retries: 3,
  }),
);

const tool = new AlignmentRepairTool(aligner, provider.getChatClient("repair"));
const result = await tool.repairMissingTranslations(
  ["原文一", "原文二", "原文三"],
  ["译文一", "译文三"],
);

console.log(result.analysis.missingUnitIds);
console.log(result.repairs);
```

## 文件格式处理示例

```ts
import {
  TranslationFileHandlerFactory,
  TranslationProject,
} from "./index.ts";

const resolver = TranslationFileHandlerFactory.createExtensionResolver({
  ".txt": "naturedialog",
  ".json": "galtransl_json",
});

const project = new TranslationProject(
  {
    projectName: "demo",
    projectDir: "./workspace",
    chapters: [{ id: 1, filePath: "sources\\scene.txt" }],
  },
  {
    fileHandlerResolver: resolver,
  },
);

await project.initialize();
```

## 全文级术语扫描示例

```ts
import {
  FullTextGlossaryScanner,
  GlossaryPersisterFactory,
  LlmClientProvider,
  TranslationProject,
} from "./index.ts";

const provider = new LlmClientProvider();
provider.register("scanner", {
  provider: "openai",
  modelType: "chat",
  modelName: "gpt-4.1",
  endpoint: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_API_KEY",
  defaultRequestConfig: {
    temperature: 0,
  },
});

const project = new TranslationProject({
  projectName: "demo",
  projectDir: "./workspace",
  chapters: [{ id: 1, filePath: "sources\\scene.txt" }],
});

await project.initialize();

const scanner = new FullTextGlossaryScanner(provider.getChatClient("scanner"));
const result = await scanner.scanDocumentManager(project.getDocumentManager(), {
  maxCharsPerBatch: 8192,
});

console.log(scanner.formatResult(result));

await GlossaryPersisterFactory.getPersister("glossary.yaml").saveGlossary(
  result.glossary,
  "glossary.yaml",
);
```

## 全局关联模式扫描示例

```ts
import {
  TranslationProject,
} from "./index.ts";

const project = new TranslationProject({
  projectName: "demo",
  projectDir: "./workspace",
  chapters: [{ id: 1, filePath: "sources\\scene.txt" }],
});

await project.initialize();

const result = project.scanGlobalAssociationPatterns({
  minOccurrences: 3,
  minLength: 8,
});

console.log(result.patterns);
console.log(project.getGlossary()?.getAllTerms());
```

当前项目层的默认 `translation` 步骤会按 `chapters` 中给定的顺序建立队列，并在“前序步骤已完成”或“词汇依赖已满足”两种条件下调度工作项。

## 文本对齐示例

```ts
import { DefaultTextAligner } from "./index.ts";

const aligner = new DefaultTextAligner(embeddingClient);
const aligned = await aligner.alignTexts(
  ["原文一", "原文二", "原文三"],
  ["译文一", "译文三"],
);

console.log(aligned);
// ["译文一", "<Omission/>", "译文三"]
```
