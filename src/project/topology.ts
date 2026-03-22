import type {
  Chapter,
  Link,
  Route,
  TopologyConfig,
} from "./types.ts";

const VIRTUAL_START_NODE = 0;
const PENDING_PARENT = -1;

export class TranslationTopology {
  private readonly chapters = new Map<number, Chapter>();
  private readonly routes = new Map<string, Route>();
  private readonly graph = new Map<number, number[]>();
  private readonly parent = new Map<number, number | null>();
  private readonly routeEntries = new Map<string, number>();
  private readonly links: Link[] = [];
  private dfsOrder: number[] = [];
  private rootChapterIds: number[] = [];
  private hasVirtualStart = false;

  addRoute(route: Route): void {
    if (route.chapters.length === 0) {
      return;
    }

    this.routes.set(route.name, route);
    this.routeEntries.set(route.name, route.chapters[0]!.id);

    let previousChapterId: number | undefined;
    for (const chapter of route.chapters) {
      this.chapters.set(chapter.id, chapter);
      if (previousChapterId !== undefined) {
        this.appendChild(previousChapterId, chapter.id);
        this.parent.set(chapter.id, previousChapterId);
      } else if (!this.parent.has(chapter.id)) {
        this.parent.set(chapter.id, PENDING_PARENT);
      }

      previousChapterId = chapter.id;
    }

    this.rebuildStructure();
  }

  addLink(link: Link): void {
    this.links.push(link);
    const targetChapterId = this.routeEntries.get(link.toRoute);
    if (targetChapterId === undefined) {
      this.rebuildStructure();
      return;
    }

    if (link.fromChapter === VIRTUAL_START_NODE) {
      this.hasVirtualStart = true;
      this.parent.set(targetChapterId, null);
      this.rebuildStructure();
      return;
    }

    if (this.chapters.has(link.fromChapter)) {
      this.appendChild(link.fromChapter, targetChapterId);
      const existingParent = this.parent.get(targetChapterId);
      if (existingParent === undefined || existingParent === null || existingParent === PENDING_PARENT) {
        this.parent.set(targetChapterId, link.fromChapter);
      }
    }

    this.rebuildStructure();
  }

  isEarlierThan(chapterId: number, targetChapterId: number): boolean {
    if (!this.chapters.has(targetChapterId)) {
      return false;
    }

    let current: number | null | undefined = targetChapterId;
    while (current !== null && current !== undefined) {
      const parent = this.parent.get(current);
      if (parent === chapterId) {
        return true;
      }
      current = parent;
    }

    return false;
  }

  getAllEarlierChapters(chapterId: number): Chapter[] {
    if (!this.chapters.has(chapterId)) {
      return [];
    }

    const ancestors: Chapter[] = [];
    let current = this.parent.get(chapterId);

    while (typeof current === "number" && current >= 0) {
      const chapter = this.chapters.get(current);
      if (chapter) {
        ancestors.push(chapter);
      }
      current = this.parent.get(current);
    }

    return ancestors.reverse();
  }

  getAllChapters(): Chapter[] {
    return Array.from(this.chapters.values());
  }

  getDfsOrderedChapters(): Chapter[] {
    return this.dfsOrder
      .map((chapterId) => this.chapters.get(chapterId))
      .filter((chapter): chapter is Chapter => chapter !== undefined);
  }

  getNextChapters(chapterId: number): Chapter[] {
    return (this.graph.get(chapterId) ?? [])
      .map((childId) => this.chapters.get(childId))
      .filter((chapter): chapter is Chapter => chapter !== undefined);
  }

  getDfsNext(chapterId: number): Chapter | undefined {
    const index = this.dfsOrder.indexOf(chapterId);
    if (index < 0) {
      return undefined;
    }

    return this.chapters.get(this.dfsOrder[index + 1] ?? -1);
  }

  getChapterById(chapterId: number): Chapter | undefined {
    return this.chapters.get(chapterId);
  }

  getRootChapters(): Chapter[] {
    return this.rootChapterIds
      .map((chapterId) => this.chapters.get(chapterId))
      .filter((chapter): chapter is Chapter => chapter !== undefined);
  }

  usesVirtualStartNode(): boolean {
    return this.hasVirtualStart;
  }

  getTopologyConfig(): TopologyConfig {
    return {
      routes: Array.from(this.routes.values()),
      links: [...this.links],
    };
  }

  loadFromConfig(config: TopologyConfig): void {
    this.chapters.clear();
    this.routes.clear();
    this.graph.clear();
    this.parent.clear();
    this.routeEntries.clear();
    this.links.splice(0, this.links.length);
    this.dfsOrder = [];
    this.rootChapterIds = [];
    this.hasVirtualStart = false;

    for (const route of config.routes) {
      this.addRoute(route);
    }

    for (const link of config.links) {
      this.addLink(link);
    }
  }

  private appendChild(parentId: number, childId: number): void {
    const children = this.graph.get(parentId) ?? [];
    if (!children.includes(childId)) {
      children.push(childId);
      this.graph.set(parentId, children);
    }
  }

  private rebuildStructure(): void {
    this.rootChapterIds = Array.from(this.chapters.keys()).filter((chapterId) => {
      const parent = this.parent.get(chapterId);
      if (this.hasVirtualStart) {
        return parent === null;
      }
      return parent === null || parent === undefined || parent === PENDING_PARENT;
    });

    this.dfsOrder = [];
    const visited = new Set<number>();
    for (const rootChapterId of this.rootChapterIds) {
      this.visitDfs(rootChapterId, visited);
    }
  }

  private visitDfs(chapterId: number, visited: Set<number>): void {
    if (visited.has(chapterId)) {
      return;
    }

    visited.add(chapterId);
    this.dfsOrder.push(chapterId);

    for (const childId of this.graph.get(chapterId) ?? []) {
      this.visitDfs(childId, visited);
    }
  }
}
