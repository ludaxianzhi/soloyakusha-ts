import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SavedRepetitionPatternAnalysisResult } from "../analysis/repetition-pattern-analysis.ts";
import type {
  ChapterEntry,
  FragmentAuxData,
  FragmentEntry,
  FragmentPipelineStepState,
  TranslationDependencyGraph,
  TextFragment,
  TranslationProjectState,
  TranslationUnitMetadata,
  WorkspaceConfig,
} from "../types.ts";

const WRITE_QUEUES = new Map<string, Promise<void>>();

type FragmentRow = {
  chapter_id: number;
  fragment_index: number;
  hash: string;
  line_count: number;
  aux_data_json: string;
};

type FragmentLineRow = {
  chapter_id: number;
  fragment_index: number;
  line_index: number;
  source: string;
  translation: string;
  metadata_json: string | null;
  target_groups_json: string | null;
  extend: string;
  comment: string;
};

type PipelineStepStateRow = {
  chapter_id: number;
  fragment_index: number;
  step_id: string;
  state_json: string;
};

type ChapterRow = {
  chapter_id: number;
  file_path: string;
  fragment_count: number;
  source_line_count: number;
  translated_line_count: number;
};

export type PersistedChapterIndex = {
  chapterId: number;
  filePath: string;
  fragmentHashes: string[];
};

export class SqliteProjectStorage {
  constructor(readonly databasePath: string) {}

  async loadWorkspaceConfig(): Promise<WorkspaceConfig | undefined> {
    return this.readMetadata<WorkspaceConfig>("workspace_config");
  }

  async saveWorkspaceConfig(config: WorkspaceConfig): Promise<void> {
    await this.writeMetadata("workspace_config", config);
  }

  async loadProjectState(): Promise<TranslationProjectState | undefined> {
    return this.readMetadata<TranslationProjectState>("project_state");
  }

  async saveProjectState(state: TranslationProjectState): Promise<void> {
    await this.writeMetadata("project_state", state);
  }

  async loadTranslationDependencyGraph(): Promise<TranslationDependencyGraph | undefined> {
    return this.readMetadata<TranslationDependencyGraph>("translation_dependency_graph");
  }

  async saveTranslationDependencyGraph(graph: TranslationDependencyGraph): Promise<void> {
    await this.writeMetadata("translation_dependency_graph", graph);
  }

  async clearTranslationDependencyGraph(): Promise<void> {
    await this.deleteMetadata("translation_dependency_graph");
  }

  async loadSavedRepetitionPatternAnalysis(): Promise<
    SavedRepetitionPatternAnalysisResult | undefined
  > {
    return this.readMetadata<SavedRepetitionPatternAnalysisResult>(
      "saved_repetition_pattern_analysis",
    );
  }

  async saveSavedRepetitionPatternAnalysis(
    result: SavedRepetitionPatternAnalysisResult,
  ): Promise<void> {
    await this.writeMetadata("saved_repetition_pattern_analysis", result);
  }

  async clearSavedRepetitionPatternAnalysis(): Promise<void> {
    await this.deleteMetadata("saved_repetition_pattern_analysis");
  }

  async loadChapter(chapterId: number): Promise<ChapterEntry | undefined> {
    return this.loadChapterSync(chapterId);
  }

  loadChapterSync(chapterId: number): ChapterEntry | undefined {
    const db = this.openDatabase();
    try {
      const chapterRow = db
        .query(
          `SELECT chapter_id, file_path, fragment_count, source_line_count, translated_line_count
             FROM chapters
            WHERE chapter_id = ?1`,
        )
        .get(chapterId) as ChapterRow | null;
      if (!chapterRow) {
        return undefined;
      }

      const fragmentRows = db
        .query(
          `SELECT chapter_id, fragment_index, hash, line_count, aux_data_json
             FROM fragments
            WHERE chapter_id = ?1
            ORDER BY fragment_index`,
        )
        .all(chapterId) as FragmentRow[];

      const lineRows = db
        .query(
          `SELECT chapter_id, fragment_index, line_index, source, translation, metadata_json, target_groups_json, extend, comment
             FROM fragment_lines
            WHERE chapter_id = ?1
            ORDER BY fragment_index, line_index`,
        )
        .all(chapterId) as FragmentLineRow[];

      const pipelineRows = db
        .query(
          `SELECT chapter_id, fragment_index, step_id, state_json
             FROM pipeline_step_states
            WHERE chapter_id = ?1
            ORDER BY fragment_index, step_id`,
        )
        .all(chapterId) as PipelineStepStateRow[];

      return hydrateChapter(chapterRow, fragmentRows, lineRows, pipelineRows);
    } finally {
      db.close();
    }
  }

  loadAllChapterIndexesSync(): Map<number, PersistedChapterIndex> {
    const db = this.openDatabase();
    try {
      const rows = db
        .query(
          `SELECT c.chapter_id, c.file_path, f.fragment_index, f.hash
             FROM chapters c
             LEFT JOIN fragments f ON f.chapter_id = c.chapter_id
            ORDER BY c.chapter_id, f.fragment_index`,
        )
        .all() as Array<{ chapter_id: number; file_path: string; fragment_index: number | null; hash: string | null }>;

      const result = new Map<number, PersistedChapterIndex>();
      for (const row of rows) {
        let entry = result.get(row.chapter_id);
        if (!entry) {
          entry = {
            chapterId: row.chapter_id,
            filePath: row.file_path,
            fragmentHashes: [],
          };
          result.set(row.chapter_id, entry);
        }
        if (row.fragment_index !== null && row.hash !== null) {
          entry.fragmentHashes[row.fragment_index] = row.hash;
        }
      }
      return result;
    } finally {
      db.close();
    }
  }

  loadAllChaptersSync(): ChapterEntry[] {
    const db = this.openDatabase();
    try {
      const chapterRows = db
        .query(
          `SELECT chapter_id, file_path, fragment_count, source_line_count, translated_line_count
             FROM chapters
            ORDER BY chapter_id`,
        )
        .all() as ChapterRow[];

      const fragmentRows = db
        .query(
          `SELECT chapter_id, fragment_index, hash, line_count, aux_data_json
             FROM fragments
            ORDER BY chapter_id, fragment_index`,
        )
        .all() as FragmentRow[];

      const lineRows = db
        .query(
          `SELECT chapter_id, fragment_index, line_index, source, translation, metadata_json, target_groups_json, extend, comment
             FROM fragment_lines
            ORDER BY chapter_id, fragment_index, line_index`,
        )
        .all() as FragmentLineRow[];

      const pipelineRows = db
        .query(
          `SELECT chapter_id, fragment_index, step_id, state_json
             FROM pipeline_step_states
            ORDER BY chapter_id, fragment_index, step_id`,
        )
        .all() as PipelineStepStateRow[];

      const chaptersByKey = new Map<number, {
        chapterRow: ChapterRow;
        fragments: FragmentRow[];
        lines: Map<number, FragmentLineRow[]>;
        pipelines: Map<number, PipelineStepStateRow[]>;
      }>();

      for (const cr of chapterRows) {
        chaptersByKey.set(cr.chapter_id, {
          chapterRow: cr,
          fragments: [],
          lines: new Map(),
          pipelines: new Map(),
        });
      }

      for (const fr of fragmentRows) {
        const bucket = chaptersByKey.get(fr.chapter_id);
        if (bucket) {
          bucket.fragments.push(fr);
        }
      }

      for (const lr of lineRows) {
        const bucket = chaptersByKey.get(lr.chapter_id);
        if (bucket) {
          const lines = bucket.lines.get(lr.fragment_index) ?? [];
          lines[lr.line_index] = lr;
          bucket.lines.set(lr.fragment_index, lines);
        }
      }

      for (const pr of pipelineRows) {
        const bucket = chaptersByKey.get(pr.chapter_id);
        if (bucket) {
          const pipes = bucket.pipelines.get(pr.fragment_index) ?? [];
          pipes.push(pr);
          bucket.pipelines.set(pr.fragment_index, pipes);
        }
      }

      return [...chaptersByKey.values()].map((bucket) => {
        bucket.fragments.sort((a, b) => a.fragment_index - b.fragment_index);
        const flatLines: FragmentLineRow[] = [];
        for (const arr of bucket.lines.values()) {
          for (const lr of arr) {
            if (lr) flatLines.push(lr);
          }
        }
        const flatPipelines: PipelineStepStateRow[] = [];
        for (const arr of bucket.pipelines.values()) {
          for (const pr of arr) {
            if (pr) flatPipelines.push(pr);
          }
        }
        return hydrateChapter(bucket.chapterRow, bucket.fragments, flatLines, flatPipelines);
      });
    } finally {
      db.close();
    }
  }

  loadChapterDescriptorsSync(): Map<number, { fragmentCount: number; sourceLineCount: number; translatedLineCount: number }> {
    const db = this.openDatabase();
    try {
      const rows = db
        .query(
          `SELECT chapter_id, fragment_count, source_line_count, translated_line_count
             FROM chapters
            ORDER BY chapter_id`,
        )
        .all() as ChapterRow[];

      const result = new Map<number, { fragmentCount: number; sourceLineCount: number; translatedLineCount: number }>();
      for (const row of rows) {
        result.set(row.chapter_id, {
          fragmentCount: row.fragment_count,
          sourceLineCount: row.source_line_count,
          translatedLineCount: row.translated_line_count,
        });
      }
      return result;
    } finally {
      db.close();
    }
  }

  async loadChapterIndex(chapterId: number): Promise<PersistedChapterIndex | undefined> {
    return this.loadChapterIndexSync(chapterId);
  }

  loadChapterIndexSync(chapterId: number): PersistedChapterIndex | undefined {
    const db = this.openDatabase();
    try {
      const chapterRow = db
        .query(
          `SELECT chapter_id, file_path
             FROM chapters
            WHERE chapter_id = ?1`,
        )
        .get(chapterId) as { chapter_id: number; file_path: string } | null;
      if (!chapterRow) {
        return undefined;
      }

      const fragmentRows = db
        .query(
          `SELECT fragment_index, hash
             FROM fragments
            WHERE chapter_id = ?1
            ORDER BY fragment_index`,
        )
        .all(chapterId) as Array<{ fragment_index: number; hash: string }>;

      return {
        chapterId: chapterRow.chapter_id,
        filePath: chapterRow.file_path,
        fragmentHashes: fragmentRows.map((row) => row.hash),
      };
    } finally {
      db.close();
    }
  }

  async saveChapter(chapter: ChapterEntry): Promise<void> {
    await this.enqueueWrite(async (db) => {
      this.replaceChapter(db, chapter);
    });
  }

  async deleteChapter(chapterId: number): Promise<void> {
    await this.enqueueWrite(async (db) => {
      db.query(`DELETE FROM chapters WHERE chapter_id = ?1`).run(chapterId);
    });
  }

  async updateFragmentTranslation(
    chapterId: number,
    fragmentIndex: number,
    translation: TextFragment,
    targetGroupPerLine?: string[][],
  ): Promise<void> {
    await this.enqueueWrite(async (db) => {
      this.replaceFragmentTranslations(db, chapterId, fragmentIndex, translation.lines);
      if (targetGroupPerLine) {
        this.applyTargetGroups(db, chapterId, fragmentIndex, targetGroupPerLine);
      }
      this.recalculateChapterTranslatedLineCount(db, chapterId);
    });
  }

  async updateTranslatedLine(
    chapterId: number,
    fragmentIndex: number,
    lineIndex: number,
    translation: string,
  ): Promise<void> {
    await this.enqueueWrite(async (db) => {
      db.query(
        `UPDATE fragment_lines
            SET translation = ?4
          WHERE chapter_id = ?1
            AND fragment_index = ?2
            AND line_index = ?3`,
      ).run(chapterId, fragmentIndex, lineIndex, translation);
      this.recalculateChapterTranslatedLineCount(db, chapterId);
    });
  }

  async savePipelineStepState(
    chapterId: number,
    fragmentIndex: number,
    stepId: string,
    state: FragmentPipelineStepState,
  ): Promise<void> {
    await this.enqueueWrite(async (db) => {
      this.upsertPipelineStepState(db, chapterId, fragmentIndex, stepId, state);
    });
  }

  async savePipelineStepStates(
    states: Array<{
      chapterId: number;
      fragmentIndex: number;
      stepId: string;
      state: FragmentPipelineStepState;
    }>,
  ): Promise<void> {
    if (states.length === 0) {
      return;
    }

    await this.enqueueWrite(async (db) => {
      for (const item of states) {
        this.upsertPipelineStepState(
          db,
          item.chapterId,
          item.fragmentIndex,
          item.stepId,
          item.state,
        );
      }
    });
  }

  async saveStepStateAndTranslation(
    chapterId: number,
    fragmentIndex: number,
    stepId: string,
    state: FragmentPipelineStepState,
    translation: TextFragment,
    stepTranslations?: string[][],
  ): Promise<void> {
    await this.enqueueWrite(async (db) => {
      this.upsertPipelineStepState(db, chapterId, fragmentIndex, stepId, state);
      this.replaceFragmentTranslations(db, chapterId, fragmentIndex, translation.lines);
      this.recalculateChapterTranslatedLineCount(db, chapterId);
      if (stepTranslations && stepTranslations.length > 0) {
        this.replaceFragmentTargetGroups(db, chapterId, fragmentIndex, stepTranslations);
      }
    });
  }

  async updateFragmentAuxData(
    chapterId: number,
    fragmentIndex: number,
    auxData: FragmentAuxData,
  ): Promise<void> {
    await this.enqueueWrite(async (db) => {
      db.query(
        `UPDATE fragments
            SET aux_data_json = ?3
          WHERE chapter_id = ?1
            AND fragment_index = ?2`,
      ).run(chapterId, fragmentIndex, JSON.stringify(auxData));
    });
  }

  async saveStepStateAndFragmentAuxData(
    chapterId: number,
    fragmentIndex: number,
    stepId: string,
    state: FragmentPipelineStepState,
    auxData: FragmentAuxData,
  ): Promise<void> {
    await this.enqueueWrite(async (db) => {
      this.upsertPipelineStepState(db, chapterId, fragmentIndex, stepId, state);
      db.query(
        `UPDATE fragments
            SET aux_data_json = ?3
          WHERE chapter_id = ?1
            AND fragment_index = ?2`,
      ).run(chapterId, fragmentIndex, JSON.stringify(auxData));
    });
  }

  async saveStepStateTranslationAndAuxData(
    chapterId: number,
    fragmentIndex: number,
    stepId: string,
    state: FragmentPipelineStepState,
    translation: TextFragment,
    auxData: FragmentAuxData,
    stepTranslations?: string[][],
  ): Promise<void> {
    await this.enqueueWrite(async (db) => {
      this.upsertPipelineStepState(db, chapterId, fragmentIndex, stepId, state);
      this.replaceFragmentTranslations(db, chapterId, fragmentIndex, translation.lines);
      this.recalculateChapterTranslatedLineCount(db, chapterId);
      db.query(
        `UPDATE fragments
            SET aux_data_json = ?3
          WHERE chapter_id = ?1
            AND fragment_index = ?2`,
      ).run(chapterId, fragmentIndex, JSON.stringify(auxData));
      if (stepTranslations && stepTranslations.length > 0) {
        this.replaceFragmentTargetGroups(db, chapterId, fragmentIndex, stepTranslations);
      }
    });
  }

  async updateChaptersLineCount(
    chapterId: number,
    sourceLineCount: number,
    translatedLineCount: number,
  ): Promise<void> {
    await this.enqueueWrite(async (db) => {
      db.query(
        `UPDATE chapters
            SET source_line_count = ?2, translated_line_count = ?3
          WHERE chapter_id = ?1`,
      ).run(chapterId, sourceLineCount, translatedLineCount);
    });
  }

  getFragmentLine(
    chapterId: number,
    fragmentIndex: number,
    lineIndex: number,
  ): {
    source: string;
    translation: string;
    metadata_json: string | null;
    target_groups_json: string | null;
    extend: string;
    comment: string;
  } | undefined {
    const db = this.openDatabase();
    try {
      return db
        .query(
          `SELECT source, translation, metadata_json, target_groups_json, extend, comment
             FROM fragment_lines
            WHERE chapter_id = ?1
              AND fragment_index = ?2
              AND line_index = ?3`,
        )
        .get(chapterId, fragmentIndex, lineIndex) as {
          source: string;
          translation: string;
          metadata_json: string | null;
          target_groups_json: string | null;
          extend: string;
          comment: string;
        } | null ?? undefined;
    } finally {
      db.close();
    }
  }

  async updateFragmentLineExtend(
    chapterId: number,
    fragmentIndex: number,
    lineIndex: number,
    extend: string,
  ): Promise<void> {
    await this.enqueueWrite(async (db) => {
      db.query(
        `UPDATE fragment_lines
            SET extend = ?4
          WHERE chapter_id = ?1
            AND fragment_index = ?2
            AND line_index = ?3`,
      ).run(chapterId, fragmentIndex, lineIndex, extend);
    });
  }

  async updateFragmentLineComment(
    chapterId: number,
    fragmentIndex: number,
    lineIndex: number,
    comment: string,
  ): Promise<void> {
    await this.enqueueWrite(async (db) => {
      db.query(
        `UPDATE fragment_lines
            SET comment = ?4
          WHERE chapter_id = ?1
            AND fragment_index = ?2
            AND line_index = ?3`,
      ).run(chapterId, fragmentIndex, lineIndex, comment);
    });
  }

  private async readMetadata<T>(key: string): Promise<T | undefined> {
    const db = this.openDatabase();
    try {
      const row = db
        .query(
          `SELECT value_json
             FROM project_metadata
            WHERE key = ?1`,
        )
        .get(key) as { value_json: string } | null;
      return row ? (JSON.parse(row.value_json) as T) : undefined;
    } finally {
      db.close();
    }
  }

  private async writeMetadata(key: string, value: unknown): Promise<void> {
    await this.enqueueWrite(async (db) => {
      db.query(
        `INSERT INTO project_metadata(key, value_json)
         VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      ).run(key, JSON.stringify(value));
    });
  }

  private async deleteMetadata(key: string): Promise<void> {
    await this.enqueueWrite(async (db) => {
      db.query(`DELETE FROM project_metadata WHERE key = ?1`).run(key);
    });
  }

  private async enqueueWrite(operation: (db: Database) => void): Promise<void> {
    const previous = WRITE_QUEUES.get(this.databasePath) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(dirname(this.databasePath), { recursive: true });
      const db = this.openDatabase();
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          operation(db);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } finally {
        db.close();
      }
    });

    WRITE_QUEUES.set(
      this.databasePath,
      next.catch(() => {
        // Keep the queue alive for subsequent writes after a failure.
      }),
    );

    await next;
  }

  private openDatabase(): Database {
    const t = performance.now();
    const db = new Database(this.databasePath, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS project_metadata (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chapters (
        chapter_id INTEGER PRIMARY KEY,
        file_path TEXT NOT NULL,
        fragment_count INTEGER NOT NULL DEFAULT 0,
        source_line_count INTEGER NOT NULL DEFAULT 0,
        translated_line_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS fragments (
        chapter_id INTEGER NOT NULL,
        fragment_index INTEGER NOT NULL,
        hash TEXT NOT NULL,
        line_count INTEGER NOT NULL DEFAULT 0,
        aux_data_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (chapter_id, fragment_index),
        FOREIGN KEY (chapter_id) REFERENCES chapters(chapter_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS fragment_lines (
        chapter_id INTEGER NOT NULL,
        fragment_index INTEGER NOT NULL,
        line_index INTEGER NOT NULL,
        source TEXT NOT NULL,
        translation TEXT NOT NULL DEFAULT '',
        metadata_json TEXT,
        target_groups_json TEXT,
        extend TEXT NOT NULL DEFAULT '',
        comment TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (chapter_id, fragment_index, line_index),
        FOREIGN KEY (chapter_id, fragment_index)
          REFERENCES fragments(chapter_id, fragment_index) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS pipeline_step_states (
        chapter_id INTEGER NOT NULL,
        fragment_index INTEGER NOT NULL,
        step_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        PRIMARY KEY (chapter_id, fragment_index, step_id),
        FOREIGN KEY (chapter_id, fragment_index)
          REFERENCES fragments(chapter_id, fragment_index) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_fragments_hash ON fragments(hash);
      CREATE INDEX IF NOT EXISTS idx_pipeline_step_states_step
        ON pipeline_step_states(step_id, chapter_id, fragment_index);
    `);
    const elapsed = performance.now() - t;
    if (elapsed > 5) {
      console.log(`[Perf] openDatabase: ${elapsed.toFixed(0)}ms`);
    }
    return db;
  }

  private replaceChapter(db: Database, chapter: ChapterEntry): void {
    const fragmentCount = chapter.fragments.length;
    const sourceLineCount = chapter.fragments.reduce(
      (sum, f) => sum + f.source.lines.length,
      0,
    );
    const translatedLineCount = chapter.fragments.reduce(
      (sum, f) =>
        sum + f.translation.lines.filter((l) => l.length > 0).length,
      0,
    );

    db.query(
      `INSERT INTO chapters(chapter_id, file_path, fragment_count, source_line_count, translated_line_count)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(chapter_id) DO UPDATE SET
         file_path = excluded.file_path,
         fragment_count = excluded.fragment_count,
         source_line_count = excluded.source_line_count,
         translated_line_count = excluded.translated_line_count`,
    ).run(chapter.id, chapter.filePath, fragmentCount, sourceLineCount, translatedLineCount);

    db.query(`DELETE FROM fragments WHERE chapter_id = ?1`).run(chapter.id);

    for (const [fragmentIndex, fragment] of chapter.fragments.entries()) {
      db.query(
        `INSERT INTO fragments(
            chapter_id,
            fragment_index,
            hash,
            line_count,
            aux_data_json
          )
          VALUES (?1, ?2, ?3, ?4, ?5)`,
      ).run(
        chapter.id,
        fragmentIndex,
        fragment.hash,
        fragment.source.lines.length,
        JSON.stringify(fragment.meta?.auxData ?? {}),
      );

      for (const [lineIndex] of fragment.source.lines.entries()) {
        db.query(
          `INSERT INTO fragment_lines(
              chapter_id,
              fragment_index,
              line_index,
              source,
              translation,
              metadata_json,
              target_groups_json,
              extend,
              comment
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        ).run(
          chapter.id,
          fragmentIndex,
          lineIndex,
          fragment.source.lines[lineIndex] ?? "",
          fragment.translation.lines[lineIndex] ?? "",
          fragment.meta?.metadataList[lineIndex] !== undefined
            ? JSON.stringify(fragment.meta.metadataList[lineIndex])
            : null,
          fragment.meta?.targetGroups?.[lineIndex] !== undefined
            ? JSON.stringify(fragment.meta.targetGroups[lineIndex])
            : null,
          "",
          "",
        );
      }

      for (const [stepId, state] of Object.entries(fragment.pipelineStates)) {
        this.upsertPipelineStepState(db, chapter.id, fragmentIndex, stepId, state);
      }
    }
  }

  private replaceFragmentTranslations(
    db: Database,
    chapterId: number,
    fragmentIndex: number,
    lines: string[],
  ): void {
    const existingRows = db
      .query(
        `SELECT line_index, source, metadata_json, target_groups_json, extend, comment
           FROM fragment_lines
          WHERE chapter_id = ?1
            AND fragment_index = ?2
          ORDER BY line_index`,
      )
      .all(chapterId, fragmentIndex) as Array<{
        line_index: number;
        source: string;
        metadata_json: string | null;
        target_groups_json: string | null;
        extend: string;
        comment: string;
      }>;

    db.query(
      `DELETE FROM fragment_lines
        WHERE chapter_id = ?1
          AND fragment_index = ?2`,
    ).run(chapterId, fragmentIndex);

    for (const [lineIndex, line] of lines.entries()) {
      const existing = existingRows.find((r) => r.line_index === lineIndex);
      db.query(
        `INSERT INTO fragment_lines(
            chapter_id,
            fragment_index,
            line_index,
            source,
            translation,
            metadata_json,
            target_groups_json,
            extend,
            comment
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).run(
        chapterId,
        fragmentIndex,
        lineIndex,
        existing?.source ?? "",
        line,
        existing?.metadata_json ?? null,
        existing?.target_groups_json ?? null,
        existing?.extend ?? "",
        existing?.comment ?? "",
      );
    }
  }

  /**
   * 在事务中用 stepTranslations 中除末位步骤外的所有步骤替换 target_groups_json。
   * stepTranslations 为 string[][]，末位步骤对应当前译文（存于 translation 列），
   * 前面的步骤视为历史版本写入 target_groups_json。
   */
  private replaceFragmentTargetGroups(
    db: Database,
    chapterId: number,
    fragmentIndex: number,
    stepTranslations: string[][],
  ): void {
    const previousSteps = stepTranslations.slice(0, -1);
    if (previousSteps.length === 0) return;

    const lineCount = previousSteps[0]?.length ?? 0;
    if (lineCount === 0) return;

    for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
      const targetGroup = previousSteps.map((step) => step[lineIndex] ?? "");
      db.query(
        `UPDATE fragment_lines
            SET target_groups_json = ?4
          WHERE chapter_id = ?1
            AND fragment_index = ?2
            AND line_index = ?3`,
      ).run(chapterId, fragmentIndex, lineIndex, JSON.stringify(targetGroup));
    }
  }

  /** 直接写入行级 target_groups_json（不包含步骤排除逻辑）。 */
  private applyTargetGroups(
    db: Database,
    chapterId: number,
    fragmentIndex: number,
    targetGroupPerLine: string[][],
  ): void {
    for (let lineIndex = 0; lineIndex < targetGroupPerLine.length; lineIndex++) {
      const targetGroup = targetGroupPerLine[lineIndex];
      if (!targetGroup) continue;
      db.query(
        `UPDATE fragment_lines
            SET target_groups_json = ?4
          WHERE chapter_id = ?1
            AND fragment_index = ?2
            AND line_index = ?3`,
      ).run(chapterId, fragmentIndex, lineIndex, JSON.stringify(targetGroup));
    }
  }

  private recalculateChapterTranslatedLineCount(db: Database, chapterId: number): void {
    const row = db
      .query(
        `SELECT COUNT(*) AS count
           FROM fragment_lines
          WHERE chapter_id = ?1
            AND translation IS NOT NULL
            AND translation != ''`,
      )
      .get(chapterId) as { count: number };

    db.query(
      `UPDATE chapters
          SET translated_line_count = ?2
        WHERE chapter_id = ?1`,
    ).run(chapterId, row.count);
  }

  private upsertPipelineStepState(
    db: Database,
    chapterId: number,
    fragmentIndex: number,
    stepId: string,
    state: FragmentPipelineStepState,
  ): void {
    db.query(
      `INSERT INTO pipeline_step_states(chapter_id, fragment_index, step_id, state_json)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(chapter_id, fragment_index, step_id)
       DO UPDATE SET state_json = excluded.state_json`,
    ).run(chapterId, fragmentIndex, stepId, JSON.stringify(state));
  }
}

function hydrateChapter(
  chapterRow: ChapterRow,
  fragmentRows: FragmentRow[],
  lineRows: FragmentLineRow[],
  pipelineRows: PipelineStepStateRow[],
): ChapterEntry {
  const linesByFragment = new Map<number, FragmentLineRow[]>();
  for (const row of lineRows) {
    const lines = linesByFragment.get(row.fragment_index) ?? [];
    lines[row.line_index] = row;
    linesByFragment.set(row.fragment_index, lines);
  }

  const pipelineByFragment = new Map<number, Record<string, FragmentPipelineStepState>>();
  for (const row of pipelineRows) {
    const states = pipelineByFragment.get(row.fragment_index) ?? {};
    states[row.step_id] = JSON.parse(row.state_json) as FragmentPipelineStepState;
    pipelineByFragment.set(row.fragment_index, states);
  }

  return {
    id: chapterRow.chapter_id,
    filePath: chapterRow.file_path,
    fragments: fragmentRows.map((row) => hydrateFragment(row, linesByFragment, pipelineByFragment)),
  };
}

function hydrateFragment(
  row: FragmentRow,
  linesByFragment: Map<number, FragmentLineRow[]>,
  pipelineByFragment: Map<number, Record<string, FragmentPipelineStepState>>,
): FragmentEntry {
  const lineRows = linesByFragment.get(row.fragment_index) ?? [];
  const sourceLines = lineRows.map((lr) => lr.source);
  const translationLines = lineRows.map((lr) => lr.translation);
  const metadataList = lineRows.map<TranslationUnitMetadata>((lr) =>
    lr.metadata_json !== null ? (JSON.parse(lr.metadata_json) as TranslationUnitMetadata) : null,
  );
  const targetGroups: string[][] = lineRows.map((lr) =>
    lr.target_groups_json !== null ? (JSON.parse(lr.target_groups_json) as string[]) : [],
  );
  const auxData = JSON.parse(row.aux_data_json ?? "{}") as FragmentAuxData;

  return {
    source: { lines: sourceLines },
    translation: { lines: translationLines },
    pipelineStates: pipelineByFragment.get(row.fragment_index) ?? {},
    meta: {
      metadataList,
      targetGroups,
      auxData: Object.keys(auxData).length > 0 ? auxData : undefined,
    },
    hash: row.hash,
  };
}
