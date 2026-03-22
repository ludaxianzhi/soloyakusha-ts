import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import YAML from "yaml";
import { Glossary, type GlossaryTerm } from "./glossary.ts";

export abstract class GlossaryPersister {
  abstract loadGlossary(filePath: string): Promise<Glossary>;
  abstract saveGlossary(glossary: Glossary, filePath: string): Promise<void>;
}

export class JsonGlossaryPersister extends GlossaryPersister {
  override async loadGlossary(filePath: string): Promise<Glossary> {
    const data = JSON.parse(await readFile(filePath, "utf8")) as GlossaryTerm[];
    return new Glossary(data ?? []);
  }

  override async saveGlossary(glossary: Glossary, filePath: string): Promise<void> {
    await ensureParentDir(filePath);
    await writeFile(
      filePath,
      JSON.stringify(glossary.getAllTerms(), null, 2),
      "utf8",
    );
  }
}

export class CsvGlossaryPersister extends GlossaryPersister {
  constructor(private readonly delimiter = ",") {
    super();
  }

  override async loadGlossary(filePath: string): Promise<Glossary> {
    const content = await readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const [, ...rows] = lines;
    const terms = rows.map(parseDelimitedRow.bind(null, this.delimiter)).map<GlossaryTerm>(
      (columns) => ({
        term: columns[0] ?? "",
        translation: columns[1] ?? "",
        description: columns[2] || undefined,
      }),
    );
    return new Glossary(terms);
  }

  override async saveGlossary(glossary: Glossary, filePath: string): Promise<void> {
    await ensureParentDir(filePath);
    const lines = [
      ["term", "translation", "description"],
      ...glossary
        .getAllTerms()
        .map((term) => [term.term, term.translation, term.description ?? ""]),
    ].map((columns) => serializeDelimitedRow(columns, this.delimiter));

    await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  }
}

export class TsvGlossaryPersister extends CsvGlossaryPersister {
  constructor() {
    super("\t");
  }
}

export class YamlGlossaryPersister extends GlossaryPersister {
  override async loadGlossary(filePath: string): Promise<Glossary> {
    const data = YAML.parse(await readFile(filePath, "utf8")) as GlossaryTerm[] | null;
    return new Glossary(data ?? []);
  }

  override async saveGlossary(glossary: Glossary, filePath: string): Promise<void> {
    await ensureParentDir(filePath);
    await writeFile(filePath, YAML.stringify(glossary.getAllTerms()), "utf8");
  }
}

export class XmlGlossaryPersister extends GlossaryPersister {
  override async loadGlossary(filePath: string): Promise<Glossary> {
    const content = await readFile(filePath, "utf8");
    const terms: GlossaryTerm[] = [];
    const entryPattern = /<entry\s+([^>]+?)\s*\/?>/g;

    for (const match of content.matchAll(entryPattern)) {
      const attributes = parseXmlAttributes(match[1] ?? "");
      terms.push({
        term: attributes.term ?? "",
        translation: attributes.translation ?? "",
        description: attributes.description || undefined,
      });
    }

    return new Glossary(terms);
  }

  override async saveGlossary(glossary: Glossary, filePath: string): Promise<void> {
    await ensureParentDir(filePath);
    const lines = [
      '<?xml version="1.0" encoding="utf-8"?>',
      "<glossary>",
      ...glossary.getAllTerms().map((term) => {
        const attributes = [
          `term="${escapeXml(term.term)}"`,
          `translation="${escapeXml(term.translation)}"`,
          `description="${escapeXml(term.description ?? "")}"`,
        ];
        return `  <entry ${attributes.join(" ")} />`;
      }),
      "</glossary>",
      "",
    ];

    await writeFile(filePath, lines.join("\n"), "utf8");
  }
}

export class GlossaryPersisterFactory {
  static getPersister(filePath: string): GlossaryPersister {
    const suffix = extname(filePath).toLowerCase();
    if (suffix === ".json") {
      return new JsonGlossaryPersister();
    }
    if (suffix === ".csv") {
      return new CsvGlossaryPersister();
    }
    if (suffix === ".tsv") {
      return new TsvGlossaryPersister();
    }
    if (suffix === ".yaml" || suffix === ".yml") {
      return new YamlGlossaryPersister();
    }
    if (suffix === ".xml") {
      return new XmlGlossaryPersister();
    }

    throw new Error(`Unsupported glossary format: ${suffix}`);
  }
}

async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

function parseDelimitedRow(delimiter: string, row: string): string[] {
  const columns: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < row.length; index += 1) {
    const character = row[index]!;
    if (character === '"') {
      if (inQuotes && row[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === delimiter && !inQuotes) {
      columns.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  columns.push(current);
  return columns;
}

function serializeDelimitedRow(columns: string[], delimiter: string): string {
  return columns
    .map((column) => {
      const normalized = column.replaceAll('"', '""');
      return normalized.includes(delimiter) || normalized.includes('"') || normalized.includes("\n")
        ? `"${normalized}"`
        : normalized;
    })
    .join(delimiter);
}

function parseXmlAttributes(attributeString: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of attributeString.matchAll(/(\w+)="([^"]*)"/g)) {
    attributes[match[1]!] = unescapeXml(match[2] ?? "");
  }
  return attributes;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
