/**
 * D1 usage database helpers: users, jobs, events, admin reports.
 * Every function is defensive: callers wrap writes in ctx.waitUntil and a
 * database failure must never break the bot.
 */

export interface TgProfile {
  id: number; username?: string; first_name?: string; last_name?: string;
  language_code?: string; is_premium?: boolean;
}

export const nowSec = () => Math.floor(Date.now() / 1000);
const clip = (v: unknown, n: number): string | null =>
  v === undefined || v === null || v === "" ? null : String(v).slice(0, n);
const num = (v: unknown): number | null => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? null : n;
};

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function upsertUser(db: D1Database, u: TgProfile): Promise<unknown> {
  const t = nowSec();
  return db.prepare(
    `INSERT INTO users (user_id, username, first_name, last_name, language_code, is_premium, first_seen, last_seen)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
     ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name,
       last_name = excluded.last_name, language_code = excluded.language_code,
       is_premium = excluded.is_premium, last_seen = excluded.last_seen`,
  ).bind(u.id, clip(u.username, 64), clip(u.first_name, 128), clip(u.last_name, 128),
    clip(u.language_code, 16), u.is_premium ? 1 : 0, t).run();
}

export function logEvent(db: D1Database, userId: number | undefined, chatId: number | undefined,
                         type: string, detail: string): Promise<unknown> {
  return db.prepare("INSERT INTO events (user_id, chat_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(userId ?? null, chatId ?? null, type, clip(detail, 500), nowSec()).run();
}

export interface NewJob {
  id: string; menuId: string; userId: number; chatId: number; url: string; platform: string;
  action: string; options: Record<string, unknown>; tokenHash: string;
}

export function insertJob(db: D1Database, j: NewJob): Promise<unknown> {
  return db.batch([
    db.prepare(`INSERT INTO jobs (id, menu_id, user_id, chat_id, url, platform, action, options, status, created_at, token_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`)
      .bind(j.id, j.menuId, j.userId, j.chatId, clip(j.url, 2000), j.platform, j.action,
        JSON.stringify(j.options).slice(0, 1000), nowSec(), j.tokenHash),
    db.prepare("UPDATE users SET total_requests = total_requests + 1 WHERE user_id = ?").bind(j.userId),
  ]);
}

export function failJob(db: D1Database, id: string, code: string, message: string): Promise<unknown> {
  return db.prepare("UPDATE jobs SET status = 'failed', error_code = ?, error_message = ?, finished_at = ? WHERE id = ?")
    .bind(code, clip(message, 500), nowSec(), id).run();
}

export async function isBlocked(db: D1Database, userId: number): Promise<boolean> {
  const row = await db.prepare("SELECT is_blocked FROM users WHERE user_id = ?").bind(userId)
    .first<{ is_blocked: number }>();
  return !!row?.is_blocked;
}

/**
 * Apply a status report from the GitHub runner. The runner proves it owns the
 * job with the one-time token; only its SHA-256 is stored. Returns true if a row matched.
 */
export async function applyRunnerReport(db: D1Database, body: Record<string, unknown>): Promise<boolean> {
  const id = String(body.run_id ?? "");
  const status = String(body.status ?? "");
  if (!/^[a-z0-9]{6,32}$/.test(id) || !["running", "done", "failed"].includes(status)) return false;
  const hash = await sha256Hex(String(body.token ?? ""));
  const t = nowSec();
  const res = status === "running"
    ? await db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND token_hash = ? AND status = 'queued'")
        .bind(t, id, hash).run()
    : await db.prepare(
        `UPDATE jobs SET status = ?, error_code = ?, error_message = ?, title = ?, file_size = ?, duration_sec = ?,
           processing_ms = ?, finished_at = ?, started_at = COALESCE(started_at, ?)
         WHERE id = ? AND token_hash = ? AND status IN ('queued', 'running')`)
        .bind(status, clip(body.error_code, 40), clip(body.error_message, 500), clip(body.title, 300),
          num(body.file_size), num(body.duration_sec), num(body.processing_ms), t, t, id, hash).run();
  return (res.meta?.changes ?? 0) > 0;
}

// ---- admin reports ------------------------------------------------------------
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function tzLabel(offsetMin: number): string {
  const sign = offsetMin >= 0 ? "+" : "-";
  const a = Math.abs(offsetMin);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, "0")}` : ""}`;
}

export function fmtTime(sec: number, offsetMin: number): string {
  const d = new Date((sec + offsetMin * 60) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** Start of "today" (local midnight for the given offset) in unix seconds. */
export function startOfToday(offsetMin: number, now = nowSec()): number {
  const local = now + offsetMin * 60;
  return local - (local % 86400) - offsetMin * 60;
}

function fmtMs(ms: number | null | undefined): string {
  if (!ms) return "–";
  return ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`;
}

function fmtSize(b: number | null | undefined): string {
  return b ? `${(b / 1048576).toFixed(1)} MB` : "";
}

function who(u: { username?: string | null; first_name?: string | null; user_id?: number }): string {
  if (u.username) return `@${esc(u.username)}`;
  return esc(u.first_name || String(u.user_id ?? "?"));
}

export async function statsText(db: D1Database, offsetMin: number): Promise<string> {
  const today = startOfToday(offsetMin);
  const week = nowSec() - 7 * 86400;
  const [users, jobs, platforms, actions] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS total,
                  SUM(first_seen >= ?1) AS new_today, SUM(first_seen >= ?2) AS new_7d,
                  SUM(last_seen >= ?1) AS active_today FROM users`).bind(today, week),
    db.prepare(`SELECT COUNT(*) AS total, SUM(created_at >= ?1) AS today, SUM(created_at >= ?2) AS d7,
                  SUM(status = 'done') AS done, SUM(status = 'failed') AS failed,
                  SUM(status IN ('queued','running')) AS pending,
                  AVG(CASE WHEN status = 'done' THEN processing_ms END) AS avg_ms FROM jobs`).bind(today, week),
    db.prepare("SELECT platform AS k, COUNT(*) AS n FROM jobs GROUP BY platform ORDER BY n DESC LIMIT 5"),
    db.prepare("SELECT action AS k, COUNT(*) AS n FROM jobs GROUP BY action ORDER BY n DESC LIMIT 5"),
  ]);
  const u: any = users.results[0] ?? {};
  const j: any = jobs.results[0] ?? {};
  const finished = (j.done ?? 0) + (j.failed ?? 0);
  const rate = finished ? `${Math.round(((j.done ?? 0) / finished) * 100)}%` : "–";
  const top = (rows: any[]) => rows.length
    ? rows.map((r) => `  • ${esc(String(r.k ?? "unknown"))}: <b>${r.n}</b>`).join("\n") : "  • –";
  return [
    "📊 <b>MediaFlow stats</b>",
    `<i>Today = since midnight ${tzLabel(offsetMin)}</i>`,
    "",
    "👥 <b>Users</b>",
    `  Total: <b>${u.total ?? 0}</b> · Active today: <b>${u.active_today ?? 0}</b>`,
    `  New today: <b>${u.new_today ?? 0}</b> · New 7d: <b>${u.new_7d ?? 0}</b>`,
    "",
    "🎬 <b>Jobs</b>",
    `  Today: <b>${j.today ?? 0}</b> · 7d: <b>${j.d7 ?? 0}</b> · All: <b>${j.total ?? 0}</b>`,
    `  ✅ ${j.done ?? 0} · ❌ ${j.failed ?? 0} · ⏳ ${j.pending ?? 0} · Success rate: <b>${rate}</b>`,
    `  Avg processing: <b>${fmtMs(j.avg_ms)}</b>`,
    "",
    "🌐 <b>Top platforms</b>", top(platforms.results),
    "",
    "⚙️ <b>Top actions</b>", top(actions.results),
  ].join("\n");
}

export async function usersText(db: D1Database, offsetMin: number): Promise<string> {
  const { results } = await db.prepare(
    `SELECT user_id, username, first_name, last_name, total_requests, last_seen, is_blocked
     FROM users ORDER BY last_seen DESC LIMIT 10`).all<any>();
  if (!results.length) return "👥 <b>Recent users</b>\n\nNo users yet.";
  return ["👥 <b>Last 10 active users</b>", `<i>Times in ${tzLabel(offsetMin)}</i>`, "",
    ...results.map((u, i) => {
      const name = esc([u.first_name, u.last_name].filter(Boolean).join(" ") || "–");
      return `${i + 1}. <b>${name}</b> ${u.username ? `@${esc(u.username)} ` : ""}<code>${u.user_id}</code>` +
        `\n    🎬 ${u.total_requests} job${u.total_requests === 1 ? "" : "s"} · 🕒 ${fmtTime(u.last_seen, offsetMin)}${u.is_blocked ? " · ⛔ blocked" : ""}`;
    })].join("\n");
}

const STATUS_EMOJI: Record<string, string> = { done: "✅", failed: "❌", running: "⚙️", queued: "⏳" };

export async function recentText(db: D1Database, offsetMin: number): Promise<string> {
  const { results } = await db.prepare(
    `SELECT j.platform, j.action, j.status, j.error_code, j.title, j.file_size, j.processing_ms, j.created_at,
            u.username, u.first_name, j.user_id
     FROM jobs j LEFT JOIN users u ON u.user_id = j.user_id ORDER BY j.created_at DESC LIMIT 10`).all<any>();
  if (!results.length) return "🧾 <b>Recent jobs</b>\n\nNo jobs yet.";
  return ["🧾 <b>Last 10 jobs</b>", `<i>Times in ${tzLabel(offsetMin)}</i>`, "",
    ...results.map((r) => {
      const detail = r.status === "failed" ? esc(r.error_code ?? "error")
        : [r.title ? esc(String(r.title).slice(0, 40)) : "", fmtSize(r.file_size),
           r.processing_ms ? fmtMs(r.processing_ms) : ""].filter(Boolean).join(" · ");
      return `${STATUS_EMOJI[r.status] ?? "•"} ${fmtTime(r.created_at, offsetMin)} · ${who(r)} · ` +
        `${esc(r.platform ?? "?")} · ${esc(r.action)}${detail ? `\n    ${detail}` : ""}`;
    })].join("\n");
}
