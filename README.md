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
- `TranslationTopology` / `TopologyScanner` / `TopologyPersister`：章节路线与遍历顺序管理
- `ContextIndexBuilder` / `PrebuiltContextRetriever`：基于 embedding 的预构建上下文索引
- `TranslationProject`：面向任务的项目骨架，负责待翻译任务遍历、进度统计和结构化上下文收集

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

以及术语表管理：

- `Glossary`
- `GlossaryPersisterFactory`
- JSON / CSV / TSV / YAML / XML 术语表持久化

## 安装依赖

```bash
bun install
```

## 类型检查

```bash
bunx tsc --noEmit
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
  topology: {
    routes: [
      {
        name: "main",
        chapters: [
          { id: 1, filePath: "sources\\01.txt" },
          { id: 2, filePath: "sources\\02.txt" },
        ],
      },
    ],
    links: [{ fromChapter: 0, toRoute: "main" }],
  },
  context: {
    includeEarlierFragments: 2,
    includeEarlierChapters: true,
  },
  glossary: {
    path: "glossary.csv",
    autoFilter: true,
  },
});

await project.initialize();

const task = await project.getNextTask();
console.log(task?.sourceText, task?.contextView.getContexts());

await project.submitResult({
  chapterId: task!.chapterId,
  fragmentIndex: task!.fragmentIndex,
  translatedText: "这里写入译文",
});
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
    topology: {
      routes: [
        {
          name: "main",
          chapters: [{ id: 1, filePath: "sources\\scene.txt" }],
        },
      ],
      links: [{ fromChapter: 0, toRoute: "main" }],
    },
  },
  {
    fileHandlerResolver: resolver,
  },
);

await project.initialize();
```

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
