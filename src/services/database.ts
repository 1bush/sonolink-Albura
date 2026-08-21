/**
 * database.ts
 *
 * Local on-device database, schema deliberately mirrors the original
 * USAlbum app's own us_album.db (confirmed by inspecting the uploaded file):
 *
 *   studyinfo(ID TEXT PK, DateTime TEXT, Dept TEXT, Num INTEGER)
 *   sopinfo(Name TEXT PK, Dir TEXT, Size TEXT, Status TEXT, Idx INTEGER)
 *
 * We keep the same shape (plus a FK-ish StudyID column on sopinfo, which the
 * original schema didn't need because it only ever held one study at a time)
 * so that data imported from an old USAlbum export, or exported from this
 * app, stays structurally compatible.
 */
import * as SQLite from 'expo-sqlite';

export interface StudyRow {
  ID: string; // e.g. "20240110_163854_6835451"
  DateTime: string;
  Dept: string; // e.g. "GYN", "OB", "ABD"
  Num: number; // file count
}

export interface SopRow {
  Name: string; // filename, e.g. "IMG_0001.jpg"
  Dir: string; // local dir under app storage
  Size: string;
  Status: string; // 'pending' | 'received' | 'failed'
  Idx: number;
  StudyID: string;
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync('us_album.db');
  }
  return dbPromise;
}

export async function initDatabase(): Promise<void> {
  const db = await getDb();
  await db.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS android_metadata (
      locale TEXT
    );
    INSERT INTO android_metadata (locale)
      SELECT 'sq_AL' WHERE NOT EXISTS (SELECT 1 FROM android_metadata);

    CREATE TABLE IF NOT EXISTS studyinfo (
      ID CHAR(32) PRIMARY KEY,
      DateTime CHAR(32),
      Dept CHAR(16),
      Num INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sopinfo (
      Name CHAR(64),
      Dir CHAR(64),
      Size CHAR(16),
      Status CHAR(16),
      Idx INTEGER,
      StudyID CHAR(32),
      PRIMARY KEY (Name, StudyID)
    );

    CREATE INDEX IF NOT EXISTS idx_sopinfo_study ON sopinfo (StudyID);
  `);
}

export async function upsertStudy(row: StudyRow): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO studyinfo (ID, DateTime, Dept, Num) VALUES (?, ?, ?, ?)
     ON CONFLICT(ID) DO UPDATE SET DateTime = excluded.DateTime, Dept = excluded.Dept, Num = excluded.Num`,
    [row.ID, row.DateTime, row.Dept, row.Num]
  );
}

export async function incrementStudyFileCount(studyId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE studyinfo SET Num = Num + 1 WHERE ID = ?`, [studyId]);
}

export async function insertSop(row: SopRow): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO sopinfo (Name, Dir, Size, Status, Idx, StudyID) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(Name, StudyID) DO UPDATE SET Dir = excluded.Dir, Size = excluded.Size, Status = excluded.Status, Idx = excluded.Idx`,
    [row.Name, row.Dir, row.Size, row.Status, row.Idx, row.StudyID]
  );
}

export async function updateSopStatus(name: string, studyId: string, status: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE sopinfo SET Status = ? WHERE Name = ? AND StudyID = ?`, [status, name, studyId]);
}

export async function listStudies(): Promise<StudyRow[]> {
  const db = await getDb();
  return db.getAllAsync<StudyRow>(`SELECT * FROM studyinfo ORDER BY DateTime DESC`);
}

export async function listSopsForStudy(studyId: string): Promise<SopRow[]> {
  const db = await getDb();
  return db.getAllAsync<SopRow>(`SELECT * FROM sopinfo WHERE StudyID = ? ORDER BY Idx ASC`, [studyId]);
}

export async function deleteStudy(studyId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`DELETE FROM sopinfo WHERE StudyID = ?`, [studyId]);
  await db.runAsync(`DELETE FROM studyinfo WHERE ID = ?`, [studyId]);
}

export async function studyStats(): Promise<{ studies: number; files: number }> {
  const db = await getDb();
  const s = await db.getFirstAsync<{ c: number }>(`SELECT COUNT(*) as c FROM studyinfo`);
  const f = await db.getFirstAsync<{ c: number }>(`SELECT COUNT(*) as c FROM sopinfo WHERE Status = 'received'`);
  return { studies: s?.c ?? 0, files: f?.c ?? 0 };
}
