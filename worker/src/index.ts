/**
 * Telegram webhook handler (Cloudflare Worker, free plan).
 *
 * - Verifies Telegram's X-Telegram-Bot-Api-Secret-Token header.
 * - Shows an inline menu for a social media link.
 * - Keeps short-lived conversation state in KV (10 min TTL), never media.
 * - Hands the heavy work to GitHub Actions via repository_dispatch.
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
}

const STATE_TTL = 600; // seconds; KV minimum is 60
const SUPPORTED_HOSTS = [
  "youtube.com", "youtu.be", "tiktok.com", "instagram.com",
  "facebook.com", "fb.watch", "fb.com", "x.com", "twitter.com",
];

type Action = "video" | "mp3" | "watermark" | "crop" | "frames";

interface Job {
  url: string;
  chatId: number;
  userId: number;
}

interface PendingWatermark {
  jobId: string;
}

// ---- minimal Telegram types -------------------------------------------------
interface TgUser { id: number; username?: string; first_name?: string }
interface TgChat { id: number; type: string }
interface TgMessage { message_id: number; from?: TgUser; chat: TgChat; text?: string; caption?: string }
interface TgCallbackQuery { id: string; from: TgUser; message?: TgMessage; data?: string }
interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery }
interface InlineButton { text: string; callback_data: string }

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

const send = (env: Env, chatId: number, text: string, extra: Record<string, unknown> = {}) =>
  tg(env, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...extra });

export function extractSupportedUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  for (const raw of matches) {
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      if ((u.protocol === "https:" || u.protocol === "http:") &&
          SUPPORTED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
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

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

/** Constant-time string comparison for the webhook secret. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function mainMenu(jobId: string): InlineButton[][] {
  return [
    [{ text: "🎬 Download video", callback_data: `a:video:${jobId}` },
     { text: "🎵 Convert to MP3", callback_data: `a:mp3:${jobId}` }],
    [{ text: "💧 Add watermark", callback_data: `a:watermark:${jobId}` },
     { text: "✂️ Crop", callback_data: `a:crop:${jobId}` }],
    [{ text: "🖼 Frames (1/sec, zip)", callback_data: `a:frames:${jobId}` }],
  ];
}

function cropMenu(jobId: string): InlineButton[][] {
  return [
    [{ text: "📱 9:16 vertical", callback_data: `c:9:16:${jobId}` },
     { text: "⬛ 1:1 square", callback_data: `c:1:1:${jobId}` },
     { text: "🖥 16:9", callback_data: `c:16:9:${jobId}` }],
    [{ text: "« Back", callback_data: `b:${jobId}` }],
  ];
}

const HELP = [
  "Send me a link from YouTube, TikTok, Instagram, Facebook or X and choose:",
  "",
  "🎬 Download video: MP4, up to Telegram's 50 MB limit (shrunk if needed)",
  "🎵 Convert to MP3",
  "💧 Add watermark: your own text, or the default",
  "✂️ Crop: 9:16 vertical, 1:1 square or 16:9",
  "🖼 Frames: 1 image per second (first 60 s) as a ZIP",
  "",
  "Nothing is stored. Files exist only while being processed and are then deleted.",
  "Only download content you own or have the rights to use.",
].join("\n");

async function defaultWatermark(env: Env): Promise<string> {
  if (env.DEFAULT_WATERMARK) return env.DEFAULT_WATERMARK;
  const me = await tg(env, "getMe", {});
  return me?.result?.username ? `@${me.result.username}` : "watermark";
}

async function dispatch(env: Env, job: Job, action: Action, options: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "social-media-telegram-bot",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      event_type: "process-media",
      client_payload: { chat_id: job.chatId, url: job.url, action, options },
    }),
  });
  if (res.status !== 204) {
    console.log(`github dispatch failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return false;
  }
  return true;
}

async function startJob(env: Env, chatId: number, jobId: string, action: Action,
                        options: Record<string, unknown>, editMessageId?: number): Promise<void> {
  const job = await env.STATE.get<Job>(`job:${jobId}`, "json");
  if (!job) {
    await send(env, chatId, "⌛ That menu expired. Please send the link again.");
    return;
  }
  const ok = await dispatch(env, job, action, options);
  const text = ok
    ? `🚀 Queued: ${action}${options.preset ? ` ${options.preset}` : ""}. I'll send the result here shortly.`
    : "❌ Couldn't start processing (GitHub dispatch failed). Check the Worker's GITHUB_TOKEN/GITHUB_REPO.";
  if (editMessageId) {
    await tg(env, "editMessageText", { chat_id: chatId, message_id: editMessageId, text });
  } else {
    await send(env, chatId, text);
  }
  if (ok) await env.STATE.delete(`job:${jobId}`);
}

// ---- update handlers --------------------------------------------------------
async function onMessage(env: Env, msg: TgMessage): Promise<void> {
  const chatId = msg.chat.id;
  const text = (msg.text ?? msg.caption ?? "").trim();
  if (!isAllowed(env, msg.from?.id)) {
    await send(env, chatId, `⛔ This bot is private. Your Telegram user id is ${msg.from?.id ?? "unknown"}.`);
    return;
  }
  const cmd = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  if (cmd === "/start" || cmd === "/help") {
    const hello = cmd === "/start" ? `👋 Hi ${msg.from?.first_name ?? ""}!\n\n` : "";
    await send(env, chatId, hello + HELP);
    return;
  }
  if (cmd === "/cancel") {
    await env.STATE.delete(`await:${chatId}`);
    await send(env, chatId, "Cancelled.");
    return;
  }

  // Waiting for watermark text?
  const pending = await env.STATE.get<PendingWatermark>(`await:${chatId}`, "json");
  const url = extractSupportedUrl(text);
  if (pending && text && !url && !text.startsWith("/")) {
    await env.STATE.delete(`await:${chatId}`);
    await startJob(env, chatId, pending.jobId, "watermark", { text: text.slice(0, 60) });
    return;
  }

  if (!url) {
    await send(env, chatId, "Send me a YouTube, TikTok, Instagram, Facebook or X link. /help for more.");
    return;
  }
  await env.STATE.delete(`await:${chatId}`);
  const jobId = newId();
  const job: Job = { url, chatId, userId: msg.from?.id ?? 0 };
  await env.STATE.put(`job:${jobId}`, JSON.stringify(job), { expirationTtl: STATE_TTL });
  await send(env, chatId, "What should I do with this link?", {
    reply_to_message_id: msg.message_id,
    reply_markup: { inline_keyboard: mainMenu(jobId) },
  });
}

async function onCallback(env: Env, cq: TgCallbackQuery): Promise<void> {
  const chatId = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  const data = cq.data ?? "";
  if (!chatId || !messageId) {
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    return;
  }
  if (!isAllowed(env, cq.from.id)) {
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Not allowed", show_alert: true });
    return;
  }
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });

  const parts = data.split(":");
  const kind = parts[0];
  const jobId = parts[parts.length - 1];
  if (!/^[a-z0-9]{6,16}$/.test(jobId)) return;
  const job = await env.STATE.get<Job>(`job:${jobId}`, "json");
  if (!job) {
    await tg(env, "editMessageText", { chat_id: chatId, message_id: messageId,
      text: "⌛ This menu expired. Please send the link again." });
    return;
  }

  if (kind === "b") {
    await tg(env, "editMessageText", { chat_id: chatId, message_id: messageId,
      text: "What should I do with this link?", reply_markup: { inline_keyboard: mainMenu(jobId) } });
    return;
  }
  if (kind === "c") {
    const preset = `${parts[1]}:${parts[2]}`;
    if (!["9:16", "1:1", "16:9"].includes(preset)) return;
    await startJob(env, chatId, jobId, "crop", { preset }, messageId);
    return;
  }
  if (kind === "w") { // default watermark
    await env.STATE.delete(`await:${chatId}`);
    await startJob(env, chatId, jobId, "watermark", { text: await defaultWatermark(env) }, messageId);
    return;
  }
  if (kind !== "a") return;
  const action = parts[1] as Action;
  switch (action) {
    case "crop":
      await tg(env, "editMessageText", { chat_id: chatId, message_id: messageId,
        text: "Choose a crop:", reply_markup: { inline_keyboard: cropMenu(jobId) } });
      return;
    case "watermark": {
      await env.STATE.put(`await:${chatId}`, JSON.stringify({ jobId } satisfies PendingWatermark),
        { expirationTtl: STATE_TTL });
      const def = await defaultWatermark(env);
      await tg(env, "editMessageText", { chat_id: chatId, message_id: messageId,
        text: `💧 Send the watermark text now (max 60 characters), or use the default "${def}".`,
        reply_markup: { inline_keyboard: [
          [{ text: `Use "${def}"`.slice(0, 60), callback_data: `w:${jobId}` }],
          [{ text: "« Back", callback_data: `b:${jobId}` }],
        ] } });
      return;
    }
    case "frames": {
      const max = Math.min(60, Math.max(1, Number(env.FRAMES_MAX_SECONDS ?? 60) || 60));
      await startJob(env, chatId, jobId, "frames", { max_seconds: max }, messageId);
      return;
    }
    case "video":
    case "mp3":
      await startJob(env, chatId, jobId, action, {}, messageId);
      return;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("ok"); // health check
    }
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
      if (update.message) await onMessage(env, update.message);
      else if (update.callback_query) await onCallback(env, update.callback_query);
    } catch (err) {
      console.log(`handler error: ${(err as Error).message}`);
    }
    // Always 200 so Telegram doesn't retry the same update forever.
    return new Response("ok");
  },
} satisfies ExportedHandler<Env>;
