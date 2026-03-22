import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TranslationTopology } from "./topology.ts";
import type { TopologyConfig } from "./types.ts";

export class TopologyPersister {
  async loadTopology(filePath: string): Promise<TranslationTopology> {
    const config = await this.loadConfig(filePath);
    const topology = new TranslationTopology();
    topology.loadFromConfig(config);
    return topology;
  }

  async saveTopology(topology: TranslationTopology, filePath: string): Promise<void> {
    await this.saveConfig(topology.getTopologyConfig(), filePath);
  }

  async loadConfig(filePath: string): Promise<TopologyConfig> {
    const content = await readFile(filePath, "utf8");
    const config = JSON.parse(content) as Partial<TopologyConfig>;
    return {
      routes: config.routes ?? [],
      links: config.links ?? [],
    };
  }

  async saveConfig(config: TopologyConfig, filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(config, null, 2), "utf8");
  }
}
