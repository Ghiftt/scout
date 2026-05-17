import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, "../../scout.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS task_metadata (
    task_id TEXT PRIMARY KEY,
    question TEXT,
    instructions TEXT,
    success_criteria TEXT,
    location_lat REAL,
    location_lng REAL,
    location_address TEXT,
    location_radius INTEGER,
    ipfs_hash TEXT,
    spec_hash TEXT,
    erc3009_v INTEGER,
    erc3009_r TEXT,
    erc3009_s TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  )
`);

export function saveTaskMetadata(taskId: string, data: {
  question: string;
  instructions?: string;
  successCriteria: string;
  location: { lat: number; lng: number; address: string; radiusMeters: number };
  ipfsHash: string;
  specHash: string;
  erc3009?: { v: number; r: string; s: string };
}) {
  db.prepare(`
    INSERT OR REPLACE INTO task_metadata 
    (task_id, question, instructions, success_criteria, location_lat, location_lng, location_address, location_radius, ipfs_hash, spec_hash, erc3009_v, erc3009_r, erc3009_s)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    data.question,
    data.instructions ?? null,
    data.successCriteria,
    data.location.lat,
    data.location.lng,
    data.location.address,
    data.location.radiusMeters,
    data.ipfsHash,
    data.specHash,
    data.erc3009?.v ?? null,
    data.erc3009?.r ?? null,
    data.erc3009?.s ?? null,
  );
}

export function getTaskMetadata(taskId: string): {
  question: string;
  instructions?: string;
  successCriteria: string;
  location: { lat: number; lng: number; address: string; radiusMeters: number };
  ipfsHash: string;
  specHash: string;
  erc3009?: { v: number; r: string; s: string } | null;
} | null {
  const row = db.prepare(`SELECT * FROM task_metadata WHERE task_id = ?`).get(taskId) as any;
  if (!row) return null;
  return {
    question: row.question,
    instructions: row.instructions,
    successCriteria: row.success_criteria,
    location: {
      lat: row.location_lat,
      lng: row.location_lng,
      address: row.location_address,
      radiusMeters: row.location_radius
    },
    ipfsHash: row.ipfs_hash,
    specHash: row.spec_hash,
    erc3009: row.erc3009_v ? {
      v: row.erc3009_v,
      r: row.erc3009_r,
      s: row.erc3009_s,
    } : null,
  };
}
export function getAllTaskMetadata(): Array<{ taskId: string; ipfsHash: string }> {
  const rows = db.prepare(`SELECT task_id, ipfs_hash FROM task_metadata`).all() as any[];
  return rows.map(r => ({ taskId: r.task_id, ipfsHash: r.ipfs_hash }));
}