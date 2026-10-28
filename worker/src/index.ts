/**
 * MediaFlow — Telegram webhook handler (Cloudflare Worker, free plan).
 *
 * - Verifies Telegram's X-Telegram-Bot-Api-Secret-Token header.
 * - Branded welcome, help/features/about pages, platform-aware link card with
 *   inline menus that edit the same message in place.
 * - Short-lived state only in KV (every key has a TTL). No media is ever stored.
 * - Per-user rate limit: 1 active job + short cooldown, to protect free quotas.
 * - Hands the heavy work to GitHub Actions via repository_dispatch. The runner
 *   edits the same status message with a progress bar and releases the lock.
 */

export interface Env {
  STATE: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string; // "owner/repo"
  ALLOWED_USER_IDS?: string; // optional, comma separated Telegram user ids
  DEFAULT_WATERMARK?: string; // optional, defaults to the bot's @username
  FRAMES_MAX_SECONDS?: string;
  COOLDOWN_SECONDS?: string; // optional, default 20
}

const STATE_TTL = 1800; // job/menu state lives 30 min (enables "Try again")
const ACTIVE_TTL = 900; // safety expiry for the "1 active job" lock
const AWAIT_TTL = 600;
const COOLDOWN_TTL = 60; // KV minimum TTL

type Action = "video" | "mp3" | "watermark" | "crop" | "frames";

interface Platform { key: string; name: string; emoji: string; hosts: string[] }
const PLATFORMS: Platform[] = [
  { key: "youtube", name: "YouTube", emoji: "▶️", hosts: ["youtube.com", "youtu.be"] },
  { key: "tiktok", name: "TikTok", emoji: "🎵", hosts: ["tiktok.com"] },
  { key: "instagram", name: "Instagram", emoji: "📸", hosts: ["instagram.com"] },
  { key: "facebook", name: "Facebook", emoji: "📘", hosts: ["facebook.com", "fb.watch", "fb.com"] },
  { key: "x", name: "X (Twitter)", emoji: "𝕏", hosts: ["x.com", "twitter.com"] },
];

interface Job { url: string; chatId: number; userId: number; platform: string }
interface PendingWatermark { jobId: string; messageId: number }
interface ActiveLock { token: string; jobId: string; since: number }

// ---- minimal Telegram types -------------------------------------------------
interface TgUser { id: number; username?: string; first_name?: string }
interface TgChat { id: number; type: string }
interface TgMessage { message_id: number; from?: TgUser; chat: TgChat; text?: string; caption?: string }
interface TgCallbackQuery { id: string; from: TgUser; message?: TgMessage; data?: string }
interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery }
interface InlineButton { text: string; callback_data?: string; url?: string }
type Keyboard = InlineButton[][];

// ---- helpers ----------------------------------------------------------------
async function tg(env: Env, method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!data.ok) console.log(`telegram ${method} failed: ${data.description ?? res.status}`);
  return data;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const send = (env: Env, chatId: number, text: string, keyboard?: Keyboard, extra: Record<string, unknown> = {}) =>
  tg(env, "sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}), ...extra,
  });

const edit = (env: Env, chatId: number, messageId: number, text: string, keyboard?: Keyboard) =>
  tg(env, "editMessageText", {
    chat_id: chatId, message_id: messageId, text, parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: keyboard ?? [] },
  });

export function progressBar(pct: number, width = 10): string {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const filled = Math.round((p / 100) * width);
  return `${"▰".repeat(filled)}${"▱".repeat(width - filled)} ${p}%`;
}

export function detectPlatform(url: string): Platform | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return PLATFORMS.find((p) => p.hosts.some((h) => host === h || host.endsWith(`.${h}`))) ?? null;
  } catch { return null; }
}

export function extractSupportedUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  for (const raw of matches) {
    try {
      const u = new URL(raw);
      if ((u.protocol === "https:" || u.protocol === "http:") && detectPlatform(u.toString())) {
        return u.toString();
      }
    } catch { /* ignore */ }
  }
  return null;
}

export function isAllowed(env: Env, userId: number | undefined): boolean {
  const list = (env.ALLOWED_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return true;
  return userId !== undefined && list.includes(String(userId));
}

function newId(len = 12): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

/** Constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const s = `${u.hostname.replace(/^www\./, "")}${u.pathname}`.replace(/\/$/, "");
    return s.length > 48 ? `${s.slice(0, 47)}…` : s;
  } catch { return url.slice(0, 48); }
}

let cachedUsername: string | null = null;
async function botUsername(env: Env): Promise<string> {
  if (cachedUsername) return cachedUsername;
  const me = await tg(env, "getMe", {});
  cachedUsername = me?.result?.username ?? "mediaflobot";
  return cachedUsername!;
}

async function defaultWatermark(env: Env): Promise<string> {
  return env.DEFAULT_WATERMARK || `@${await botUsername(env)}`;
}

// ---- copy -------------------------------------------------------------------
const PLATFORM_LINES =
  "▶️ YouTube  ·  🎵 TikTok  ·  📸 Instagram\n📘 Facebook  ·  𝕏 X (Twitter)";

export function welcomeText(firstName?: string): string {
  const hi = firstName ? `👋 Hi <b>${esc(firstName)}</b>, welcome to\n` : "";
  return [
    `${hi}🎬 <b>MediaFlow</b>`,
    "<i>Download &amp; edit social videos in seconds.</i>",
    "",
    "<b>Works with</b>",
    PLATFORM_LINES,
    "",
    "<b>How it works</b>",
    "1️⃣  Paste a video link here",
    "2️⃣  Pick an action from the menu",
    "3️⃣  Get your file in 1–3 minutes",
    "",
    "🔒 <i>Nothing is stored. Files are deleted right after delivery.</i>",
  ].join("\n");
}

const HELP_TEXT = [
  "📖 <b>How to use MediaFlow</b>",
  "",
  "<b>1.</b> Copy a link from YouTube, TikTok, Instagram, Facebook or X.",
  "<b>2.</b> Paste it here. I'll detect the platform and show a menu.",
  "<b>3.</b> Tap an action. One status message shows live progress.",
  "<b>4.</b> Your file arrives here with a caption.",
  "",
  "<b>Commands</b>",
  "/start · Welcome screen",
  "/features · What I can do",
  "/help · This guide",
  "/cancel · Cancel the current menu or input",
  "/about · About &amp; support",
  "",
  "💡 <i>Tip: files are limited to 50 MB (Telegram's bot limit). Longer videos are shrunk automatically.</i>",
].join("\n");

const FEATURES_TEXT = [
  "⚙️ <b>Features</b>",
  "",
  "📥 <b>Download Video</b>: MP4 in Best, 720p or 480p",
  "🎵 <b>MP3 Audio</b>: extract the soundtrack",
  "💧 <b>Watermark</b>: burn in your own text or the default",
  "✂️ <b>Crop</b>: 📱 9:16 vertical, ⬛ 1:1 square, 🖥 16:9 wide",
  "🖼 <b>Frames</b>: 1 image per second (first 60 s) as a ZIP",
  "",
  "⚡ Live progress, one job at a time per user, files up to 50 MB.",
].join("\n");

const ABOUT_TEXT = [
  "💬 <b>About MediaFlow</b>",
  "",
  "MediaFlow is a free, privacy-first media helper.",
  "Runs on Cloudflare Workers + GitHub Actions.",
  "",
  "🔒 <b>Privacy</b>: no accounts, no history, no stored files.",
  "Links are kept for at most 30 minutes so menus keep working, then expire.",
  "",
  "⚖️ <b>Fair use</b>: only download content you own or have the rights to use.",
  "",
  "🆘 <b>Support</b>: something broke? Tap 🔁 Try again on the error, or send the link once more.",
].join("\n");

const homeKeyboard = (): Keyboard => [
  [{ text: "📖 Help", callback_data: "m:help" }, { text: "⚙️ Features", callback_data: "m:features" }],
  [{ text: "💬 About & Support", callback_data: "m:about" }],
];
const backHome = (): Keyboard => [[{ text: "⬅️ Back", callback_data: "m:home" }]];

const ACTION_LABELS: Record<string, string> = {
  video: "📥 Video", mp3: "🎵 MP3 Audio", watermark: "💧 Watermark",
  crop: "✂️ Crop", frames: "🖼 Frames (1/sec)",
};
const QUALITY_LABELS: Record<string, string> = { best: "Best", "720": "720p", "480": "480p" };
const CROP_PRESETS: Record<string, string> = { "9x16": "9:16", "1x1": "1:1", "16x9": "16:9" };

export function actionLabel(action: Action, options: Record<string, unknown>): string {
  if (action === "video") return `📥 Video · ${QUALITY_LABELS[String(options.quality ?? "720")] ?? "720p"}`;
  if (action === "crop") return `✂️ Crop ${options.preset}`;
  return ACTION_LABELS[action];
}

function platformOf(job: Job): Platform {
  return PLATFORMS.find((p) => p.key === job.platform) ?? PLATFORMS[0];
}

export function linkCardText(job: Job): string {
  const p = platformOf(job);
  return [
    `${p.emoji} <b>${esc(p.name)} link detected</b>`,
    `🔗 <code>${esc(shortUrl(job.url))}</code>`,
    "",
    "What would you like to do? 👇",
  ].join("\n");
}

export function mainMenu(jobId: string): Keyboard {
  return [
    [{ text: "📥 Download Video", callback_data: `a:video:${jobId}` },
     { text: "🎵 MP3 Audio", callback_data: `a:mp3:${jobId}` }],
    [{ text: "💧 Watermark", callback_data: `a:watermark:${jobId}` },
     { text: "✂️ Crop", callback_data: `a:crop:${jobId}` }],
    [{ text: "🖼 Frames (1/sec)", callback_data: `a:frames:${jobId}` },
     { text: "❌ Cancel", callback_data: `x:${jobId}` }],
  ];
}

const back = (jobId: string): InlineButton => ({ text: "⬅️ Back", callback_data: `b:${jobId}` });

function qualityMenu(jobId: string): Keyboard {
  return [
    [{ text: "🌟 Best", callback_data: `q:best:${jobId}` },
     { text: "📺 720p", callback_data: `q:720:${jobId}` },
     { text: "📱 480p", callback_data: `q:480:${jobId}` }],
    [back(jobId)],
  ];
}

function cropMenu(jobId: string): Keyboard {
  return [
    [{ text: "📱 9:16 Vertical", callback_data: `c:9x16:${jobId}` },
     { text: "⬛ 1:1 Square", callback_data: `c:1x1:${jobId}` }],
    [{ text: "🖥 16:9 Wide", callback_data: `c:16x9:${jobId}` }, back(jobId)],
  ];
}

const retryKeyboard = (jobId: string): Keyboard =>
  [[{ text: "🔁 Try again", callback_data: `r:${jobId}` }]];

export function statusText(stage: string, pct: number, job: Job, label: string, note?: string): string {
  const p = platformOf(job);
  return [
    stage, progressBar(pct), "", `${p.emoji} ${esc(p.name)}  ·  ${label}`,
    ...(note ? ["", `<i>${note}</i>`] : []),
  ].join("\n");
}

// ---- rate limiting ------------------------------------------------------------
/** Returns a user-facing reason if the user may not start a job right now. */
async function rateLimited(env: Env, userId: number): Promise<string | null> {
  const active = await env.STATE.get<ActiveLock>(`active:${userId}`, "json");
  if (active) return "⏳ You already have a job running. Please wait for it to finish, then try again.";
  const last = Number(await env.STATE.get(`cool:${userId}`)) || 0;
  const cooldown = Math.max(0, Number(env.COOLDOWN_SECONDS ?? 20) || 0);
  const wait = Math.ceil(cooldown - (Date.now() - last) / 1000);
  if (last && wait > 0) return `🧊 Easy there! Please wait ${wait}s before starting another job.`;
  return null;
}

// ---- GitHub dispatch -----------------------------------------------------------
async function dispatch(env: Env, payload: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "mediaflow-telegram-bot",
      "content-type": "application/json",
    },
    body: JSON.stringify({ event_type: "process-media", client_payload: payload }),
  });
  if (res.status !== 204) {
    console.log(`github dispatch failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return false;
  }
  return true;
}

/**
 * Start a job. Returns null on success or a short toast/alert text if the user
 * is rate-limited (the menu is left untouched in that case).
 */
async function startJob(env: Env, origin: string, chatId: number, userId: number, jobId: string,
                        action: Action, options: Record<string, unknown>, messageId: number): Promise<string | null> {
  const job = await env.STATE.get<Job>(`job:${jobId}`, "json");
  if (!job) {
    await edit(env, chatId, messageId, "⌛ <b>This menu expired.</b>\nPlease send the link again.");
    return null;
  }
  const limited = await rateLimited(env, userId);
  if (limited) return limited;

  const label = actionLabel(action, options);
  const p = platformOf(job);
  const token = newId(24);
  await env.STATE.put(`active:${userId}`, JSON.stringify({ token, jobId, since: Date.now() } satisfies ActiveLock),
    { expirationTtl: ACTIVE_TTL });
  await env.STATE.put(`cool:${userId}`, String(Date.now()), { expirationTtl: COOLDOWN_TTL });

  await edit(env, chatId, messageId, statusText("🚀 <b>Queued…</b>", 0, job, label,
    "Starting a processing server. This usually takes 1–3 minutes."));
  const ok = await dispatch(env, {
    chat_id: chatId, url: job.url, action, options,
    ctx: {
      job_id: jobId, status_message_id: messageId, user_id: userId,
      platform: p.name, platform_emoji: p.emoji, label,
      bot_username: await botUsername(env),
      release_url: `${origin}/release`, release_token: token,
    },
  });
  if (!ok) {
    await env.STATE.delete(`active:${userId}`);
    await edit(env, chatId, messageId,
      "😕 <b>Couldn't start processing.</b>\nThe processing service didn't accept the job. Please try again in a minute.",
      retryKeyboard(jobId));
  }
  return null;
}

// ---- update handlers --------------------------------------------------------
async function onMessage(env: Env, origin: string, msg: TgMessage): Promise<void> {
  const chatId = msg.chat.id;
  const text = (msg.text ?? msg.caption ?? "").trim();
  if (!isAllowed(env, msg.from?.id)) {
    await send(env, chatId, `⛔ <b>This bot is private.</b>\nYour Telegram user id is <code>${msg.from?.id ?? "unknown"}</code>.`);
    return;
  }
  const cmd = text.startsWith("/") ? text.split(/\s+/)[0].split("@")[0].toLowerCase() : "";
  switch (cmd) {
    case "/start": await send(env, chatId, welcomeText(msg.from?.first_name), homeKeyboard()); return;
    case "/help": await send(env, chatId, HELP_TEXT, backHome()); return;
    case "/features": await send(env, chatId, FEATURES_TEXT, backHome()); return;
    case "/about": await send(env, chatId, ABOUT_TEXT, backHome()); return;
    case "/cancel": {
      const pending = await env.STATE.get<PendingWatermark>(`await:${chatId}`, "json");
      if (pending) {
        await env.STATE.delete(`await:${chatId}`);
        await env.STATE.delete(`job:${pending.jobId}`);
        await edit(env, chatId, pending.messageId, "✖️ <b>Cancelled.</b>\nSend another link anytime.");
      }
      await send(env, chatId, pending ? "✖️ Cancelled." : "Nothing to cancel. Send me a link to get started 🎬");
      return;
    }
  }

  const url = extractSupportedUrl(text);
  const pending = url ? null : await env.STATE.get<PendingWatermark>(`await:${chatId}`, "json");
  if (pending && text && !cmd) {
    await env.STATE.delete(`await:${chatId}`);
    const toast = await startJob(env, origin, chatId, msg.from?.id ?? 0, pending.jobId, "watermark",
      { text: text.slice(0, 60) }, pending.messageId);
    if (toast) await send(env, chatId, toast);
    return;
  }

  if (!url) {
    await send(env, chatId,
      "🤔 <b>I couldn't find a supported link.</b>\n\nSend a link from:\n" + PLATFORM_LINES,
      [[{ text: "📖 Help", callback_data: "m:help" }, { text: "⚙️ Features", callback_data: "m:features" }]]);
    return;
  }
  await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });
  await env.STATE.delete(`await:${chatId}`);
  const jobId = newId();
  const job: Job = { url, chatId, userId: msg.from?.id ?? 0, platform: detectPlatform(url)!.key };
  await env.STATE.put(`job:${jobId}`, JSON.stringify(job), { expirationTtl: STATE_TTL });
  await send(env, chatId, linkCardText(job), mainMenu(jobId), {
    reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
  });
}

async function onCallback(env: Env, origin: string, cq: TgCallbackQuery): Promise<void> {
  const chatId = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  const data = cq.data ?? "";
  let toast: string | null = null;
  let alert = false;
  try {
    if (!chatId || !messageId) return;
    if (!isAllowed(env, cq.from.id)) { toast = "⛔ This bot is private."; alert = true; return; }

    const parts = data.split(":");
    const kind = parts[0];

    if (kind === "m") { // static pages
      const page = parts[1];
      if (page === "home") await edit(env, chatId, messageId, welcomeText(cq.from.first_name), homeKeyboard());
      else if (page === "help") await edit(env, chatId, messageId, HELP_TEXT, backHome());
      else if (page === "features") await edit(env, chatId, messageId, FEATURES_TEXT, backHome());
      else if (page === "about") await edit(env, chatId, messageId, ABOUT_TEXT, backHome());
      return;
    }

    const jobId = parts[parts.length - 1];
    if (!/^[a-z0-9]{6,16}$/.test(jobId)) return;
    const job = await env.STATE.get<Job>(`job:${jobId}`, "json");
    if (!job) {
      await edit(env, chatId, messageId, "⌛ <b>This menu expired.</b>\nPlease send the link again.");
      toast = "Menu expired";
      return;
    }
    const uid = cq.from.id;
    const run = async (action: Action, options: Record<string, unknown>) => {
      const limited = await startJob(env, origin, chatId, uid, jobId, action, options, messageId);
      if (limited) { toast = limited; alert = true; } else toast = "🚀 Job started";
    };

    switch (kind) {
      case "b": // back to main menu
      case "r": // try again
        await env.STATE.delete(`await:${chatId}`);
        await edit(env, chatId, messageId, linkCardText(job), mainMenu(jobId));
        return;
      case "x":
        await env.STATE.delete(`job:${jobId}`);
        await env.STATE.delete(`await:${chatId}`);
        await edit(env, chatId, messageId, "✖️ <b>Cancelled.</b>\nSend another link anytime.");
        toast = "Cancelled";
        return;
      case "q": {
        const quality = parts[1];
        if (!(quality in QUALITY_LABELS)) return;
        await run("video", { quality });
        return;
      }
      case "c": {
        const preset = CROP_PRESETS[parts[1]];
        if (!preset) return;
        await run("crop", { preset });
        return;
      }
      case "w":
        await env.STATE.delete(`await:${chatId}`);
        await run("watermark", { text: await defaultWatermark(env) });
        return;
      case "a":
        break;
      default:
        return;
    }

    const action = parts[1] as Action;
    const p = platformOf(job);
    switch (action) {
      case "video":
        await edit(env, chatId, messageId,
          `📥 <b>Download Video</b>\n${p.emoji} ${esc(p.name)}\n\nChoose a quality:\n<i>Best is capped to fit Telegram's 50 MB limit.</i>`,
          qualityMenu(jobId));
        return;
      case "crop":
        await edit(env, chatId, messageId,
          `✂️ <b>Crop</b>\n${p.emoji} ${esc(p.name)}\n\nChoose a shape (centre crop):`, cropMenu(jobId));
        return;
      case "watermark": {
        await env.STATE.put(`await:${chatId}`, JSON.stringify({ jobId, messageId } satisfies PendingWatermark),
          { expirationTtl: AWAIT_TTL });
        const def = await defaultWatermark(env);
        await edit(env, chatId, messageId,
          `💧 <b>Watermark</b>\n${p.emoji} ${esc(p.name)}\n\n✍️ Type your watermark text now (max 60 characters),\nor use the default <b>${esc(def)}</b>.`,
          [[{ text: `✨ Use ${def}`.slice(0, 60), callback_data: `w:${jobId}` }], [back(jobId)]]);
        return;
      }
      case "frames": {
        const max = Math.min(60, Math.max(1, Number(env.FRAMES_MAX_SECONDS ?? 60) || 60));
        await run("frames", { max_seconds: max });
        return;
      }
      case "mp3":
        await run("mp3", {});
        return;
    }
  } finally {
    await tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id, ...(toast ? { text: toast, show_alert: alert } : {}),
    });
  }
}

/** Called by the GitHub runner when a job ends, to free the user's job slot. */
async function onRelease(env: Env, request: Request): Promise<Response> {
  let body: any;
  try { body = await request.json(); } catch { return new Response("bad request", { status: 400 }); }
  const uid = Number(body?.user_id);
  const token = String(body?.token ?? "");
  if (!Number.isInteger(uid) || !token) return new Response("bad request", { status: 400 });
  const lock = await env.STATE.get<ActiveLock>(`active:${uid}`, "json");
  if (!lock || !safeEqual(lock.token, token)) return new Response("forbidden", { status: 403 });
  await env.STATE.delete(`active:${uid}`);
  return new Response("released");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("MediaFlow bot is running."); // health check
    }
    if (request.method === "POST" && url.pathname === "/release") return onRelease(env, request);
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("not found", { status: 404 });
    }
    const secret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!env.WEBHOOK_SECRET || !safeEqual(secret, env.WEBHOOK_SECRET)) {
      return new Response("unauthorized", { status: 401 });
    }
    let update: TgUpdate;
    try {
      update = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }
    try {
      if (update.message) await onMessage(env, url.origin, update.message);
      else if (update.callback_query) await onCallback(env, url.origin, update.callback_query);
    } catch (err) {
      console.log(`handler error: ${(err as Error).message}`);
    }
    // Always 200 so Telegram doesn't retry the same update forever.
    return new Response("ok");
  },
} satisfies ExportedHandler<Env>;
