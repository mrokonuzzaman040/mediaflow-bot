// Minimal in-memory D1 implementation on top of sql.js (SQLite compiled to wasm),
// with the real migrations applied. Supports prepare/bind/run/first/all and batch.
import initSqlJs from "sql.js";
import { readFileSync, readdirSync } from "node:fs";

const SQL = await initSqlJs();

export function createD1() {
  const db = new SQL.Database();
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(f, dir), "utf8"));
  }
  const exec = (sql, params) => {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params.map((v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v)));
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return { results: rows, success: true, meta: { changes: db.getRowsModified() } };
    } finally { stmt.free(); }
  };
  const d1 = {
    calls: 0,
    failing: false,
    raw: db,
    prepare(sql) {
      const st = {
        params: [],
        bind(...p) { const n = Object.create(st); n.params = p; return n; },
        async run() { d1.check(); return exec(sql, this.params); },
        async all() { d1.check(); return exec(sql, this.params); },
        async first(col) { d1.check(); const r = exec(sql, this.params).results[0] ?? null; return r && col ? r[col] : r; },
        _exec() { return exec(sql, this.params); },
      };
      return st;
    },
    async batch(stmts) {
      d1.check();
      db.exec("BEGIN");
      try { const out = stmts.map((s) => s._exec()); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    check() { d1.calls++; if (d1.failing) throw new Error("D1 is down"); },
    rows(sql, ...p) { return exec(sql, p).results; },
  };
  return d1;
}
