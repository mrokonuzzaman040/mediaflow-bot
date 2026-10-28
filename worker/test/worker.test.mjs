// Behavioural tests for the Worker using the wrangler-bundled output (dist/index.js),
// a mocked fetch (Telegram + GitHub) and an in-memory KV. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../dist/index.js";

function makeEnv(extra = {}) {
  const store = new Map();
  const STATE = {
    async get(k, type) { const v = store.get(k); return v === undefined ? null : type === "json" ? JSON.parse(v) : v; },
    async put(k, v, opts) { assert.ok(opts?.expirationTtl >= 60, "every KV write must have a TTL"); store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
  return { store, env: { STATE, TELEGRAM_BOT_TOKEN: "123:ABC", WEBHOOK_SECRET: "s3cret",
    GITHUB_TOKEN: "ghp_x", GITHUB_REPO: "me/repo", ALLOWED_USER_IDS: "", DEFAULT_WATERMARK: "",
    FRAMES_MAX_SECONDS: "60", ...extra } };
}

const calls = [];
globalThis.fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : {};
  calls.push({ url: String(url), body, headers: init?.headers });
  if (String(url).includes("api.github.com")) return new Response(null, { status: 204 });
  if (String(url).endsWith("/getMe")) return Response.json({ ok: true, result: { username: "RokonMediaBot" } });
  return Response.json({ ok: true, result: { message_id: 1 } });
};

const post = (env, update, secret = "s3cret") => worker.fetch(new Request("https://w.dev/webhook", {
  method: "POST", headers: { "x-telegram-bot-api-secret-token": secret, "content-type": "application/json" },
  body: JSON.stringify(update) }), env);
const msg = (text, uid = 42) => ({ update_id: 1, message: { message_id: 7, from: { id: uid, first_name: "Rokon" }, chat: { id: 99, type: "private" }, text } });
const cb = (data, uid = 42) => ({ update_id: 2, callback_query: { id: "q", from: { id: uid }, data, message: { message_id: 8, chat: { id: 99, type: "private" } } } });
const tgCalls = (m) => calls.filter((c) => c.url.endsWith("/" + m));
const ghCalls = () => calls.filter((c) => c.url.includes("api.github.com"));
const lastMenuJobId = () => { const kb = tgCalls("sendMessage").at(-1).body.reply_markup.inline_keyboard; return kb[0][0].callback_data.split(":").at(-1); };

test("rejects missing/wrong secret token", async () => {
  const { env } = makeEnv();
  assert.equal((await post(env, msg("/start"), "nope")).status, 401);
  assert.equal((await worker.fetch(new Request("https://w.dev/webhook", { method: "POST", body: "{}" }), env)).status, 401);
});

test("/start and /help reply", async () => {
  const { env } = makeEnv(); calls.length = 0;
  assert.equal((await post(env, msg("/start")).then((r) => r.status)), 200);
  await post(env, msg("/help@RokonMediaBot"));
  assert.equal(tgCalls("sendMessage").length, 2);
  assert.match(tgCalls("sendMessage")[0].body.text, /YouTube, TikTok/);
});

test("link -> menu -> mp3 dispatches to GitHub", async () => {
  const { env, store } = makeEnv(); calls.length = 0;
  await post(env, msg("check https://youtu.be/dQw4w9WgXcQ please"));
  const id = lastMenuJobId();
  assert.ok(store.has(`job:${id}`));
  await post(env, cb(`a:mp3:${id}`));
  const gh = ghCalls();
  assert.equal(gh.length, 1);
  assert.equal(gh[0].url, "https://api.github.com/repos/me/repo/dispatches");
  assert.equal(gh[0].headers.authorization, "Bearer ghp_x");
  assert.deepEqual(gh[0].body, { event_type: "process-media", client_payload: { chat_id: 99, url: "https://youtu.be/dQw4w9WgXcQ", action: "mp3", options: {} } });
  assert.ok(!store.has(`job:${id}`), "job state removed after dispatch");
});

test("crop submenu -> 9:16", async () => {
  const { env } = makeEnv(); calls.length = 0;
  await post(env, msg("https://www.tiktok.com/@a/video/1"));
  const id = lastMenuJobId();
  await post(env, cb(`a:crop:${id}`));
  assert.equal(ghCalls().length, 0);
  await post(env, cb(`c:9:16:${id}`));
  assert.deepEqual(ghCalls()[0].body.client_payload.options, { preset: "9:16" });
});

test("watermark custom text and default", async () => {
  const { env, store } = makeEnv(); calls.length = 0;
  await post(env, msg("https://www.instagram.com/reel/abc/"));
  let id = lastMenuJobId();
  await post(env, cb(`a:watermark:${id}`));
  assert.ok(store.has("await:99"));
  await post(env, msg("© Rokon Studio"));
  assert.deepEqual(ghCalls()[0].body.client_payload, { chat_id: 99, url: "https://www.instagram.com/reel/abc/", action: "watermark", options: { text: "© Rokon Studio" } });
  assert.ok(!store.has("await:99"));
  await post(env, msg("https://x.com/a/status/1"));
  id = lastMenuJobId();
  await post(env, cb(`a:watermark:${id}`));
  await post(env, cb(`w:${id}`));
  assert.deepEqual(ghCalls()[1].body.client_payload.options, { text: "@RokonMediaBot" });
});

test("frames uses capped max_seconds", async () => {
  const { env } = makeEnv({ FRAMES_MAX_SECONDS: "500" }); calls.length = 0;
  await post(env, msg("https://fb.watch/xyz/"));
  await post(env, cb(`a:frames:${lastMenuJobId()}`));
  assert.deepEqual(ghCalls()[0].body.client_payload.options, { max_seconds: 60 });
});

test("unsupported link and expired menu", async () => {
  const { env } = makeEnv(); calls.length = 0;
  await post(env, msg("https://example.com/video.mp4"));
  assert.match(tgCalls("sendMessage").at(-1).body.text, /Send me a YouTube/);
  await post(env, cb("a:video:abcdef123456"));
  assert.match(tgCalls("editMessageText").at(-1).body.text, /expired/);
  assert.equal(ghCalls().length, 0);
});

test("allowlist blocks other users", async () => {
  const { env } = makeEnv({ ALLOWED_USER_IDS: "42, 43" }); calls.length = 0;
  await post(env, msg("https://youtu.be/x", 777));
  assert.match(tgCalls("sendMessage").at(-1).body.text, /private/);
  await post(env, msg("https://youtu.be/x", 43));
  assert.ok(tgCalls("sendMessage").at(-1).body.reply_markup);
});
