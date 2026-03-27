/**
 * 提供多分线剧情的拓扑管理能力，支持一条主线加任意分支的 ADV 式路线结构。
 *
 * 拓扑模型：
 * - 每条路线（Route）拥有一个有序章节列表
 * - 主线（MAIN_ROUTE_ID = "main"）是唯一没有父路线的根路线
 * - 分支路线通过 parentRouteId + forkAfterChapterId 描述其从哪条路线的哪个章节之后分叉
 * - 支持分支从分支再分叉（代码层面保持扩展性），但当前主要场景为从主线分叉
 *
 * 典型拓扑示意：
 * ```
 * 主线:         [1] → [2] → [3] → [4] → [5]
 *                              ↘
 * 分支 A (fork after 3):       [6] → [7] → [8]
 *                              ↘
 * 分支 B (fork after 3):       [9] → [10]
 * ```
 *
 * 前序章节计算示例（分支 A 中的章节 7）：
 * - 主线章节 1, 2, 3（直到 fork 点，含 fork 点）
 * - 分支 A 中章节 7 之前的章节 6
 * - 结果：[1, 2, 3, 6]
 *
 * @module project/story-topology
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// ===== 常量 =====

/** 主线路线的保留 ID */
export const MAIN_ROUTE_ID = "main";

const STORY_TOPOLOGY_SCHEMA_VERSION = 1 as const;

// ===== 类型定义 =====

/**
 * 路线定义：描述一条剧情路线及其与父路线的分叉关系。
 */
export type StoryRouteDefinition = {
  /** 路线唯一标识 */
  id: string;
  /** 路线名称（显示用） */
  name: string;
  /**
   * 父路线 ID。主线为 null，分支路线指向其分叉来源。
   */
  parentRouteId: string | null;
  /**
   * 从父路线的哪个章节之后分叉。
   * 主线为 null；分支路线必须指向父路线中的一个有效章节 ID。
   * 分叉语义：父路线中该章节及其之前的章节都是此分支的前序内容。
   */
  forkAfterChapterId: number | null;
  /** 本路线独有的章节 ID 有序列表 */
  chapters: number[];
};

/**
 * 路线更新补丁。
 */
export type StoryRoutePatch = {
  name?: string;
  forkAfterChapterId?: number;
  chapters?: number[];
};

/**
 * 持久化文件的顶层结构。
 */
export type StoryTopologyDocument = {
  schemaVersion: typeof STORY_TOPOLOGY_SCHEMA_VERSION;
  routes: StoryRouteDefinition[];
};

/**
 * 只读的路线视图。
 */
export type StoryRoute = Readonly<StoryRouteDefinition>;

/**
 * 拓扑校验结果。
 */
export type StoryTopologyValidationResult = {
  valid: boolean;
  errors: string[];
};

// ===== 主类 =====

/**
 * 多分线剧情拓扑管理器。
 *
 * 提供路线 CRUD、拓扑查询（前序章节、完整序列）和持久化能力。
 * 所有修改操作直接作用于内存状态，通过 {@link saveToFile} 手动持久化。
 */
export class StoryTopology {
  private readonly routes = new Map<string, StoryRouteDefinition>();

  private constructor() {}

  // ===== 工厂方法 =====

  /**
   * 创建一个只含空主线的拓扑实例。
   */
  static createEmpty(): StoryTopology {
    const topology = new StoryTopology();
    topology.routes.set(MAIN_ROUTE_ID, {
      id: MAIN_ROUTE_ID,
      name: "主线",
      parentRouteId: null,
      forkAfterChapterId: null,
      chapters: [],
    });
    return topology;
  }

  /**
   * 从已解析的文档对象构建拓扑实例。
   */
  static fromDocument(document: unknown): StoryTopology {
    const doc = validateStoryTopologyDocument(document);
    const topology = new StoryTopology();
    for (const route of doc.routes) {
      topology.routes.set(route.id, { ...route, chapters: [...route.chapters] });
    }

    // 确保主线存在
    if (!topology.routes.has(MAIN_ROUTE_ID)) {
      throw new Error(`拓扑文档缺少主线路线 (id="${MAIN_ROUTE_ID}")`);
    }

    return topology;
  }

  /**
   * 将当前拓扑序列化为持久化文档。
   */
  toDocument(): StoryTopologyDocument {
    return {
      schemaVersion: STORY_TOPOLOGY_SCHEMA_VERSION,
      routes: this.getAllRoutes().map((route) => ({
        ...route,
        chapters: [...route.chapters],
      })),
    };
  }

  // ===== 持久化 =====

  /**
   * 从 JSON 文件加载拓扑。文件不存在时返回空拓扑。
   */
  static async loadFromFile(filePath: string): Promise<StoryTopology> {
    try {
      const content = await readFile(filePath, "utf8");
      return StoryTopology.fromDocument(JSON.parse(content));
    } catch (error) {
      if (isMissingFileError(error)) {
        return StoryTopology.createEmpty();
      }
      throw error;
    }
  }

  /**
   * 将当前拓扑保存为 JSON 文件。
   */
  async saveToFile(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(this.toDocument(), null, 2), "utf8");
  }

  // ===== 路线查询 =====

  /**
   * 获取主线路线。
   */
  getMainRoute(): StoryRoute {
    return this.getRequiredRoute(MAIN_ROUTE_ID);
  }

  /**
   * 按 ID 获取路线。
   */
  getRoute(routeId: string): StoryRoute | undefined {
    const route = this.routes.get(routeId);
    return route ? freezeRoute(route) : undefined;
  }

  /**
   * 获取所有路线（主线在前，分支在后）。
   */
  getAllRoutes(): StoryRoute[] {
    const result: StoryRoute[] = [];
    const mainRoute = this.routes.get(MAIN_ROUTE_ID);
    if (mainRoute) {
      result.push(freezeRoute(mainRoute));
    }
    for (const route of this.routes.values()) {
      if (route.id !== MAIN_ROUTE_ID) {
        result.push(freezeRoute(route));
      }
    }
    return result;
  }

  /**
   * 获取所有分支路线（不含主线）。
   */
  getBranches(): StoryRoute[] {
    return this.getAllRoutes().filter((route) => route.id !== MAIN_ROUTE_ID);
  }

  /**
   * 获取指定路线的所有直接子分支。
   */
  getChildBranches(routeId: string): StoryRoute[] {
    return this.getAllRoutes().filter((route) => route.parentRouteId === routeId);
  }

  // ===== 路线编辑 =====

  /**
   * 设置主线的章节列表。
   */
  setMainRouteChapters(chapterIds: number[]): void {
    const mainRoute = this.getRequiredMutableRoute(MAIN_ROUTE_ID);
    mainRoute.chapters = [...chapterIds];
  }

  /**
   * 添加一条分支路线。
   *
   * @param definition - 分支路线定义
   * @returns 新创建的路线（只读视图）
   */
  addBranch(definition: {
    id: string;
    name: string;
    forkAfterChapterId: number;
    chapters?: number[];
    parentRouteId?: string;
  }): StoryRoute {
    if (definition.id === MAIN_ROUTE_ID) {
      throw new Error(`不能使用保留 ID "${MAIN_ROUTE_ID}" 作为分支路线 ID`);
    }
    if (this.routes.has(definition.id)) {
      throw new Error(`路线 ID 已存在: ${definition.id}`);
    }

    const parentRouteId = definition.parentRouteId ?? MAIN_ROUTE_ID;
    const parentRoute = this.routes.get(parentRouteId);
    if (!parentRoute) {
      throw new Error(`父路线不存在: ${parentRouteId}`);
    }
    if (!parentRoute.chapters.includes(definition.forkAfterChapterId)) {
      throw new Error(
        `分叉章节 ${definition.forkAfterChapterId} 不在父路线 "${parentRouteId}" 中`,
      );
    }

    const route: StoryRouteDefinition = {
      id: definition.id,
      name: definition.name,
      parentRouteId,
      forkAfterChapterId: definition.forkAfterChapterId,
      chapters: [...(definition.chapters ?? [])],
    };

    this.routes.set(route.id, route);
    return freezeRoute(route);
  }

  /**
   * 移除一条分支路线。同时移除所有以此路线为父路线的后代分支。
   *
   * @throws 如果尝试移除主线
   */
  removeBranch(routeId: string): void {
    if (routeId === MAIN_ROUTE_ID) {
      throw new Error("不能移除主线");
    }
    if (!this.routes.has(routeId)) {
      return;
    }

    // 级联删除后代分支
    const descendants = this.collectDescendantRouteIds(routeId);
    for (const id of descendants) {
      this.routes.delete(id);
    }
    this.routes.delete(routeId);
  }

  /**
   * 更新路线属性。
   *
   * @param routeId - 路线 ID
   * @param patch - 要更新的字段
   */
  updateRoute(routeId: string, patch: StoryRoutePatch): void {
    const route = this.getRequiredMutableRoute(routeId);

    if (patch.name !== undefined) {
      route.name = patch.name;
    }

    if (patch.forkAfterChapterId !== undefined) {
      if (routeId === MAIN_ROUTE_ID) {
        throw new Error("主线不支持设置 forkAfterChapterId");
      }
      if (route.parentRouteId) {
        const parentRoute = this.routes.get(route.parentRouteId);
        if (parentRoute && !parentRoute.chapters.includes(patch.forkAfterChapterId)) {
          throw new Error(
            `分叉章节 ${patch.forkAfterChapterId} 不在父路线 "${route.parentRouteId}" 中`,
          );
        }
      }
      route.forkAfterChapterId = patch.forkAfterChapterId;
    }

    if (patch.chapters !== undefined) {
      route.chapters = [...patch.chapters];
    }
  }

  /**
   * 向路线末尾追加一个章节。
   */
  appendChapter(routeId: string, chapterId: number): void {
    const route = this.getRequiredMutableRoute(routeId);
    route.chapters.push(chapterId);
  }

  /**
   * 在路线的指定位置插入一个章节。
   */
  insertChapter(routeId: string, chapterId: number, atIndex: number): void {
    const route = this.getRequiredMutableRoute(routeId);
    if (atIndex < 0 || atIndex > route.chapters.length) {
      throw new Error(
        `插入位置越界: atIndex=${atIndex}, length=${route.chapters.length}`,
      );
    }
    route.chapters.splice(atIndex, 0, chapterId);
  }

  /**
   * 从路线中移除一个章节。
   */
  removeChapter(routeId: string, chapterId: number): void {
    const route = this.getRequiredMutableRoute(routeId);
    const index = route.chapters.indexOf(chapterId);
    if (index !== -1) {
      route.chapters.splice(index, 1);
    }
  }

  // ===== 拓扑查询 =====

  /**
   * 查找包含指定章节的路线。
   *
   * 如果同一章节出现在多条路线中（不推荐），返回第一条匹配路线。
   */
  findRouteForChapter(chapterId: number): StoryRoute | undefined {
    for (const route of this.routes.values()) {
      if (route.chapters.includes(chapterId)) {
        return freezeRoute(route);
      }
    }
    return undefined;
  }

  /**
   * 获取路线的完整章节序列，包含从根路线（主线）到当前路线的所有前序章节。
   *
   * 例如，主线 [1,2,3,4,5]，分支 A（fork after 3）[6,7,8]
   * → getChapterSequence("branch-a") = [1,2,3,6,7,8]
   */
  getChapterSequence(routeId: string): number[] {
    const route = this.routes.get(routeId);
    if (!route) {
      return [];
    }

    // 从当前路线沿父链向上收集所有祖先路线
    const ancestorChain = this.buildAncestorChain(routeId);

    const sequence: number[] = [];
    for (const ancestor of ancestorChain) {
      if (ancestor.forkAfterChapterId === null) {
        // 根路线：取全部章节
        sequence.push(...ancestor.chapters);
      } else {
        // 中间/当前路线：取父路线中 fork 点之前（含 fork 点）的章节已由上层处理
        // 此处只追加本路线自有的章节
        sequence.push(...ancestor.chapters);
      }
    }

    return sequence;
  }

  /**
   * 获取指定章节的所有前序章节 ID（不含自身）。
   *
   * 语义：在该章节所在路线的完整章节序列中，该章节之前的所有章节。
   */
  getPredecessorChapterIds(chapterId: number): number[] {
    const route = this.findRouteForChapter(chapterId);
    if (!route) {
      return [];
    }

    const sequence = this.getChapterSequence(route.id);
    const index = sequence.indexOf(chapterId);
    if (index <= 0) {
      return [];
    }

    return sequence.slice(0, index);
  }

  /**
   * 获取指定章节的所有后继章节 ID（不含自身），限于同一路线。
   */
  getSuccessorChapterIds(chapterId: number): number[] {
    const route = this.findRouteForChapter(chapterId);
    if (!route) {
      return [];
    }

    const indexInRoute = route.chapters.indexOf(chapterId);
    if (indexInRoute === -1 || indexInRoute >= route.chapters.length - 1) {
      return [];
    }

    return route.chapters.slice(indexInRoute + 1);
  }

  /**
   * 判断 candidateId 是否是 chapterId 的前序章节。
   */
  isPredecessor(chapterId: number, candidateId: number): boolean {
    return this.getPredecessorChapterIds(chapterId).includes(candidateId);
  }

  // ===== 校验 =====

  /**
   * 校验拓扑完整性。
   *
   * 检查项：
   * - 主线存在
   * - 所有分支的 parentRouteId 指向已存在的路线
   * - 所有分支的 forkAfterChapterId 存在于其父路线中
   * - 章节不在多条路线中重复出现
   * - 路线父链无环
   */
  validate(): StoryTopologyValidationResult {
    const errors: string[] = [];

    // 1. 主线存在
    if (!this.routes.has(MAIN_ROUTE_ID)) {
      errors.push(`缺少主线路线 (id="${MAIN_ROUTE_ID}")`);
    }

    // 2. 章节去重检查
    const chapterOwnership = new Map<number, string>();
    for (const route of this.routes.values()) {
      for (const chapterId of route.chapters) {
        const existing = chapterOwnership.get(chapterId);
        if (existing) {
          errors.push(
            `章节 ${chapterId} 同时出现在路线 "${existing}" 和 "${route.id}" 中`,
          );
        } else {
          chapterOwnership.set(chapterId, route.id);
        }
      }
    }

    // 3. 分支指向校验
    for (const route of this.routes.values()) {
      if (route.id === MAIN_ROUTE_ID) {
        continue;
      }

      if (!route.parentRouteId) {
        errors.push(`分支 "${route.id}" 缺少 parentRouteId`);
        continue;
      }

      const parentRoute = this.routes.get(route.parentRouteId);
      if (!parentRoute) {
        errors.push(`分支 "${route.id}" 的父路线 "${route.parentRouteId}" 不存在`);
        continue;
      }

      if (route.forkAfterChapterId === null) {
        errors.push(`分支 "${route.id}" 缺少 forkAfterChapterId`);
      } else if (!parentRoute.chapters.includes(route.forkAfterChapterId)) {
        errors.push(
          `分支 "${route.id}" 的 forkAfterChapterId=${route.forkAfterChapterId} 不在父路线 "${route.parentRouteId}" 中`,
        );
      }
    }

    // 4. 环检测
    for (const route of this.routes.values()) {
      const visited = new Set<string>();
      let current: StoryRouteDefinition | undefined = route;
      while (current) {
        if (visited.has(current.id)) {
          errors.push(`路线 "${route.id}" 的父链存在环`);
          break;
        }
        visited.add(current.id);
        current = current.parentRouteId
          ? this.routes.get(current.parentRouteId)
          : undefined;
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // ===== 私有工具 =====

  /**
   * 构建从根路线到指定路线的祖先链（含自身）。
   *
   * 返回值顺序：从根（主线）到当前路线。
   * 每个元素附带其在父路线中的截断信息（取到 fork 点为止）。
   */
  private buildAncestorChain(routeId: string): AncestorChainEntry[] {
    const chain: AncestorChainEntry[] = [];
    let currentId: string | null = routeId;

    // 从当前路线沿父链向上收集
    while (currentId) {
      const route = this.routes.get(currentId);
      if (!route) {
        break;
      }
      chain.unshift({
        id: route.id,
        chapters: route.chapters,
        forkAfterChapterId: route.forkAfterChapterId,
        parentRouteId: route.parentRouteId,
      });
      currentId = route.parentRouteId;
    }

    // 对于祖先路线，截断至 fork 点（含 fork 点）
    // chain[0] 是根（主线），chain[last] 是目标路线
    // chain[i] 的 chapters 应该截断到 chain[i+1].forkAfterChapterId
    for (let i = 0; i < chain.length - 1; i++) {
      const current = chain[i];
      const next = chain[i + 1];
      if (!current || !next) {
        continue;
      }
      const nextFork = next.forkAfterChapterId;
      if (nextFork !== null) {
        const forkIndex = current.chapters.indexOf(nextFork);
        if (forkIndex !== -1) {
          current.chapters = current.chapters.slice(0, forkIndex + 1);
        }
      }
    }

    return chain;
  }

  /**
   * 递归收集指定路线的所有后代路线 ID。
   */
  private collectDescendantRouteIds(routeId: string): string[] {
    const descendants: string[] = [];
    for (const route of this.routes.values()) {
      if (route.parentRouteId === routeId) {
        descendants.push(route.id);
        descendants.push(...this.collectDescendantRouteIds(route.id));
      }
    }
    return descendants;
  }

  private getRequiredRoute(routeId: string): StoryRoute {
    const route = this.routes.get(routeId);
    if (!route) {
      throw new Error(`路线不存在: ${routeId}`);
    }
    return freezeRoute(route);
  }

  private getRequiredMutableRoute(routeId: string): StoryRouteDefinition {
    const route = this.routes.get(routeId);
    if (!route) {
      throw new Error(`路线不存在: ${routeId}`);
    }
    return route;
  }
}

// ===== 内部类型 =====

type AncestorChainEntry = {
  id: string;
  chapters: number[];
  forkAfterChapterId: number | null;
  parentRouteId: string | null;
};

// ===== 纯函数工具 =====

function freezeRoute(route: StoryRouteDefinition): StoryRoute {
  return {
    id: route.id,
    name: route.name,
    parentRouteId: route.parentRouteId,
    forkAfterChapterId: route.forkAfterChapterId,
    chapters: [...route.chapters],
  };
}

function validateStoryTopologyDocument(document: unknown): StoryTopologyDocument {
  if (!isRecord(document)) {
    throw new Error("拓扑文档顶层必须是对象");
  }

  if (document.schemaVersion !== STORY_TOPOLOGY_SCHEMA_VERSION) {
    throw new Error(
      `拓扑文档版本不受支持: ${String(document.schemaVersion)}`,
    );
  }

  if (!Array.isArray(document.routes)) {
    throw new Error("拓扑文档必须包含 routes 数组");
  }

  const routes: StoryRouteDefinition[] = [];
  for (const raw of document.routes) {
    if (!isRecord(raw)) {
      throw new Error("路线定义必须是对象");
    }

    routes.push({
      id: String(raw.id ?? ""),
      name: String(raw.name ?? ""),
      parentRouteId: raw.parentRouteId === null || raw.parentRouteId === undefined
        ? null
        : String(raw.parentRouteId),
      forkAfterChapterId: raw.forkAfterChapterId === null || raw.forkAfterChapterId === undefined
        ? null
        : Number(raw.forkAfterChapterId),
      chapters: Array.isArray(raw.chapters)
        ? raw.chapters.map((id) => Number(id))
        : [],
    });
  }

  return { schemaVersion: STORY_TOPOLOGY_SCHEMA_VERSION, routes };
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
