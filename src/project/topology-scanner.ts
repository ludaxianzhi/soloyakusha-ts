import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  Chapter,
  Route,
  ScanConfig,
  TopologyConfig,
} from "./types.ts";

export class TopologyScanner {
  private nextChapterId = 1;

  async scanDirectory(config: ScanConfig): Promise<TopologyConfig> {
    const rootPath = resolve(config.rootPath);
    const fileExtensions = (config.fileExtensions ?? [".txt"]).map((extension) =>
      extension.toLowerCase(),
    );
    const recursive = config.recursive ?? true;

    const routes: Route[] = [];
    const rootRoute = await this.scanRoute(rootPath, fileExtensions);
    if (rootRoute) {
      routes.push(rootRoute);
    }

    if (recursive) {
      const entries = await readdir(rootPath, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isDirectory()) {
          continue;
        }

        const route = await this.scanRoute(join(rootPath, entry.name), fileExtensions);
        if (route) {
          routes.push(route);
        }
      }
    }

    return {
      routes,
      links: routes.map((route) => ({
        fromChapter: 0,
        toRoute: route.name,
      })),
    };
  }

  resetIdCounter(startId = 1): void {
    this.nextChapterId = startId;
  }

  private async scanRoute(
    directoryPath: string,
    fileExtensions: string[],
  ): Promise<Route | undefined> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const chapterFiles = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          fileExtensions.some((extension) =>
            entry.name.toLowerCase().endsWith(extension),
          ),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map<Chapter>((entry) => ({
        id: this.nextChapterId++,
        filePath: join(directoryPath, entry.name),
      }));

    if (chapterFiles.length === 0) {
      return undefined;
    }

    return {
      name: directoryPath.split(/[/\\]/).at(-1) ?? directoryPath,
      chapters: chapterFiles,
    };
  }
}
