// Behavioural tests for the Worker using the wrangler-bundled output (dist/index.js),
// a mocked fetch (Telegram + GitHub) and an in-memory KV. Run: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { progressBar } from "../dist/index.js";
import { createD1 } from "./fake-d1.mjs";

function makeEnv(extra = {}) {
  const store = new Map();
  const STATE = {
    async get(k, type) { const v = store.get(k); return v === undefined ? null : type === "json" ? JSON.parse(v) : v; },
    async put(k, v, opts) { assert.ok(opts?.expirationTtl >= 60, `KV write ${k} must have a TTL >= 60`); store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
  const DB = createD1();
  return { store, DB, env: { STATE, DB, ADMIN_USER_IDS: "1000", TZ_OFFSET_MINUTES: "360", TELEGRAM_BOT_TOKEN: "123:ABC", WEBHOOK_SECRET: "s3cret",
    GITHUB_TOKEN: "ghp_x", GITHUB_REPO: "me/repo", ALLOWED_USER_IDS: "", DEFAULT_WATERMARK: "",
    FRAMES_MAX_SECONDS: "60", ...extra } };
}

const calls = [];
let githubStatus = 204;
globalThis.fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : {};
  calls.push({ url: String(url), body, headers: init?.headers });
  if (String(url).includes("api.github.com")) return new Response(githubStatus === 204 ? null : "err", { status: githubStatus });
  if (String(url).endsWith("/getMe")) return Response.json({ ok: true, result: { username: "mediaflobot" } });
  return Response.json({ ok: true, result: { message_id: 1 } });
};
beforeEach(() => { calls.length = 0; githubStatus = 204; });

// Fake ExecutionContext: background (waitUntil) work is awaited before the test continues.
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
const settle = async () => { while (pending.length) await pending.shift(); };
const call = async (req, env) => { const r = await worker.fetch(req, env, ctx); await settle(); return r; };
const post = (env, update, secret = "s3cret") => call(new Request("https://w.dev/webhook", {
  method: "POST", headers: { "x-telegram-bot-api-secret-token": secret, "content-type": "application/json" },
  body: JSON.stringify(update) }), env);
const release = (env, body) => call(new Request("https://w.dev/release", { method: "POST", body: JSON.stringify(body) }), env);
const msg = (text, uid = 42) => ({ update_id: 1, message: { message_id: 7, from: { id: uid, first_name: "Rokon" }, chat: { id: 99, type: "private" }, text } });
const cb = (data, uid = 42, from = { id: uid, first_name: "Rokon" }) => ({ update_id: 2, callback_query: { id: "q", from, data, message: { message_id: 8, chat: { id: 99, type: "private" } } } });
const tgCalls = (m) => calls.filter((c) => c.url.endsWith("/" + m));
const ghCalls = () => calls.filter((c) => c.url.includes("api.github.com"));
const lastSend = () => tgCalls("sendMessage").at(-1).body;
const lastEdit = () => tgCalls("editMessageText").at(-1).body;
const lastAnswer = () => tgCalls("answerCallbackQuery").at(-1).body;
const buttons = (body) => body.reply_markup.inline_keyboard.flat();
const lastMenuJobId = () => buttons(lastSend())[0].callback_data.split(":").at(-1);

test("rejects missing/wrong secret token; health check ok", async () => {
  const { env } = makeEnv();
  assert.equal((await post(env, msg("/start"), "nope")).status, 401);
  assert.equal((await call(new Request("https://w.dev/webhook", { method: "POST", body: "{}" }), env)).status, 401);
  assert.equal((await call(new Request("https://w.dev/"), env)).status, 200);
  assert.equal(calls.length, 0);
});

test("/start shows branded HTML welcome with Help/Features/About buttons", async () => {
  const { env } = makeEnv();
  assert.equal((await post(env, msg("/start"))).status, 200);
  const b = lastSend();
  assert.equal(b.parse_mode, "HTML");
  assert.match(b.text, /<b>MediaFlow<\/b>/);
  assert.match(b.text, /YouTube.*TikTok.*Instagram/s);
  assert.match(b.text, /Hi <b>Rokon<\/b>/);
  assert.deepEqual(buttons(b).map((x) => x.callback_data), ["m:help", "m:features", "m:about"]);
});

test("help/features/about pages edit in place and go back home", async () => {
  const { env } = makeEnv();
  await post(env, cb("m:features"));
  assert.match(lastEdit().text, /Features/);
  assert.equal(lastEdit().message_id, 8);
  await post(env, cb("m:about"));
  assert.match(lastEdit().text, /Privacy/);
  await post(env, cb("m:home"));
  assert.match(lastEdit().text, /MediaFlow/);
  await post(env, msg("/help@mediaflobot"));
  assert.match(lastSend().text, /How to use/);
  assert.equal(tgCalls("answerCallbackQuery").length, 3);
});

test("link -> platform card -> mp3 dispatches to GitHub with status message context", async () => {
  const { env, store } = makeEnv();
  await post(env, msg("check https://youtu.be/dQw4w9WgXcQ please"));
  assert.equal(tgCalls("sendChatAction")[0].body.action, "typing");
  const card = lastSend();
  assert.match(card.text, /YouTube link detected/);
  const kb = card.reply_markup.inline_keyboard;
  assert.ok(kb.every((row) => row.length === 2), "2-column keyboard");
  assert.deepEqual(kb.flat().map((x) => x.text),
    ["📥 Download Video", "🎵 MP3 Audio", "💧 Watermark", "✂️ Crop", "🖼 Frames (1/sec)", "❌ Cancel"]);
  const id = lastMenuJobId();
  await post(env, cb(`a:mp3:${id}`));
  const gh = ghCalls();
  assert.equal(gh.length, 1);
  assert.equal(gh[0].url, "https://api.github.com/repos/me/repo/dispatches");
  assert.equal(gh[0].headers.authorization, "Bearer ghp_x");
  const p = gh[0].body.client_payload;
  assert.equal(gh[0].body.event_type, "process-media");
  assert.deepEqual({ chat_id: p.chat_id, url: p.url, action: p.action, options: p.options },
    { chat_id: 99, url: "https://youtu.be/dQw4w9WgXcQ", action: "mp3", options: {} });
  assert.ok(Object.keys(p).length <= 10, "GitHub allows max 10 top-level client_payload keys");
  assert.equal(p.ctx.status_message_id, 8);
  assert.equal(p.ctx.platform, "YouTube");
  assert.equal(p.ctx.label, "🎵 MP3 Audio");
  assert.equal(p.ctx.bot_username, "mediaflobot");
  assert.equal(p.ctx.release_url, "https://w.dev/release");
  assert.match(lastEdit().text, /Queued/);
  assert.match(lastEdit().text, /▱▱▱/);
  assert.ok(store.has(`job:${id}`), "job state kept (TTL) so Try again works");
  assert.ok(store.has("active:42"));
});

test("download quality submenu with back button", async () => {
  const { env } = makeEnv();
  await post(env, msg("https://www.youtube.com/watch?v=x"));
  const id = lastMenuJobId();
  await post(env, cb(`a:video:${id}`));
  assert.deepEqual(buttons(lastEdit()).map((x) => x.text), ["🌟 Best", "📺 720p", "📱 480p", "⬅️ Back"]);
  await post(env, cb(`b:${id}`));
  assert.match(lastEdit().text, /link detected/);
  await post(env, cb(`q:480:${id}`));
  assert.deepEqual(ghCalls()[0].body.client_payload.options, { quality: "480" });
  assert.equal(ghCalls()[0].body.client_payload.ctx.label, "📥 Video · 480p");
});

test("crop submenu -> 9:16", async () => {
  const { env } = makeEnv();
  await post(env, msg("https://www.tiktok.com/@a/video/1"));
  assert.match(lastSend().text, /TikTok link detected/);
  const id = lastMenuJobId();
  await post(env, cb(`a:crop:${id}`));
  assert.deepEqual(buttons(lastEdit()).map((x) => x.text), ["📱 9:16 Vertical", "⬛ 1:1 Square", "🖥 16:9 Wide", "⬅️ Back"]);
  assert.equal(ghCalls().length, 0);
  await post(env, cb(`c:9x16:${id}`));
  assert.deepEqual(ghCalls()[0].body.client_payload.options, { preset: "9:16" });
});

test("watermark custom text edits the menu message; default button works", async () => {
  const { env, store } = makeEnv();
  await post(env, msg("https://www.instagram.com/reel/abc/"));
  let id = lastMenuJobId();
  await post(env, cb(`a:watermark:${id}`));
  assert.ok(store.has("await:99"));
  await post(env, msg("© Rokon Studio"));
  const p = ghCalls()[0].body.client_payload;
  assert.equal(p.action, "watermark");
  assert.deepEqual(p.options, { text: "© Rokon Studio" });
  assert.equal(p.ctx.status_message_id, 8, "status reuses the menu message");
  assert.ok(!store.has("await:99"));
  store.delete("active:42"); store.delete("cool:42");
  await post(env, msg("https://x.com/a/status/1"));
  id = lastMenuJobId();
  await post(env, cb(`a:watermark:${id}`));
  await post(env, cb(`w:${id}`));
  assert.deepEqual(ghCalls()[1].body.client_payload.options, { text: "@mediaflobot" });
});

test("frames uses capped max_seconds", async () => {
  const { env } = makeEnv({ FRAMES_MAX_SECONDS: "500" });
  await post(env, msg("https://fb.watch/xyz/"));
  assert.match(lastSend().text, /Facebook link detected/);
  await post(env, cb(`a:frames:${lastMenuJobId()}`));
  assert.deepEqual(ghCalls()[0].body.client_payload.options, { max_seconds: 60 });
});

test("rate limit: one active job, then cooldown, then release endpoint frees slot", async () => {
  const { env, store } = makeEnv({ COOLDOWN_SECONDS: "20" });
  await post(env, msg("https://youtu.be/a"));
  const id = lastMenuJobId();
  await post(env, cb(`a:mp3:${id}`));
  assert.equal(ghCalls().length, 1);
  await post(env, msg("https://youtu.be/b"));
  await post(env, cb(`a:mp3:${lastMenuJobId()}`));
  assert.equal(ghCalls().length, 1, "second job blocked");
  assert.match(lastAnswer().text, /already have a job running/);
  assert.equal(lastAnswer().show_alert, true);

  const token = ghCalls()[0].body.client_payload.ctx.release_token;
  const rel = (t) => release(env, { user_id: 42, token: t });
  assert.equal((await rel("wrong")).status, 403);
  assert.equal((await rel(token)).status, 200);
  assert.ok(!store.has("active:42"));
  await post(env, cb(`a:mp3:${lastMenuJobId()}`));
  assert.match(lastAnswer().text, /wait \d+s/, "cooldown applies right after a job");
  store.set("cool:42", String(Date.now() - 60_000));
  await post(env, cb(`a:mp3:${lastMenuJobId()}`));
  assert.equal(ghCalls().length, 2);
});

test("dispatch failure shows friendly error with Try again, which reopens the menu", async () => {
  const { env, store } = makeEnv();
  githubStatus = 401;
  await post(env, msg("https://youtu.be/a"));
  const id = lastMenuJobId();
  await post(env, cb(`a:mp3:${id}`));
  assert.match(lastEdit().text, /Couldn't start processing/);
  assert.equal(buttons(lastEdit())[0].callback_data, `r:${id}`);
  assert.ok(!store.has("active:42"), "lock released on failure");
  await post(env, cb(`r:${id}`));
  assert.match(lastEdit().text, /link detected/);
});

test("cancel button and /cancel", async () => {
  const { env, store } = makeEnv();
  await post(env, msg("https://youtu.be/a"));
  const id = lastMenuJobId();
  await post(env, cb(`x:${id}`));
  assert.match(lastEdit().text, /Cancelled/);
  assert.ok(!store.has(`job:${id}`));
  await post(env, msg("/cancel"));
  assert.match(lastSend().text, /Nothing to cancel/);
});

test("unsupported link and expired menu", async () => {
  const { env } = makeEnv();
  await post(env, msg("https://example.com/video.mp4"));
  assert.match(lastSend().text, /couldn't find a supported link/);
  await post(env, cb("a:video:abcdef123456"));
  assert.match(lastEdit().text, /expired/);
  assert.equal(ghCalls().length, 0);
});

test("allowlist blocks other users", async () => {
  const { env } = makeEnv({ ALLOWED_USER_IDS: "42, 43" });
  await post(env, msg("https://youtu.be/x", 777));
  assert.match(lastSend().text, /private/);
  await post(env, msg("https://youtu.be/x", 43));
  assert.ok(lastSend().reply_markup);
});

test("progress bar", () => {
  assert.equal(progressBar(40), "▰▰▰▰▱▱▱▱▱▱ 40%");
  assert.equal(progressBar(150), "▰▰▰▰▰▰▰▰▰▰ 100%");
});

// ---- D1 usage database -------------------------------------------------------
const msgFrom = (text, from) => ({ update_id: 3, message: { message_id: 7, from, chat: { id: from.id, type: "private" }, text } });

test("D1: users upserted, link/command events and job rows written", async () => {
  const { env, DB } = makeEnv();
  const from = { id: 42, first_name: "Rokon", last_name: "U", username: "rokon", language_code: "en", is_premium: true };
  await post(env, msgFrom("/start", from));
  await post(env, msgFrom("https://www.instagram.com/reel/abc/", { ...from, username: "rokon2" }));
  const id = lastMenuJobId();
  assert.equal(DB.rows("SELECT username FROM users")[0].username, "rokon2", "profile updated on later messages");
  await post(env, cb(`a:mp3:${id}`, 42, { ...from, username: "rokon2" }));
  const [u] = DB.rows("SELECT * FROM users");
  assert.equal(u.user_id, 42);
  assert.equal(u.is_premium, 1);
  assert.equal(u.total_requests, 1);
  const ev = DB.rows("SELECT type, detail FROM events ORDER BY id");
  assert.deepEqual(ev.map((e) => [e.type, e.detail]), [["command", "/start"], ["link", "https://www.instagram.com/reel/abc/"]]);
  const [j] = DB.rows("SELECT * FROM jobs");
  const ctxp = ghCalls()[0].body.client_payload.ctx;
  assert.equal(j.id, ctxp.run_id);
  assert.equal(j.menu_id, id);
  assert.deepEqual([j.user_id, j.chat_id, j.platform, j.action, j.status], [42, 99, "instagram", "mp3", "queued"]);
  assert.notEqual(j.token_hash, ctxp.release_token, "only the token hash is stored");
  assert.equal(j.token_hash.length, 64);
});

test("D1: runner reports running then done; wrong token is rejected", async () => {
  const { env, DB, store } = makeEnv();
  await post(env, msg("https://youtu.be/a"));
  await post(env, cb(`a:mp3:${lastMenuJobId()}`));
  const { run_id, release_token } = ghCalls()[0].body.client_payload.ctx;
  assert.equal((await release(env, { user_id: 42, token: "nope", run_id, status: "running" })).status, 403);
  assert.equal((await release(env, { user_id: 42, token: release_token, run_id, status: "running" })).status, 200);
  assert.equal(DB.rows("SELECT status FROM jobs")[0].status, "running");
  assert.ok(store.has("active:42"), "running report keeps the slot");
  const r = await release(env, { user_id: 42, token: release_token, run_id, status: "done", title: "Me at the zoo",
    file_size: 123456, duration_sec: 19.1, processing_ms: 42000 });
  assert.equal(r.status, 200);
  const [j] = DB.rows("SELECT * FROM jobs");
  assert.deepEqual([j.status, j.title, j.file_size, j.duration_sec, j.processing_ms], ["done", "Me at the zoo", 123456, 19.1, 42000]);
  assert.ok(j.started_at && j.finished_at);
  assert.ok(!store.has("active:42"));
  assert.equal((await release(env, { user_id: 42, token: release_token, run_id, status: "failed" })).status, 403,
    "a finished job can't be rewritten");
});

test("D1: failed report stores error code; dispatch failure recorded", async () => {
  const { env, DB, store } = makeEnv();
  await post(env, msg("https://youtu.be/a"));
  await post(env, cb(`a:mp3:${lastMenuJobId()}`));
  const { run_id, release_token } = ghCalls()[0].body.client_payload.ctx;
  await release(env, { user_id: 42, token: release_token, run_id, status: "failed", error_code: "bot_check", error_message: "blocked" });
  assert.deepEqual(DB.rows("SELECT status, error_code FROM jobs")[0], { status: "failed", error_code: "bot_check" });
  store.delete("cool:42");
  githubStatus = 500;
  await post(env, msg("https://youtu.be/b"));
  await post(env, cb(`a:mp3:${lastMenuJobId()}`));
  const rows = DB.rows("SELECT status, error_code FROM jobs ORDER BY created_at, rowid");
  assert.deepEqual(rows[1], { status: "failed", error_code: "dispatch_failed" });
});

test("D1: blocked users can't start jobs", async () => {
  const { env, DB } = makeEnv();
  await post(env, msg("https://youtu.be/a"));
  DB.raw.exec("UPDATE users SET is_blocked = 1 WHERE user_id = 42");
  await post(env, cb(`a:mp3:${lastMenuJobId()}`));
  assert.equal(ghCalls().length, 0);
  assert.match(lastAnswer().text, /restricted/);
});

test("D1 outage never breaks the bot", async () => {
  const { env, DB } = makeEnv();
  DB.failing = true;
  await post(env, msg("/start"));
  assert.match(lastSend().text, /MediaFlow/);
  await post(env, msg("https://youtu.be/a"));
  await post(env, cb(`a:mp3:${lastMenuJobId()}`));
  assert.equal(ghCalls().length, 1, "job still dispatched");
  assert.ok(DB.calls > 0);
});

test("admin commands: /stats /users /recent for admins only", async () => {
  const { env } = makeEnv();
  const admin = { id: 1000, first_name: "Admin", username: "boss" };
  const rokon = { id: 42, first_name: "Rokon", username: "rokon" };
  await post(env, msgFrom("https://youtu.be/a", rokon));
  await post(env, cb(`a:mp3:${lastMenuJobId()}`, 42, rokon));
  const { run_id, release_token } = ghCalls()[0].body.client_payload.ctx;
  await release(env, { user_id: 42, token: release_token, run_id, status: "done", title: "Clip <1>", file_size: 2097152, processing_ms: 30000 });

  await post(env, msgFrom("/stats", admin));
  let t = lastSend().text;
  assert.match(t, /MediaFlow stats/);
  assert.match(t, /Total: <b>2<\/b>/);
  assert.match(t, /All: <b>1<\/b>/);
  assert.match(t, /Success rate: <b>100%<\/b>/);
  assert.match(t, /youtube: <b>1<\/b>/);
  assert.match(t, /mp3: <b>1<\/b>/);
  assert.match(t, /Avg processing: <b>30\.0 s<\/b>/);
  await post(env, msgFrom("/users", admin));
  t = lastSend().text;
  assert.match(t, /@rokon/);
  assert.match(t, /1 job ·/);
  await post(env, msgFrom("/recent@mediaflobot", admin));
  t = lastSend().text;
  assert.match(t, /✅ .*@rokon · youtube · mp3/);
  assert.match(t, /Clip &lt;1&gt; · 2\.0 MB · 30\.0 s/);

  await post(env, msgFrom("/stats", { id: 42, first_name: "Rokon" }));
  assert.match(lastSend().text, /couldn't find a supported link/, "non-admins get the unknown-command reply");
});

test("/about mentions usage logging", async () => {
  const { env } = makeEnv();
  await post(env, msg("/about"));
  assert.match(lastSend().text, /Usage data/);
});
