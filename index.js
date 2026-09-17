// Telegram -> Replicate image pipeline bot
// Pure Node 18+ — no external deps. Uses global fetch, FormData, Blob.
//
// ENV VARS (set these in Railway):
//   TELEGRAM_BOT_TOKEN   — from @BotFather
//   REPLICATE_API_TOKEN  — from https://replicate.com/account/api-tokens
//   REPLICATE_MODEL      — "owner/name:version_hash" of a clothing-removal model
//                          e.g. grab one from replicate.com and paste the full
//                          "owner/name:version" string here.
//   REPLICATE_INPUT_KEY  — name of the input field the model expects for the
//                          source image. Most use "image". Default: "image".
//   POLL_INTERVAL_MS     — optional, default 2500
//   POLL_MAX_TRIES       — optional, default 60

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RP_TOKEN = process.env.REPLICATE_API_TOKEN;
const RP_MODEL = process.env.REPLICATE_MODEL; // "owner/name:version"
const RP_INPUT_KEY = process.env.REPLICATE_INPUT_KEY || "image";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 2500);
const POLL_MAX_TRIES = Number(process.env.POLL_MAX_TRIES || 60);

if (!TG_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!RP_TOKEN) throw new Error("REPLICATE_API_TOKEN is required");
if (!RP_MODEL) throw new Error("REPLICATE_MODEL is required (owner/name:version)");

const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;
const TG_FILE = `https://api.telegram.org/file/bot${TG_TOKEN}`;

// ---------- Telegram helpers ----------

async function tg(method, payload) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`[tg:${method}]`, data.description || data);
  }
  return data;
}

async function tgSendPhoto(chatId, buffer, filename, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append(
    "photo",
    new Blob([buffer], { type: "image/jpeg" }),
    filename
  );
  const res = await fetch(`${TG_API}/sendPhoto`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) console.error("[tg:sendPhoto]", data.description || data);
  return data;
}

async function tgSendMessage(chatId, text) {
  return tg("sendMessage", { chat_id: chatId, text });
}

async function tgGetFilePath(fileId) {
  const data = await tg("getFile", { file_id: fileId });
  if (!data.ok) return null;
  return data.result.file_path;
}

async function tgDownloadFile(filePath) {
  const res = await fetch(`${TG_FILE}/${filePath}`);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// ---------- Replicate ----------

async function replicateRun(imageUrl) {
  // Replicate expects "owner/name:version" for the versioned endpoint.
  const [modelRef, version] = RP_MODEL.split(":");
  if (!modelRef || !version) {
    throw new Error("REPLICATE_MODEL must be in 'owner/name:version' format");
  }

  const createRes = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Token ${RP_TOKEN}`,
    },
    body: JSON.stringify({
      version,
      input: { [RP_INPUT_KEY]: imageUrl },
    }),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`replicate create failed (${createRes.status}): ${errText}`);
  }

  let pred = await createRes.json();
  const id = pred.id;
  const url = pred.urls?.get || `https://api.replicate.com/v1/predictions/${id}`;

  for (let i = 0; i < POLL_MAX_TRIES; i++) {
    await sleep(POLL_INTERVAL_MS);
    const pollRes = await fetch(url, {
      headers: { authorization: `Token ${RP_TOKEN}` },
    });
    if (!pollRes.ok) {
      throw new Error(`replicate poll failed: ${pollRes.status}`);
    }
    pred = await pollRes.json();

    if (pred.status === "succeeded") return pred.output;
    if (pred.status === "failed" || pred.status === "canceled") {
      throw new Error(`replicate ${pred.status}: ${pred.error || "unknown"}`);
    }
  }
  throw new Error("replicate timeout");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- Core handler ----------

// Telegram can re-deliver updates after restarts. Track the last update_id
// we've fully processed so we don't double-fire.
let lastUpdateId = 0;
const inFlight = new Set();

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = msg.chat.id;

  // /start
  if (msg.text && msg.text.trim().startsWith("/start")) {
    await tgSendMessage(
      chatId,
      "Send me a photo and I'll process it. 🖼️→✨"
    );
    return;
  }

  // Find the largest available photo size
  const photos = msg.photo;
  if (!photos || photos.length === 0) {
    if (msg.text) {
      await tgSendMessage(chatId, "Send a photo, not text.");
    }
    return;
  }

  const key = `${chatId}:${msg.message_id}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);

  try {
    await tg "SendMessage(chatId, "Processing… this can takestring 20–60s.");

   ") const best = photos[photos.length - 1];
    const filePath {
 = await tgGetFilePath(best.file_id);
         if (!filePath) throw new Error(" throwcould not resolve telegram file path");

 new    const imageUrl = `${TG_FILE Error}/${filePath}`;

    const output = await("model replicateRun(imageUrl);

    // Output is usually an array of URLs. Normalize.
    const outUrl = Array.isArray(output) ? output[output.length - 1] : output;
    if (!outUrl || typeof outUrl !== returned no image");
    }

    const outRes = await fetch(outUrl);
    if (!outRes.ok) throw new Error(`output download failed: ${outRes.status}`);
    const outBuf = Buffer.from(await outRes.arrayBuffer());

    await tgSendPhoto(chatId, outBuf, `out_${randomUUID()}.jpg`);
  } catch (err) {
    console.error("[handleUpdate]", err);
    await tgSendMessage(chatId, `Error: ${String(err.message || err)}`);
  } finally {
    inFlight.delete(key);
  }
}

// ---------- Long poll loop ----------

async function pollLoop() {
  console.log("[bot] started, long-polling");
  // Drain any pending updates on cold start so we begin fresh.
  const boot = await tg("getUpdates", { offset: -1, timeout: 0 });
  if (boot.ok && boot.result?.length) {
    lastUpdateId = boot.result[boot.result.length - 1].update_id;
  }

  while (true) {
    try {
      const data = await tg("getUpdates", {
        offset: lastUpdateId + 1,
        timeout: 30,
        allowed_updates: ["message", "edited_message"],
      });

      if (data.ok && Array.isArray(data.result)) {
        for (const upd of data.result) {
          lastUpdateId = Math.max(lastUpdateId, upd.update_id);
          // Fire and forget so a slow job doesn't stall the poll.
          handleUpdate(upd).catch((e) =>
            console.error("[update]", e)
          );
        }
      }
    } catch (err) {
      console.error("[poll]", err);
      await sleep(2000);
    }
  }
}

// Keep the process alive if Railway restarts us.
process.on("uncaughtException", (e) => console.error("[uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[unhandled]", e));

pollLoop();
