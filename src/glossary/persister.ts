/**
 * 提供术语表的多格式持久化实现，并按扩展名选择合适的读写器。
 *
 * 本模块实现术语表的文件存储能力：
 * - {@link GlossaryPersister}: 抽象持久化接口
 * - {@link JsonGlossaryPersister}: JSON 格式
 * - {@link CsvGlossaryPersister}: CSV 格式（可配置分隔符）
 * - {@link TsvGlossaryPersister}: TSV 格式
 * - {@link YamlGlossaryPersister}: YAML 格式
 * - {@link XmlGlossaryPersister}: XML 格式
 * - {@link GlossaryPersisterFactory}: 按扩展名自动选择
 *
 * @module glossary/persister
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import YAML from "yaml";
import {
  Glossary,
  type GlossaryTerm,
  type GlossaryTermCategory,
} from "./glossary.ts";

const SERIALIZED_HEADERS = [
  "term",
  "translation",
  "category",
  "totalOccurrenceCount",
  "textBlockOccurrenceCount",
  "description",
] as const;

/**
 * 术语表持久化抽象基类，定义不同文件格式共享的读写接口。
 *
 * 子类需要实现：
 * - loadGlossary: 从文件加载术语表
 * - saveGlossary: 将术语表保存到文件
 */
export abstract class GlossaryPersister {
  abstract loadGlossary(filePath: string): Promise<Glossary>;
  abstract saveGlossary(glossary: Glossary, filePath: string): Promise<void>;
}

/**
 * JSON 术语表持久化实现。
 *
 * 文件格式：GlossaryTerm[] 的 JSON 数组
 */
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

/**
 * CSV 术语表持久化实现。
 *
 * 文件格式：首行为表头，后续为数据行。
 * 支持新旧表头：
 * - 旧格式：term,translation,description
 * - 新格式：term,translation,status,category,totalOccurrenceCount,textBlockOccurrenceCount,description
 */
export class CsvGlossaryPersister extends GlossaryPersister {
  constructor(private readonly delimiter = ",") {
    super();
  }

  override async loadGlossary(filePath: string): Promise<Glossary> {
    const content = await readFile(filePath, "utf8");
    const rows = content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map(parseDelimitedRow.bind(null, this.delimiter));

    const [headerColumns, ...dataRows] = rows;
    if (!headerColumns) {
      return new Glossary();
    }

    const headerIndex = createHeaderIndex(headerColumns);
    const terms = dataRows.map((columns) => deserializeGlossaryTerm(columns, headerIndex));
    return new Glossary(terms);
  }

  override async saveGlossary(glossary: Glossary, filePath: string): Promise<void> {
    await ensureParentDir(filePath);
    const lines = [
      [...SERIALIZED_HEADERS],
      ...glossary.getAllTerms().map((term) => serializeGlossaryTerm(term)),
    ].map((columns) => serializeDelimitedRow(columns, this.delimiter));

    await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  }
}

/**
 * TSV 术语表持久化实现，使用制表符分隔。
 */
export class TsvGlossaryPersister extends CsvGlossaryPersister {
  constructor() {
    super("\t");
  }
}

/**
 * YAML 术语表持久化实现。
 *
 * 文件格式：GlossaryTerm[] 序列化为 YAML
 */
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

/**
 * XML 术语表持久化实现。
 *
 * 文件格式：
 * ```xml
 * <?xml version="1.0" encoding="utf-8"?>
 * <glossary>
 *   <entry term="原文" translation="译文" status="translated" category="personName"
 *          totalOccurrenceCount="3" textBlockOccurrenceCount="2" description="说明" />
 * </glossary>
 * ```
 */
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
        category: parseGlossaryCategory(attributes.category),
        totalOccurrenceCount: parseOptionalInteger(attributes.totalOccurrenceCount),
        textBlockOccurrenceCount: parseOptionalInteger(attributes.textBlockOccurrenceCount),
        description: normalizeOptionalString(attributes.description),
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
          `category="${escapeXml(term.category ?? "")}"`,
          `totalOccurrenceCount="${term.totalOccurrenceCount}"`,
          `textBlockOccurrenceCount="${term.textBlockOccurrenceCount}"`,
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

/**
 * 术语表持久化工厂，按文件扩展名选择对应的持久化实现。
 *
 * 支持的扩展名：.json、.csv、.tsv、.yaml、.yml、.xml
 */
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

function createHeaderIndex(headerColumns: string[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const [columnIndex, column] of headerColumns.entries()) {
    index.set(normalizeHeaderName(column), columnIndex);
  }
  return index;
}

function deserializeGlossaryTerm(
  columns: string[],
  headerIndex: Map<string, number>,
): GlossaryTerm {
  const term = getColumnValue(columns, headerIndex, ["term"], 0) ?? "";
  const translation = getColumnValue(columns, headerIndex, ["translation"], 1) ?? "";
  const description = normalizeOptionalString(
    getColumnValue(columns, headerIndex, ["description"], 2),
  );

  return {
    term,
    translation,
    category: parseGlossaryCategory(getColumnValue(columns, headerIndex, ["category"])),
    totalOccurrenceCount: parseOptionalInteger(
      getColumnValue(columns, headerIndex, ["totaloccurrencecount", "occurrencecount"]),
    ),
    textBlockOccurrenceCount: parseOptionalInteger(
      getColumnValue(columns, headerIndex, [
        "textblockoccurrencecount",
        "blockoccurrencecount",
      ]),
    ),
    description,
  };
}

function serializeGlossaryTerm(term: GlossaryTerm & {
  category?: GlossaryTermCategory;
}): string[] {
  return [
    term.term,
    term.translation,
    term.category ?? "",
    String(term.totalOccurrenceCount ?? 0),
    String(term.textBlockOccurrenceCount ?? 0),
    term.description ?? "",
  ];
}

function getColumnValue(
  columns: string[],
  headerIndex: Map<string, number>,
  candidates: string[],
  fallbackIndex?: number,
): string | undefined {
  for (const candidate of candidates) {
    const columnIndex = headerIndex.get(candidate);
    if (typeof columnIndex === "number") {
      return columns[columnIndex];
    }
  }

  if (typeof fallbackIndex === "number") {
    return columns[fallbackIndex];
  }

  return undefined;
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

function normalizeHeaderName(value: string): string {
  return value.toLowerCase().replaceAll(/[\s_-]+/g, "");
}

function parseGlossaryCategory(value: string | undefined): GlossaryTermCategory | undefined {
  if (!value) {
    return undefined;
  }

  return value === "personName" ||
      value === "placeName" ||
      value === "properNoun" ||
      value === "personTitle" ||
      value === "catchphrase"
    ? value
    : undefined;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  return value;
}
