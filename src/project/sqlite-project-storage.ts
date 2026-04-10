import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ChapterEntry,
  FragmentEntry,
  FragmentPipelineStepState,
  TextFragment,
  TranslationProjectState,
  TranslationUnitMetadata,
  WorkspaceConfig,
} from "./types.ts";

const WRITE_QUEUES = new Map<string, Promise<void>>();

type FragmentRow = {
  chapter_id: number;
  fragment_index: number;
  hash: string;
  source_json: string;
  metadata_json: string;
  target_groups_json: string;
};

type FragmentLineRow = {
  chapter_id: number;
  fragment_index: number;
  line_index: number;
  translation: string;
};

type PipelineStepStateRow = {
  chapter_id: number;
  fragment_index: number;
  step_id: string;
  state_json: string;
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

  async loadChapter(chapterId: number): Promise<ChapterEntry | undefined> {
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
          `SELECT chapter_id, fragment_index, hash, source_json, metadata_json, target_groups_json
             FROM fragments
            WHERE chapter_id = ?1
            ORDER BY fragment_index`,
        )
        .all(chapterId) as FragmentRow[];

      const lineRows = db
        .query(
          `SELECT chapter_id, fragment_index, line_index, translation
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
  ): Promise<void> {
    await this.enqueueWrite(async (db) => {
      this.replaceFragmentTranslations(db, chapterId, fragmentIndex, translation.lines);
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
  ): Promise<void> {
    await this.enqueueWrite(async (db) => {
      this.upsertPipelineStepState(db, chapterId, fragmentIndex, stepId, state);
      this.replaceFragmentTranslations(db, chapterId, fragmentIndex, translation.lines);
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
        file_path TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fragments (
        chapter_id INTEGER NOT NULL,
        fragment_index INTEGER NOT NULL,
        hash TEXT NOT NULL,
        source_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        target_groups_json TEXT NOT NULL,
        PRIMARY KEY (chapter_id, fragment_index),
        FOREIGN KEY (chapter_id) REFERENCES chapters(chapter_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS fragment_lines (
        chapter_id INTEGER NOT NULL,
        fragment_index INTEGER NOT NULL,
        line_index INTEGER NOT NULL,
        translation TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS idx_fragment_lines_lookup
        ON fragment_lines(chapter_id, fragment_index, line_index);
      CREATE INDEX IF NOT EXISTS idx_pipeline_step_states_step
        ON pipeline_step_states(step_id, chapter_id, fragment_index);
    `);
    return db;
  }

  private replaceChapter(db: Database, chapter: ChapterEntry): void {
    db.query(
      `INSERT INTO chapters(chapter_id, file_path)
       VALUES (?1, ?2)
       ON CONFLICT(chapter_id) DO UPDATE SET file_path = excluded.file_path`,
    ).run(chapter.id, chapter.filePath);

    db.query(`DELETE FROM fragments WHERE chapter_id = ?1`).run(chapter.id);

    for (const [fragmentIndex, fragment] of chapter.fragments.entries()) {
      db.query(
        `INSERT INTO fragments(
            chapter_id,
            fragment_index,
            hash,
            source_json,
            metadata_json,
            target_groups_json
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).run(
        chapter.id,
        fragmentIndex,
        fragment.hash,
        JSON.stringify(fragment.source.lines),
        JSON.stringify(fragment.meta?.metadataList ?? []),
        JSON.stringify(fragment.meta?.targetGroups ?? []),
      );

      for (const [lineIndex, line] of fragment.translation.lines.entries()) {
        db.query(
          `INSERT INTO fragment_lines(chapter_id, fragment_index, line_index, translation)
           VALUES (?1, ?2, ?3, ?4)`,
        ).run(chapter.id, fragmentIndex, lineIndex, line);
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
    db.query(
      `DELETE FROM fragment_lines
        WHERE chapter_id = ?1
          AND fragment_index = ?2`,
    ).run(chapterId, fragmentIndex);

    for (const [lineIndex, line] of lines.entries()) {
      db.query(
        `INSERT INTO fragment_lines(chapter_id, fragment_index, line_index, translation)
         VALUES (?1, ?2, ?3, ?4)`,
      ).run(chapterId, fragmentIndex, lineIndex, line);
    }
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
  chapterRow: { chapter_id: number; file_path: string },
  fragmentRows: FragmentRow[],
  lineRows: FragmentLineRow[],
  pipelineRows: PipelineStepStateRow[],
): ChapterEntry {
  const linesByFragment = new Map<number, string[]>();
  for (const row of lineRows) {
    const lines = linesByFragment.get(row.fragment_index) ?? [];
    lines[row.line_index] = row.translation;
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
  linesByFragment: Map<number, string[]>,
  pipelineByFragment: Map<number, Record<string, FragmentPipelineStepState>>,
): FragmentEntry {
  const sourceLines = JSON.parse(row.source_json) as string[];
  const metadataList = JSON.parse(row.metadata_json) as TranslationUnitMetadata[];
  const targetGroups = JSON.parse(row.target_groups_json) as string[][];
  const translationLines = linesByFragment.get(row.fragment_index) ?? sourceLines.map(() => "");

  return {
    source: { lines: sourceLines },
    translation: { lines: sourceLines.map((_line, index) => translationLines[index] ?? "") },
    pipelineStates: pipelineByFragment.get(row.fragment_index) ?? {},
    meta: {
      metadataList,
      targetGroups,
    },
    hash: row.hash,
  };
}
