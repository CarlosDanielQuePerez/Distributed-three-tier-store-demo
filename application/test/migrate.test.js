import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listMigrations, migrate } from "../migrate.js";

const fakeConnection = (applied = []) => {
  const executed = [];
  return {
    executed,
    async query(sql, params) {
      if (sql.startsWith("SELECT version")) return [applied];
      if (sql.startsWith("INSERT INTO schema_migrations")) applied.push({ version: params[0], checksum: params[2] });
      executed.push(sql);
      return [[]];
    },
  };
};

test("las migraciones del repo están numeradas y ordenadas", async () => {
  const migrations = await listMigrations(new URL("../../database/migrations", import.meta.url).pathname);
  assert.deepEqual(migrations.map((m) => m.version), ["001", "002", "003"]);
});

test("aplica una vez y detecta archivos modificados", async () => {
  const dir = await mkdtemp(join(tmpdir(), "migrations-"));
  await writeFile(join(dir, "001_a.sql"), "SELECT 1;");
  await writeFile(join(dir, "002_b.sql"), "SELECT 2;");
  await writeFile(join(dir, "notes.txt"), "ignored");
  const applied = [];
  const first = await migrate(fakeConnection(applied), dir, { log() {} });
  assert.deepEqual(first.map((m) => m.status), ["applied", "applied"]);
  const second = await migrate(fakeConnection(applied), dir, { log() {} });
  assert.deepEqual(second.map((m) => m.status), ["skipped", "skipped"]);
  await writeFile(join(dir, "001_a.sql"), "SELECT 'changed';");
  await assert.rejects(() => migrate(fakeConnection(applied), dir, { log() {} }), /changed after being applied/);
});
