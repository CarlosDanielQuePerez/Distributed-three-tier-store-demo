import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Lista los archivos NNN_nombre.sql en orden. */
export const listMigrations = async (directory) =>
  (await readdir(directory))
    .filter((file) => /^\d{3,}_[\w-]+\.sql$/.test(file))
    .sort()
    .map((file) => ({ version: file.split("_")[0], file, path: join(directory, file) }));

/**
 * Migraciones mínimas al estilo Flyway: cada archivo se aplica una sola vez y queda
 * registrado con su checksum en schema_migrations. Un archivo ya aplicado que cambie
 * detiene el proceso (las migraciones son inmutables: se agrega una nueva).
 */
export const migrate = async (connection, directory, logger = console) => {
  await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(16) NOT NULL PRIMARY KEY,
    file VARCHAR(255) NOT NULL,
    checksum CHAR(64) NOT NULL,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const [rows] = await connection.query("SELECT version, checksum FROM schema_migrations");
  const applied = new Map(rows.map((row) => [row.version, row.checksum]));
  const results = [];
  for (const migration of await listMigrations(directory)) {
    const sql = await readFile(migration.path, "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    if (applied.has(migration.version)) {
      if (applied.get(migration.version) !== checksum) {
        throw new Error(`Migration ${migration.file} changed after being applied`);
      }
      results.push({ ...migration, status: "skipped" });
      continue;
    }
    await connection.query(sql);
    await connection.query("INSERT INTO schema_migrations (version, file, checksum) VALUES (?, ?, ?)", [
      migration.version,
      migration.file,
      checksum,
    ]);
    logger.log(`Applied migration ${migration.file}`);
    results.push({ ...migration, status: "applied" });
  }
  return results;
};
