# 工作区作用域隔离分析报告与重构方案

## 1. 现状架构

### 1.1 核心数据结构

`ProjectService` 管理多个同时运行的工作区：

```typescript
export class ProjectService {
  private readonly runtimes = new Map<string, WorkspaceRuntime>();
  private readonly runtimeByProject = new Map<TranslationProject, WorkspaceRuntime>();
  private readonly workspaceScope = new AsyncLocalStorage<string>();
  private activeWorkspaceId: string | null = null;
  private detachedProject: TranslationProject | null = null;
  private readonly detachedState = createWorkspaceRuntimeState();
}
```

每个 `WorkspaceRuntime` 包含一个独立的 `isBusy`、`snapshot`、`topology` 等状态字段。

### 1.2 `currentState` 代理模式

`ProjectService` 通过 `currentState` getter 实现动态状态分派：

```typescript
private get currentState(): WorkspaceRuntimeState {
  const scopedRuntime = this.scopedRuntime;
  if (scopedRuntime !== undefined) {
    return scopedRuntime ?? this.detachedState;
  }
  return this.activeRuntime ?? this.detachedState;
}
```

约 20 个私有 getter/setter（`isBusy`、`snapshot`、`fullSnapshot`、`topology`、`processingToken`、`pollTimer` 等）全部通过 `this.currentState` 间接访问状态。每次读写发生时，代理目标由当前的作用域上下文和活跃工作区动态决定。

### 1.3 路由层现状

| 路由文件 | 中间件 | 作用域机制 |
|---|---|---|
| `workspace.ts` | 无 | 直接调用 service 方法，不作作用域隔离 |
| `project.ts` | `runInWorkspace(workspaceId, next)` | 通过 AsyncLocalStorage + `workspaceId` query 参数隔离 |

`workspace.ts` 中的 `POST /open`、`POST /close`、`POST /active` 等路由均未使用 `runInWorkspace`。

---

## 2. 根因分析

### 2.1 `isBusy` 状态漂移问题（已修复）

`initializeProject` 方法中 `this.isBusy` 的读写通过 `currentState` 代理到**活跃工作区**的 `WorkspaceRuntimeState`。但在方法执行过程中，`setActiveWorkspace` 会切换活跃工作区，导致：

```
时间线：
  t0: 工作区 A 活跃，this.isBusy → A.state.isBusy (false) → 通过检查
  t1: this.isBusy = true → 写入 A.state.isBusy = true
  t2: registerRuntime(B) + setActiveWorkspace(B) → B 成为活跃
  t3: finally: this.isBusy = false → 写入 B.state.isBusy = false
  结果: A.state.isBusy 永久为 true
```

当工作区 B 被关闭后，A 重新成为活跃工作区。此后任何 `POST /open` 请求都会检查到 `A.state.isBusy = true`，直接返回 `false` → 前端收到 `"打开工作区失败"`。由于该分支仅产生 `warning` 级别日志 `"正在执行其他操作，请稍候"`，不产生 error 日志。

### 2.2 同类型的潜在风险

以下 getter/setter 在 `refreshSnapshot`、`broadcastSnapshot`、SSE 事件广播中被频繁访问，且都通过 `currentState` 代理：

- `snapshot` / `fullSnapshot` — 在 `refreshSnapshot()`（每秒轮询调用）和 `broadcastSnapshot()` 中读写
- `topology` — 在 SSE 拓扑事件广播中读写
- `processingToken` — 翻译循环的取消令牌
- `pollTimer` — 轮询定时器引用

当 `setActiveWorkspace` 在某一操作中途被调用时，后续对这些属性的读写目标也会随之漂移。

---

## 3. 重构方案

### 3.1 目标

| 目标 | 描述 |
|---|---|
| 状态隔离 | 每个工作区的 `WorkspaceRuntimeState` 只被显式指向它的操作修改 |
| 消除代理漂移 | 操作在开始时捕获状态引用，之后不再依赖 `currentState` 的动态分派 |
| 完善作用域机制 | 所有路由通过 `runInWorkspace` 绑定目标工作区 |

### 3.2 阶段性重构

#### 阶段一：消除代理漂移（已完成）

**已修复**：`initializeProject` 中捕获 `state` 引用，`isBusy` 的读->写->清理在同一对象上完成。

#### 阶段二：为 `workspace.ts` 添加作用域中间件

参照 `project.ts` 的模式，为 `workspace.ts` 添加中间件：

```typescript
// src/webui/routes/workspace.ts
app.post('/open', async (c) => {
  const body = await c.req.json<{ dir: string; projectName?: string }>();
  // ... 校验 ...
  const workspaceId = toWorkspaceRuntimeId(body.dir);
  const ok = await projectService.runInWorkspace(workspaceId, () =>
    projectService.initializeProject({
      projectName: body.projectName ?? 'Project',
      projectDir: body.dir,
      chapterPaths: [],
    })
  );
  // ...
});
```

由于 `initializeProject` 需要在**没有**目标工作区运行时的上下文中执行（因为目标工作区尚未打开），直接在 handler 中 `runInWorkspace` 会面临 `scopedRuntime` 为 `null` → 退化为 `detachedState` 的问题。因此该路由的修改需要配合服务层改造。

更合适的做法是：在 `initializeProject` 内部显式使用 `detachedState` 或参数化传入的状态对象，而非依赖 `this.currentState`。

#### 阶段三：将 `currentState` 代理模式替换为显式参数传递

**现状问题**：`currentState` 的动态分派是代理漂移的根源。所有通过 `this.xxx` 访问状态的代码都有潜在漂移风险。

**改造方向**：将所有内部方法的状态参数化：

```typescript
// 改造前
async startTranslation(): Promise<void> {
  const runtime = this.activeRuntime;
  // ...
}

// 改造后
async startTranslation(runtime?: WorkspaceRuntime): Promise<void> {
  const target = runtime ?? this.activeRuntime;
  // ...
}
```

#### 阶段四：统一路由层作用域绑定

所有路由的中间件/处理函数中，通过以下模式绑定工作区：

```typescript
// 通用中间件模式
app.use('/workspaces/*', async (c, next) => {
  const workspaceId = extractWorkspaceId(c);
  if (workspaceId) {
    await projectService.runInWorkspace(workspaceId, () => next());
  } else {
    await next();
  }
});
```

### 3.3 受影响方法清单

以下方法直接或间接通过 `this.currentState` 访问状态，需要审计和改造：

| 方法 | 风险等级 | 说明 |
|---|---|---|
| `initializeProject` | 高 | 已修复；内部调用 `setActiveWorkspace` |
| `refreshSnapshot` | 中 | 默认参数 `this.activeRuntime`，在定时器回调中调用 |
| `broadcastSnapshot` | 中 | 通过 SSE 广播状态 |
| `startPolling` | 低 | 显式传入 runtime 参数 |
| `closeInternal` | 低 | 显式通过 `workspaceId` 查找 runtime |
| `runAction` | 低 | 显式接收 state 参数 |
| `startTranslation` | 低 | 显式捕获 runtime |
| `pauseTranslation` | 低 | 显式捕获 runtime |
| `abortTranslation` | 低 | 显式捕获 runtime |

### 3.4 工作量估算

| 阶段 | 描述 | 预估改动量 |
|---|---|---|
| 阶段一 | 修复 `initializeProject` 的 isBusy 漂移 | 3 行改动（已完成） |
| 阶段二 | `workspace.ts` 路由添加作用域 | ~10 个路由处理函数 |
| 阶段三 | 替换 `currentState` 代理模式 | ~20 个 getter/setter + ~30 处调用点 |
| 阶段四 | 统一路由层中间件 | ~5 个路由文件 |

---

## 4. 建议

1. **短期**：方案一的修复已解决当前用户报告的 Bug。观察线上表现，确认 warning 日志 `"正在执行其他操作，请稍候"` 不再在正常的开关工作区流程中出现。

2. **中期**：执行阶段二，为 `workspace.ts` 添加作用域中间件。同时审计 `initializeProject` 中所有通过 `this.xxx` 访问状态的代码路径，确保不会因 `setActiveWorkspace` 导致类似漂移。

3. **长期**：执行阶段三，将 `currentState` 动态分派模式替换为显式参数传递。这将从根本上消除此类 Bug 的生存土壤，并提升代码的可理解性和可测试性。
