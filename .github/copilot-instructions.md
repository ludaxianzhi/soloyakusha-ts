# Copilot Instructions

## Build, test, and static-check commands

- Install dependencies: `bun install`
- Start the single-port WebUI: `bun run webui`
- Start the split WebUI dev flow: `bun run webui:dev`
- Build the standalone WebUI executable: `bun run webui:build`
- Run the full test suite: `bun test`
- Run a single test file: `bun test src\project\translation-processor.test.ts`
- Run TypeScript static checks: `bun x tsc --noEmit`

Current baseline in this checkout:

- `bun run webui:build` succeeds and produces `dist\soloyakusha-webui.exe`
- `bun test` has one existing failure in `src\cli\dataset-generator.test.ts`
- `bun x tsc --noEmit` has existing errors in `src\cli\dataset-generator.test.ts`, `src\config\document-codec.ts`, `src\llm\provider.ts`, and `src\webui\client\src\app\ui-helpers.ts`

## High-level architecture

- `index.ts` is the public library surface. It re-exports the shared building blocks for file handlers, glossary management, LLM clients, prompt loading, project orchestration, and alignment tools.
- The core domain lives under `src\project\`. `TranslationProject` is the main facade: it wires together `TranslationDocumentManager`, `TranslationPipeline`, lifecycle recovery, workspace persistence, glossary loading, plot summaries, and snapshot generation.
- Workspace state is persisted inside each project directory, mainly under `Data\`. Important files are `Data\workspace-config.json`, `Data\project-state.json`, and `Data\Chapters\{chapterId}.json`. The default glossary path is `Data\glossary.json`.
- The default pipeline is not just a simple sequential queue. `src\project\default-translation-pipeline.ts` can dispatch work either after all prior fragments complete or earlier when glossary-term dependencies are satisfied, and it builds a `TranslationContextView` from glossary terms, previous translations, and plot summaries.
- Global user-level configuration is separate from workspace state. `GlobalConfigManager` reads and writes `%USERPROFILE%\.soloyakusha-ts\config.json`, which stores named LLM profiles, embedding config, translator definitions, auxiliary translation configs, and recent workspaces.
- The WebUI has a strict server/client split:
  - server: `src\webui\app.ts`, `src\webui\server.ts`, `src\webui\routes\`, `src\webui\services\`
  - client: `src\webui\client\src\`
  - runtime flow: the Hono server exposes REST endpoints plus SSE events from `EventBus`; the React client consumes them through `useEventStream`
- `ProjectService` in `src\webui\services\project-service.ts` is the main orchestration layer for the WebUI. It owns the active `TranslationProject`, emits snapshots/logs/progress to the SSE bus, and reuses the shared project/domain modules instead of duplicating business logic in the UI layer.

## Key conventions

- Tests are colocated with implementation files and use the `*.test.ts` naming pattern with `bun:test`.
- Prefer extending shared domain/services instead of adding UI-specific business logic. WebUI should stay as a thin wrapper over the same `src\project`, `src\config`, `src\llm`, `src\glossary`, and file-handler modules.
- Persisted config objects are normalized and validated explicitly. In `src\config\document-codec.ts`, new config fields should usually get matching normalize/clone/prune handling instead of being read from raw JSON directly.
- Translator workflows are centrally registered in `TranslationProcessorFactory`. If a change adds a new workflow or workflow-specific fields, update the factory metadata so both config APIs and UIs can discover it.
- `TranslationProject.openWorkspace(...)` and WebUI workspace reopening both rely on `Data\workspace-config.json`; treat that file as the canonical signal that a directory is an existing workspace.
- Path examples in this repository use Windows-style separators, and README examples follow that convention.
