import { describe, expect, test } from "bun:test";
import {
  MAIN_ROUTE_ID,
  StoryTopology,
} from "./story-topology.ts";

// ===== Factory Helpers =====

function createLinearTopology(): StoryTopology {
  const topology = StoryTopology.createEmpty();
  topology.setMainRouteChapters([1, 2, 3, 4, 5]);
  return topology;
}

function createBranchedTopology(): StoryTopology {
  const topology = createLinearTopology();
  topology.addBranch({
    id: "branch-a",
    name: "分支 A",
    forkAfterChapterId: 3,
    chapters: [6, 7, 8],
  });
  topology.addBranch({
    id: "branch-b",
    name: "分支 B",
    forkAfterChapterId: 3,
    chapters: [9, 10],
  });
  return topology;
}

// ===== Tests =====

describe("StoryTopology", () => {
  describe("createEmpty", () => {
    test("creates topology with empty main route", () => {
      const topology = StoryTopology.createEmpty();
      const mainRoute = topology.getMainRoute();
      expect(mainRoute.id).toBe(MAIN_ROUTE_ID);
      expect(mainRoute.chapters).toEqual([]);
      expect(mainRoute.parentRouteId).toBeNull();
      expect(mainRoute.forkAfterChapterId).toBeNull();
    });
  });

  describe("main route management", () => {
    test("setMainRouteChapters replaces chapter list", () => {
      const topology = StoryTopology.createEmpty();
      topology.setMainRouteChapters([1, 2, 3]);
      expect(topology.getMainRoute().chapters).toEqual([1, 2, 3]);

      topology.setMainRouteChapters([10, 20]);
      expect(topology.getMainRoute().chapters).toEqual([10, 20]);
    });
  });

  describe("branch CRUD", () => {
    test("addBranch creates a new branch route", () => {
      const topology = createLinearTopology();
      const branch = topology.addBranch({
        id: "branch-a",
        name: "分支 A",
        forkAfterChapterId: 3,
        chapters: [6, 7],
      });

      expect(branch.id).toBe("branch-a");
      expect(branch.parentRouteId).toBe(MAIN_ROUTE_ID);
      expect(branch.forkAfterChapterId).toBe(3);
      expect(branch.chapters).toEqual([6, 7]);
    });

    test("addBranch defaults parentRouteId to main", () => {
      const topology = createLinearTopology();
      const branch = topology.addBranch({
        id: "b1",
        name: "B1",
        forkAfterChapterId: 1,
      });
      expect(branch.parentRouteId).toBe(MAIN_ROUTE_ID);
      expect(branch.chapters).toEqual([]);
    });

    test("addBranch with explicit parentRouteId", () => {
      const topology = createLinearTopology();
      topology.addBranch({
        id: "b1",
        name: "B1",
        forkAfterChapterId: 3,
        chapters: [6, 7],
      });
      const sub = topology.addBranch({
        id: "b1-sub",
        name: "B1 子分支",
        parentRouteId: "b1",
        forkAfterChapterId: 6,
        chapters: [11, 12],
      });
      expect(sub.parentRouteId).toBe("b1");
      expect(sub.forkAfterChapterId).toBe(6);
    });

    test("addBranch throws on duplicate id", () => {
      const topology = createLinearTopology();
      topology.addBranch({ id: "b1", name: "B1", forkAfterChapterId: 1 });
      expect(() =>
        topology.addBranch({ id: "b1", name: "B1-dup", forkAfterChapterId: 2 }),
      ).toThrow("已存在");
    });

    test("addBranch throws on reserved main id", () => {
      const topology = createLinearTopology();
      expect(() =>
        topology.addBranch({ id: MAIN_ROUTE_ID, name: "X", forkAfterChapterId: 1 }),
      ).toThrow("保留 ID");
    });

    test("addBranch throws when forkAfterChapterId not in parent", () => {
      const topology = createLinearTopology();
      expect(() =>
        topology.addBranch({ id: "b1", name: "B1", forkAfterChapterId: 99 }),
      ).toThrow("不在父路线");
    });

    test("addBranch throws when parent route not found", () => {
      const topology = createLinearTopology();
      expect(() =>
        topology.addBranch({
          id: "b1",
          name: "B1",
          parentRouteId: "nonexistent",
          forkAfterChapterId: 1,
        }),
      ).toThrow("不存在");
    });

    test("removeBranch deletes the branch", () => {
      const topology = createBranchedTopology();
      expect(topology.getRoute("branch-a")).toBeDefined();
      topology.removeBranch("branch-a");
      expect(topology.getRoute("branch-a")).toBeUndefined();
    });

    test("removeBranch cascades to descendant branches", () => {
      const topology = createLinearTopology();
      topology.addBranch({ id: "b1", name: "B1", forkAfterChapterId: 3, chapters: [6, 7] });
      topology.addBranch({
        id: "b1-sub",
        name: "B1-sub",
        parentRouteId: "b1",
        forkAfterChapterId: 6,
        chapters: [11],
      });

      topology.removeBranch("b1");
      expect(topology.getRoute("b1")).toBeUndefined();
      expect(topology.getRoute("b1-sub")).toBeUndefined();
    });

    test("removeBranch is no-op for nonexistent branch", () => {
      const topology = createLinearTopology();
      expect(() => topology.removeBranch("nonexistent")).not.toThrow();
    });

    test("removeBranch throws for main route", () => {
      const topology = createLinearTopology();
      expect(() => topology.removeBranch(MAIN_ROUTE_ID)).toThrow("不能移除主线");
    });
  });

  describe("route editing", () => {
    test("updateRoute changes name", () => {
      const topology = createBranchedTopology();
      topology.updateRoute("branch-a", { name: "新名称" });
      expect(topology.getRoute("branch-a")!.name).toBe("新名称");
    });

    test("updateRoute changes chapters", () => {
      const topology = createBranchedTopology();
      topology.updateRoute("branch-a", { chapters: [20, 21, 22] });
      expect(topology.getRoute("branch-a")!.chapters).toEqual([20, 21, 22]);
    });

    test("updateRoute changes forkAfterChapterId", () => {
      const topology = createBranchedTopology();
      topology.updateRoute("branch-a", { forkAfterChapterId: 2 });
      expect(topology.getRoute("branch-a")!.forkAfterChapterId).toBe(2);
    });

    test("updateRoute throws for invalid forkAfterChapterId", () => {
      const topology = createBranchedTopology();
      expect(() =>
        topology.updateRoute("branch-a", { forkAfterChapterId: 99 }),
      ).toThrow("不在父路线");
    });

    test("updateRoute throws for main route forkAfterChapterId", () => {
      const topology = createLinearTopology();
      expect(() =>
        topology.updateRoute(MAIN_ROUTE_ID, { forkAfterChapterId: 1 }),
      ).toThrow("主线不支持");
    });

    test("appendChapter adds to the end", () => {
      const topology = createLinearTopology();
      topology.appendChapter(MAIN_ROUTE_ID, 6);
      expect(topology.getMainRoute().chapters).toEqual([1, 2, 3, 4, 5, 6]);
    });

    test("insertChapter inserts at position", () => {
      const topology = createLinearTopology();
      topology.insertChapter(MAIN_ROUTE_ID, 99, 2);
      expect(topology.getMainRoute().chapters).toEqual([1, 2, 99, 3, 4, 5]);
    });

    test("insertChapter throws on out of bounds", () => {
      const topology = createLinearTopology();
      expect(() => topology.insertChapter(MAIN_ROUTE_ID, 99, -1)).toThrow("越界");
      expect(() => topology.insertChapter(MAIN_ROUTE_ID, 99, 100)).toThrow("越界");
    });

    test("removeChapter removes from route", () => {
      const topology = createLinearTopology();
      topology.removeChapter(MAIN_ROUTE_ID, 3);
      expect(topology.getMainRoute().chapters).toEqual([1, 2, 4, 5]);
    });

    test("removeChapter is no-op for nonexistent chapter", () => {
      const topology = createLinearTopology();
      topology.removeChapter(MAIN_ROUTE_ID, 99);
      expect(topology.getMainRoute().chapters).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe("route queries", () => {
    test("getAllRoutes returns main first", () => {
      const topology = createBranchedTopology();
      const routes = topology.getAllRoutes();
      expect(routes[0]!.id).toBe(MAIN_ROUTE_ID);
      expect(routes.length).toBe(3);
    });

    test("getBranches excludes main", () => {
      const topology = createBranchedTopology();
      const branches = topology.getBranches();
      expect(branches.every((b) => b.id !== MAIN_ROUTE_ID)).toBe(true);
      expect(branches.length).toBe(2);
    });

    test("getChildBranches returns direct children only", () => {
      const topology = createLinearTopology();
      topology.addBranch({ id: "b1", name: "B1", forkAfterChapterId: 3, chapters: [6] });
      topology.addBranch({
        id: "b1-sub",
        name: "B1-sub",
        parentRouteId: "b1",
        forkAfterChapterId: 6,
        chapters: [11],
      });

      const mainChildren = topology.getChildBranches(MAIN_ROUTE_ID);
      expect(mainChildren.map((b) => b.id)).toEqual(["b1"]);

      const b1Children = topology.getChildBranches("b1");
      expect(b1Children.map((b) => b.id)).toEqual(["b1-sub"]);
    });

    test("findRouteForChapter finds correct route", () => {
      const topology = createBranchedTopology();
      expect(topology.findRouteForChapter(1)!.id).toBe(MAIN_ROUTE_ID);
      expect(topology.findRouteForChapter(4)!.id).toBe(MAIN_ROUTE_ID);
      expect(topology.findRouteForChapter(6)!.id).toBe("branch-a");
      expect(topology.findRouteForChapter(9)!.id).toBe("branch-b");
      expect(topology.findRouteForChapter(99)).toBeUndefined();
    });
  });

  describe("topology queries", () => {
    test("getChapterSequence for main route returns all chapters", () => {
      const topology = createBranchedTopology();
      expect(topology.getChapterSequence(MAIN_ROUTE_ID)).toEqual([1, 2, 3, 4, 5]);
    });

    test("getChapterSequence for branch includes parent prefix", () => {
      const topology = createBranchedTopology();
      // branch-a forks after chapter 3, so sequence is [1,2,3] + [6,7,8]
      expect(topology.getChapterSequence("branch-a")).toEqual([1, 2, 3, 6, 7, 8]);
      expect(topology.getChapterSequence("branch-b")).toEqual([1, 2, 3, 9, 10]);
    });

    test("getChapterSequence for nested branches", () => {
      const topology = createLinearTopology();
      topology.addBranch({ id: "b1", name: "B1", forkAfterChapterId: 3, chapters: [6, 7] });
      topology.addBranch({
        id: "b1-sub",
        name: "B1-sub",
        parentRouteId: "b1",
        forkAfterChapterId: 6,
        chapters: [11, 12],
      });

      // b1-sub: main[1,2,3] + b1[6] (truncated at fork 6) + b1-sub[11,12]
      expect(topology.getChapterSequence("b1-sub")).toEqual([1, 2, 3, 6, 11, 12]);
    });

    test("getChapterSequence for nonexistent route returns empty", () => {
      const topology = createLinearTopology();
      expect(topology.getChapterSequence("nonexistent")).toEqual([]);
    });

    test("getPredecessorChapterIds for main route chapter", () => {
      const topology = createBranchedTopology();
      expect(topology.getPredecessorChapterIds(1)).toEqual([]);
      expect(topology.getPredecessorChapterIds(3)).toEqual([1, 2]);
      expect(topology.getPredecessorChapterIds(5)).toEqual([1, 2, 3, 4]);
    });

    test("getPredecessorChapterIds for branch chapter", () => {
      const topology = createBranchedTopology();
      // Chapter 6 is first in branch-a, predecessors are [1,2,3]
      expect(topology.getPredecessorChapterIds(6)).toEqual([1, 2, 3]);
      // Chapter 8 is last in branch-a, predecessors are [1,2,3,6,7]
      expect(topology.getPredecessorChapterIds(8)).toEqual([1, 2, 3, 6, 7]);
      // Chapter 9 is first in branch-b, predecessors are [1,2,3]
      expect(topology.getPredecessorChapterIds(9)).toEqual([1, 2, 3]);
    });

    test("getPredecessorChapterIds for nested branch chapter", () => {
      const topology = createLinearTopology();
      topology.addBranch({ id: "b1", name: "B1", forkAfterChapterId: 2, chapters: [6, 7] });
      topology.addBranch({
        id: "b1-sub",
        name: "Sub",
        parentRouteId: "b1",
        forkAfterChapterId: 6,
        chapters: [11, 12],
      });

      expect(topology.getPredecessorChapterIds(12)).toEqual([1, 2, 6, 11]);
    });

    test("getPredecessorChapterIds for unknown chapter returns empty", () => {
      const topology = createBranchedTopology();
      expect(topology.getPredecessorChapterIds(99)).toEqual([]);
    });

    test("getSuccessorChapterIds returns same-route successors", () => {
      const topology = createBranchedTopology();
      expect(topology.getSuccessorChapterIds(1)).toEqual([2, 3, 4, 5]);
      expect(topology.getSuccessorChapterIds(5)).toEqual([]);
      expect(topology.getSuccessorChapterIds(6)).toEqual([7, 8]);
    });

    test("isPredecessor checks correctly", () => {
      const topology = createBranchedTopology();
      expect(topology.isPredecessor(8, 3)).toBe(true);
      expect(topology.isPredecessor(8, 6)).toBe(true);
      expect(topology.isPredecessor(8, 9)).toBe(false);
      expect(topology.isPredecessor(6, 4)).toBe(false);
    });
  });

  describe("validation", () => {
    test("valid topology passes", () => {
      const topology = createBranchedTopology();
      const result = topology.validate();
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    test("detects duplicate chapter across routes", () => {
      const topology = createLinearTopology();
      topology.addBranch({ id: "b1", name: "B1", forkAfterChapterId: 3, chapters: [3, 6] });
      const result = topology.validate();
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("章节 3") && e.includes("同时出现"))).toBe(true);
    });

    test("detects invalid forkAfterChapterId", () => {
      const topology = createLinearTopology();
      topology.addBranch({ id: "b1", name: "B1", forkAfterChapterId: 3, chapters: [6] });
      // Directly mutate to create invalid state
      topology.updateRoute("b1", { chapters: [6] });
      topology.updateRoute(MAIN_ROUTE_ID, { chapters: [1, 2, 4, 5] }); // Remove chapter 3
      // Now forkAfterChapterId=3 is no longer in main
      const result = topology.validate();
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("forkAfterChapterId=3"))).toBe(true);
    });
  });

  describe("serialization", () => {
    test("toDocument and fromDocument round-trip", () => {
      const original = createBranchedTopology();
      const doc = original.toDocument();
      const restored = StoryTopology.fromDocument(doc);

      expect(restored.getMainRoute().chapters).toEqual([1, 2, 3, 4, 5]);
      expect(restored.getRoute("branch-a")!.chapters).toEqual([6, 7, 8]);
      expect(restored.getRoute("branch-b")!.chapters).toEqual([9, 10]);
    });

    test("fromDocument throws on missing main route", () => {
      expect(() =>
        StoryTopology.fromDocument({
          schemaVersion: 1,
          routes: [{ id: "other", name: "X", parentRouteId: null, forkAfterChapterId: null, chapters: [] }],
        }),
      ).toThrow("主线");
    });

    test("fromDocument throws on invalid schema version", () => {
      expect(() =>
        StoryTopology.fromDocument({ schemaVersion: 999, routes: [] }),
      ).toThrow("版本");
    });

    test("fromDocument throws on non-object input", () => {
      expect(() => StoryTopology.fromDocument("not an object")).toThrow();
    });
  });
});
