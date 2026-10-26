#!/usr/bin/env node
/**
 * speakd v1.0 — universal speak gateway: one voice bus, with an identity.
 *
 * One tiny process (Node >= 18, zero dependencies) that any agent can call:
 *
 *   HTTP mode:   node speakd.mjs            → HTTP + streamable-HTTP MCP on 127.0.0.1:8777
 *   MCP mode:    node speakd.mjs --mcp      → stdio MCP server
 *
 * Doors (all loopback-only):
 *   POST /speak            {"text"}                      manual speech, service default voice
 *   POST /speak            {"text","as":"deepy"}         speak with deepy's voice + announcement
 *                          {"text","voice":"gb-male"}    speak with a specific pool voice
 *   POST /speak/<client>   harness door (auto voice assignment)
 *   POST /mcp              streamable-HTTP MCP, stateless (headers name the client)
 *   POST /mcp/<client>     streamable-HTTP MCP with identity in the path
 *   GET  /status           full introspection (who speaks, queue, voices, events)
 *   POST /stop             kill the current utterance + flush the queue
 *   POST /queue/clear      flush the waiting queue (current keeps playing)
 *   GET  /health           liveness + one-line summary
 *
 * Tools over MCP: speak, user_context, status (compact by default).
 *
 * Voice pool: ~/.config/speakd/voices.json — clients claim free voices
 * automatically (least-used first), assignments are sticky and persisted.
 * State lives in memory; the file is a debounced, atomic mirror.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, rename, access, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

process.on("unhandledRejection", (e) => console.error(`speakd: unhandled rejection: ${e?.message ?? e}`));

//#region config
const VERSION = "1.0.0";
const BOOT = Date.now();
const cfg = {
  port: Number(process.env.SPEAKD_PORT ?? 8777),
  host: process.env.SPEAKD_HOST ?? "127.0.0.1", // loopback only, never exposed
  provider: process.env.SPEAKD_PROVIDER ?? "beep",
  announce: (process.env.SPEAKD_ANNOUNCE ?? "on") === "on", // prefix caller name when known
  apiKey: process.env.SPEAKD_API_KEY ?? "",
  apiKeyEnv: process.env.SPEAKD_API_KEY_ENV ?? (process.env.SPEAKD_PROVIDER === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY"),
  model: process.env.SPEAKD_MODEL || undefined,
  voice: process.env.SPEAKD_VOICE || undefined,
  format: process.env.SPEAKD_FORMAT ?? "mp3",
  command: process.env.SPEAKD_COMMAND ?? "",
  args: (() => {
    try {
      const v = JSON.parse(process.env.SPEAKD_ARGS ?? "[]");
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      console.error("speakd: SPEAKD_ARGS is not valid JSON; ignoring");
      return [];
    }
  })(),
  mime: process.env.SPEAKD_MIME ?? "audio/wav",
  pcmRate: Number(process.env.SPEAKD_PCM_RATE ?? 22050),
  playback: process.env.SPEAKD_PLAYBACK ?? "host",
  maxChars: Number(process.env.SPEAKD_MAX_CHARS ?? 450),
  token: process.env.SPEAKD_TOKEN ?? "",
  queueLimit: Number(process.env.SPEAKD_QUEUE_LIMIT ?? 6),
  minGapMs: Number(process.env.SPEAKD_MIN_GAP_MS ?? 900), // pause between jobs (burst guard)
  ring: (process.env.SPEAKD_RING ?? "on") === "on", // bounded event log for /status
};
if (cfg.host !== "127.0.0.1" && cfg.host !== "localhost" && cfg.host !== "::1") {
  console.error(`speakd: refusing non-loopback bind host "${cfg.host}" (this server must never be exposed)`);
  process.exit(1);
}
//#endregion

//#region user profile — exposed to agents via the user_context tool
const profilePath = process.env.SPEAKD_PROFILE ?? join(homedir(), ".config", "speakd", "profile.json");
let userProfile = null;
try {
  userProfile = JSON.parse(await readFile(profilePath, "utf8"));
} catch {
  userProfile = null;
}
//#endregion

//#region voice pool — memory is the source of truth; file is a debounced atomic mirror
const voicesPath = process.env.SPEAKD_VOICES ?? join(homedir(), ".config", "speakd", "voices.json");
const HOME = homedir();
const expandPath = (p) => (typeof p === "string" ? p.replace(/^~(?=\/|$)/, HOME) : p);

let voiceState = { pool: null }; // in-memory state; mutated only synchronously
let persistTimer = null;

async function loadVoiceState() {
  try {
    voiceState = JSON.parse(await readFile(voicesPath, "utf8")) ?? { pool: null };
  } catch (e) {
    console.error(`speakd: voices.json unreadable (${e?.message ?? e}); starting with empty voice state`);
    voiceState = { pool: null };
  }
}

function persistVoiceStateSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const tmp = `${voicesPath}.tmp`;
    writeFile(tmp, JSON.stringify(voiceState, null, 2) + "\n")
      .then(() => rename(tmp, voicesPath))
      .catch((e) => console.error(`speakd: could not persist voices.json: ${e?.message ?? e}`));
  }, 500);
}

/**
 * Resolve the voice for one client name. Synchronous against in-memory
 * state: assignment mutates + schedules a debounced persist, so two
 * concurrent first-calls can never interleave a stale read-modify-write.
 * allowAssign=false (manual /speak "as") never claims or writes anything.
 */
function resolveVoice(clientName, { allowAssign = true } = {}) {
  if (!clientName) return null;
  const key = String(clientName).toLowerCase();
  const pool = Array.isArray(voiceState.pool) ? voiceState.pool : null;

  if (!pool) {
    // Explicit mode: fixed per-name map.
    const v = voiceState[key];
    if (!v || typeof v.model !== "string") return null;
    return { id: key, model: expandPath(v.model), lengthScale: Number(v.lengthScale ?? 1.45) };
  }

  let entry = pool.find((p) => p && p.clients?.includes(key));
  if (!entry && allowAssign) {
    const usable = pool.filter((p) => p && typeof p.model === "string");
    const free = usable.filter((p) => !(p.clients?.length)).sort((a, b) => Number(a.usage ?? 0) - Number(b.usage ?? 0));
    entry = free[0] ?? usable.sort((a, b) => Number(a.usage ?? 0) - Number(b.usage ?? 0))[0] ?? null;
    if (entry) {
      entry.clients = [...(entry.clients ?? []), key];
      entry.usage = Number(entry.usage ?? 0) + 1;
      persistVoiceStateSoon();
    }
  }
  if (!entry || typeof entry.model !== "string") return null;
  return { id: entry.id ?? key, model: expandPath(entry.model), lengthScale: Number(entry.lengthScale ?? 1.45) };
}

/** Known client names (for /speak "as" validation) — never mutates. */
function knownClients() {
  const pool = Array.isArray(voiceState.pool) ? voiceState.pool : null;
  const names = new Set();
  if (pool) for (const p of pool) for (const c of p.clients ?? []) names.add(c);
  else for (const k of Object.keys(voiceState)) if (k !== "pool") names.add(k);
  for (const k of clientStats.keys()) names.add(k);
  return [...names].sort();
}

/** Pool voice ids (for /speak "voice" validation). */
function knownVoiceIds() {
  const pool = Array.isArray(voiceState.pool) ? voiceState.pool : null;
  if (!pool) return [];
  return pool.filter((p) => typeof p?.model === "string").map((p) => p.id).filter(Boolean);
}
//#endregion

//#region registry — bounded per-client stats + event ring
const CLIENT_MAX = 64;
const evictedTotals = { spoken: 0, dropped: 0, errors: 0 };
const clientStats = new Map(); // key → {spoken, dropped, errors, lastSpokeAt}

function clientStat(key) {
  if (!key) return null;
  const k = String(key).toLowerCase(); // one canonical key per client, whatever casing arrived
  if (clientStats.size >= CLIENT_MAX && !clientStats.has(k)) {
    // LRU-evict the oldest-touched entry, folding counters into the aggregate.
    const oldest = clientStats.keys().next().value;
    const s = clientStats.get(oldest);
    evictedTotals.spoken += s.spoken;
    evictedTotals.dropped += s.dropped;
    evictedTotals.errors += s.errors;
    clientStats.delete(oldest);
  }
  let s = clientStats.get(k);
  if (!s) {
    s = { spoken: 0, dropped: 0, errors: 0, lastSpokeAt: null };
    clientStats.set(k, s);
  }
  return s;
}

const RING_MAX = 50;
const ring = [];
function emit(kind, info = {}) {
  if (!cfg.ring) return;
  const { text, ...rest } = info;
  ring.push({ ts: Date.now(), kind, ...rest, ...(text !== undefined ? { head: String(text).slice(0, 120) } : {}) });
  if (ring.length > RING_MAX) ring.shift();
}
//#endregion

//#region clean — the same "no heavy lines" logic as the DSH plugin
function cleanInline(text) {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, (m) => {
      try {
        return new URL(m).host;
      } catch {
        return "";
      }
    });
}
export function speakableText(text, { maxChars = cfg.maxChars } = {}) {
  const lines = String(text ?? "").split("\n");
  const kept = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^\s{4,}\S/.test(line) || /^\s*[|]/.test(line) || /^\s*[-*]\s*\[[ x]\]/i.test(line)) continue;
    kept.push(cleanInline(line));
  }
  const out = kept.join(" ").replace(/\s+/g, " ").trim();
  if (out.length <= maxChars) return out;
  const cut = out.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (lastStop > maxChars * 0.5 ? cut.slice(0, lastStop + 1) : cut) + " …";
}
//#endregion

//#region providers
const PLAYER_ARGS = { "pw-play": [], "paplay": [], "ffplay": ["-nodisp", "-autoexit", "-loglevel", "quiet"], "afplay": [] };
const EXT = { "audio/wav": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/pcm": "pcm" };
let playerCache = null;

export async function findPlayer() {
  if (playerCache) return playerCache;
  const candidates = process.platform === "darwin" ? ["afplay"] : process.platform === "win32" ? [] : ["pw-play", "paplay", "ffplay"];
  for (const c of candidates) {
    try {
      await access(`/usr/bin/${c}`);
      playerCache = c;
      return c;
    } catch {}
  }
  return null;
}

export async function synthesize(text, signal, profile = null) {
  if (cfg.provider === "beep") return { mime: "audio/none", base64: "" };
  if (cfg.provider === "gemini") return await synthGemini(text, signal);
  if (cfg.provider === "openai") return await synthOpenai(text, signal);
  if (cfg.provider === "command") return await synthCommand(text, signal, profile);
  throw new Error(`unknown provider: ${cfg.provider}`);
}

async function synthGemini(text, signal) {
  const key = cfg.apiKey || process.env[cfg.apiKeyEnv] || "";
  if (!key) throw new Error(`no API key (set ${cfg.apiKeyEnv})`);
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model ?? "gemini-2.5-flash-preview-tts"}:generateContent`,
    {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice ?? "Kore" } } } },
      }),
    },
  );
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const b64 = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
  if (!b64) throw new Error("gemini: no audio in response");
  return { mime: "audio/pcm", base64: b64, pcmRate: 24000 };
}

async function synthOpenai(text, signal) {
  const key = cfg.apiKey || process.env[cfg.apiKeyEnv] || "";
  if (!key) throw new Error(`no API key (set ${cfg.apiKeyEnv})`);
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: cfg.model ?? "gpt-4o-mini-tts", voice: cfg.voice ?? "alloy", input: text, response_format: cfg.format ?? "mp3" }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { mime: cfg.format === "wav" ? "audio/wav" : "audio/mpeg", base64: buf.toString("base64") };
}

async function synthCommand(text, signal, profile = null) {
  if (!cfg.command) throw new Error("SPEAKD_COMMAND not set");
  // Per-client voice profile (piper): swap in its model + pacing, and emit
  // real WAV to stdout (-f -) instead of headerless raw PCM — the buffered
  // path writes a file, and a headerless file plays at the wrong speed.
  let args;
  if (profile) {
    args = ["-m", profile.model, "-f", "-", "--length-scale", String(profile.lengthScale ?? 1.45), "--sentence-silence", "0.35"];
  } else {
    args = cfg.args.map((a) => a.replace("{text}", text));
    // Replace raw-PCM output with WAV-on-stdout so the file has a header.
    const rawIdx = args.indexOf("--output-raw");
    if (rawIdx !== -1) {
      args[rawIdx] = "-f";
      args.splice(rawIdx + 1, 0, "-");
    }
  }
  const isWav = profile !== null || args.includes("-f");
  return await new Promise((resolve, reject) => {
    const child = spawn(cfg.command, args, { signal, stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let size = 0;
    let err = "";
    child.stdout.on("data", (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) child.kill("SIGKILL");
      else chunks.push(c);
    });
    child.stderr.on("data", (c) => (err = (err + c.toString()).slice(-400)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (signal?.aborted) return reject(new Error("aborted"));
      if (code !== 0) return reject(new Error(`${cfg.command} exited ${code}${err ? `: ${err.trim()}` : ""}`));
      if (isWav) {
        resolve({ mime: "audio/wav", base64: Buffer.concat(chunks).toString("base64"), pcmRate: cfg.pcmRate });
      } else {
        const mime = cfg.mime === "audio/pcm" ? "audio/pcm" : cfg.mime;
        resolve({ mime, base64: Buffer.concat(chunks).toString("base64"), pcmRate: cfg.pcmRate });
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}
//#endregion

//#region playback — buffer path + streaming path, both stoppable and watchdogged
export function pcmToWavBase64(base64, rate = 24000, channels = 1, bits = 16) {
  const pcm = Buffer.from(base64, "base64");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE((rate * channels * bits) / 8, 28);
  header.writeUInt16LE(channels * (bits / 8), 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString("base64");
}

export function concatWav(parts) {
  const buffers = parts.map((p) => Buffer.from(p.base64, "base64"));
  const dataLen = buffers.reduce((n, b) => n + b.length - 44, 0);
  const rate = parts[0].pcmRate ?? 24000;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, ...buffers.map((b) => b.subarray(44))]).toString("base64");
}

export async function playOnHost(audio, signal, handle) {
  const player = await findPlayer();
  if (player === null) throw new Error("playback: no host player found");
  const dir = await mkdtemp(join(tmpdir(), "speakd-"));
  let child;
  try {
    const file = join(dir, `s.${EXT[audio.mime] ?? "bin"}`);
    const buf = Buffer.from(audio.base64, "base64");
    await writeFile(file, buf);
    child = spawn(player, [...(PLAYER_ARGS[player] ?? []), file], { signal, stdio: "ignore" });
    if (handle) handle.play = child;
    // Duration cap: expected audio length × 1.5 + 5 s, then SIGKILL.
    const seconds = audio.mime === "audio/pcm" || audio.mime === "audio/wav" ? (buf.length - 44) / ((audio.pcmRate ?? cfg.pcmRate) * 2) : 30;
    const cap = setTimeout(() => child.kill("SIGKILL"), Math.max(10, seconds * 1.5 + 5) * 1000);
    cap.unref?.();
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(cap);
        (code === 0 || signal?.aborted || handle?.cancelled ? resolve() : reject(new Error(`${player} exited ${code}`)));
      });
    });
  } finally {
    child?.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Stream a command provider's raw stdout straight into the player — no full
 * audio buffer in RAM. `handle` receives the child processes (so /stop can
 * kill them) and is checked for cancellation. Returns false when the
 * pipeline is not usable or fails; the caller falls back / marks error.
 */
export async function streamCommandToPlayer(signal, profile, handle) {
  if (process.platform === "win32") return false;
  const player = await findPlayer();
  if (player !== "pw-play" && player !== "paplay") return false;
  const isPcm = cfg.mime === "audio/pcm";
  if (!isPcm && cfg.mime !== "audio/wav") return false;
  if (player === "paplay" && isPcm) return false;
  if (profile && cfg.provider !== "command") return false;
  const baseArgs = profile
    ? ["-m", profile.model, "--output-raw", "--length-scale", String(profile.lengthScale ?? 1.45), "--sentence-silence", "0.35"]
    : cfg.args;
  // NOTE: this machine's pw-play has no --raw flag; raw-PCM stdin is the
  // default when reading from "-" with explicit format options.
  const args = isPcm ? ["-", "--rate", String(cfg.pcmRate), "--channels", "1", "--format", "s16"] : ["-"];

  return await new Promise((resolve) => {
    const gen = spawn(cfg.command, baseArgs, { stdio: ["pipe", "pipe", "ignore"] });
    const play = spawn(player, args, { stdio: ["pipe", "ignore", "ignore"], signal });
    if (handle) {
      handle.piper = gen;
      handle.play = play;
      if (handle.cancelled) {
        gen.kill("SIGKILL");
        play.kill("SIGKILL");
        resolve(false);
        return;
      }
    }
    let ok = true;
    let playDone = false;
    let genDone = false;
    let bytes = 0;
    // Progress watchdog: piper must emit audio at least every 15 s, and not
    // run longer than 120 s total; pw-play must finish within expected
    // duration × 1.5 + 5 s after synthesis ends.
    let stall = setTimeout(() => finish(false, "piper stall"), 15000);
    stall.unref?.();
    const total = setTimeout(() => finish(false, "piper overran 120 s"), 120000);
    total.unref?.();
    let playCap = null;

    const maybe = () => {
      if (playDone && genDone) resolve(ok && !signal?.aborted && !handle?.cancelled);
    };
    const finish = (good, why) => {
      ok = good;
      if (why) console.error(`speakd: ${why}; killing pipeline`);
      clearTimeout(stall);
      clearTimeout(total);
      clearTimeout(playCap);
      gen.kill("SIGKILL");
      play.kill("SIGKILL");
    };
    play.on("close", (code) => {
      playDone = true;
      clearTimeout(playCap);
      if (code !== 0 && !signal?.aborted && !handle?.cancelled) ok = false;
      maybe();
    });
    gen.on("error", () => (ok = false));
    play.on("error", () => (ok = false));
    gen.stdout.on("data", (c) => {
      bytes += c.length;
      clearTimeout(stall);
      stall = setTimeout(() => finish(false, "piper stall"), 15000);
      stall.unref?.();
    });
    gen.stdout.pipe(play.stdin);
    gen.on("close", (code) => {
      genDone = true;
      clearTimeout(stall);
      clearTimeout(total);
      if (code !== 0 && !signal?.aborted && !handle?.cancelled) {
        ok = false;
        play.kill("SIGKILL");
      } else {
        // Expected duration from the PCM we pushed; cap pw-play accordingly.
        const expected = bytes / (cfg.pcmRate * 2);
        playCap = setTimeout(() => finish(false, "playback overrun"), Math.max(10, expected * 1.5 + 5) * 1000);
        playCap.unref?.();
      }
      maybe();
    });
    gen.stdin.on("error", () => {});
    gen.stdin.end("");
  });
}
//#endregion

//#region queue — serial, drop-oldest, burst gap, stop/clear with generation guard
const queue = [];
let running = false;
let current = null; // {id, client, via, voice, chars, text?, since, cancelled, piper, play}
let generation = 0;
let jobId = 0;
let warned = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function enqueue(text, meta = {}) {
  const id = ++jobId;
  let dropped = 0;
  while (queue.length >= cfg.queueLimit) {
    const j = queue.shift();
    dropped += 1;
    const cs = clientStat(j.client); if (cs) cs.dropped += 1;
    evictedTotals.dropped++;
    emit("dropped", { id: j.id, client: j.client, voice: j.voice?.id, chars: j.chars, reason: "queue full", text: j.text });
  }
  const job = { id, text, chars: text.length, ...meta };
  queue.push(job);
  emit("enqueued", { id, client: job.client, via: job.via, voice: job.voice?.id, chars: job.chars, text });
  if (!running) drain();
  return { id, depth: queue.length, dropped };
}

async function drain() {
  running = true;
  try {
    while (queue.length > 0) {
      const myGen = generation;
      const job = queue.shift();
      current = { ...job, since: Date.now(), cancelled: false };
      emit("started", { id: job.id, client: job.client, via: job.via, voice: job.voice?.id, chars: job.chars });
      try {
        // Always the buffered path: synthesize to memory, then play a real
        // file. (The stdin-pipe streaming path silently played nothing on
        // this machine's pw-play — it exits 0 on raw stdin it cannot parse.
        // Buffered audio for a 450-char message is only ~600 KB; audibility
        // beats that.)
        if (!current.cancelled) {
          const audio = await synthesize(job.text, undefined, job.voice ?? null);
          if (!current.cancelled && audio.mime !== "audio/none" && cfg.playback === "host") await playOnHost(audio, undefined, current);
        }
        if (current.cancelled) {
          const cs = clientStat(job.client); if (cs) cs.dropped += 1;
          emit("stopped", { id: job.id, client: job.client, chars: job.chars });
        } else {
          const s = clientStat(job.client);
          if (s) {
            s.spoken += 1;
            s.lastSpokeAt = Date.now();
          }
          emit("completed", { id: job.id, client: job.client, chars: job.chars });
        }
      } catch (error) {
        const cs = clientStat(job.client); if (cs) cs.errors += 1;
        if (warned < 5) {
          warned += 1;
          console.error(`speakd: ${error instanceof Error ? error.message : String(error)}`);
        }
        emit("error", { id: job.id, client: job.client, message: String(error?.message ?? error).slice(0, 120) });
      }
      current = null;
      if (generation !== myGen) continue; // stop/clear happened — restart loop on the fresh queue
      if (queue.length > 0 && cfg.minGapMs > 0) {
        await sleep(cfg.minGapMs);
        if (generation !== myGen) continue; // never speak a cleared item after the gap
      }
    }
  } finally {
    running = false;
  }
}

/** Kill the current utterance (if any) and flush the waiting queue. */
function stopEverything() {
  generation += 1;
  const stoppedCurrent = current ? { id: current.id, client: current.client, chars: current.chars } : null;
  if (current) {
    current.cancelled = true;
    current.piper?.kill("SIGKILL");
    current.play?.kill("SIGKILL");
  }
  let cleared = 0;
  while (queue.length > 0) {
    const j = queue.shift();
    cleared += 1;
    const cs = clientStat(j.client); if (cs) cs.dropped += 1;
    evictedTotals.dropped++;
    emit("dropped", { id: j.id, client: j.client, voice: j.voice?.id, chars: j.chars, reason: "stopped", text: j.text });
  }
  if (stoppedCurrent || cleared) emit("stop", { stoppedCurrent, cleared });
  return { stoppedCurrent, cleared };
}

/** Flush the waiting queue only; the current utterance keeps playing. */
function clearQueue() {
  const myGen = generation;
  let cleared = 0;
  while (queue.length > 0) {
    const j = queue.shift();
    cleared += 1;
    const cs = clientStat(j.client); if (cs) cs.dropped += 1;
    evictedTotals.dropped++;
    emit("dropped", { id: j.id, client: j.client, voice: j.voice?.id, chars: j.chars, reason: "cleared", text: j.text });
  }
  emit("clear", { cleared });
  return { cleared, stillSpeaking: current ? { id: current.id, client: current.client, chars: current.chars, sinceMs: Date.now() - current.since } : null };
}
//#endregion

//#region MCP — tools shared by stdio and streamable-HTTP
const MCP_TOOLS = [
  {
    name: "speak",
    description:
      "Speak a SHORT human summary aloud on this machine's speakers. SPEECH PROTOCOL: 1-4 spoken sentences, max ~2-3 sentences per call; conversational tone; no code, no URLs, no tables, no file paths, no step-by-step lists; numbers and names only when essential. The full technical response goes in the written reply. Code blocks, links and tables are stripped automatically. Use for short summaries, not raw code.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Short spoken summary: 1-4 conversational sentences. No code, no URLs, no lists." },
      },
      required: ["text"],
    },
  },
  {
    name: "status",
    description:
      "Speech gateway status: who is speaking now, how many are queued and from which client, and which voice each client uses. Compact by default; pass verbose:true only when debugging. Do not call casually.",
    inputSchema: { type: "object", properties: { verbose: { type: "boolean", description: "Full snapshot (larger)" } } },
  },
  ...(userProfile
    ? [
        {
          name: "user_context",
          description:
            "Who the user is: name, preferences, machine context, and how to speak to them. Call this once at a session start if you want to know who you are serving.",
          inputSchema: { type: "object", properties: {} },
        },
      ]
    : []),
];

function statusSnapshot() {
  const pool = Array.isArray(voiceState.pool) ? voiceState.pool : null;
  const perClient = {};
  for (const [k, s] of clientStats) perClient[k] = { ...s };
  return {
    ok: true,
    version: VERSION,
    uptimeMs: Date.now() - BOOT,
    speaking: current
      ? { id: current.id, client: current.client, via: current.via, voice: current.voice?.id ?? null, chars: current.chars, sinceMs: Date.now() - current.since }
      : null,
    draining: running && !current, // in the burst-gap pause between messages
    queueCount: queue.length,
    queue: queue.map((j) => ({ id: j.id, client: j.client ?? null, via: j.via, voice: j.voice?.id ?? null, chars: j.chars })),
    voices: pool
      ? pool.map((p) => ({ id: p.id, character: p.character ?? null, clients: p.clients ?? [], usage: p.usage ?? 0 }))
      : Object.keys(voiceState).filter((k) => k !== "pool").map((k) => ({ id: k, clients: [k] })),
    clients: perClient,
    knownClients: knownClients().length,
    totals: {
      spoken: Object.values(perClient).reduce((n, s) => n + s.spoken, 0) + evictedTotals.spoken,
      dropped: Object.values(perClient).reduce((n, s) => n + s.dropped, 0) + evictedTotals.dropped,
      errors: Object.values(perClient).reduce((n, s) => n + s.errors, 0) + evictedTotals.errors,
    },
    events: [...ring],
    config: {
      provider: cfg.provider,
      announce: cfg.announce,
      queueLimit: cfg.queueLimit,
      gapMs: cfg.minGapMs,
      maxChars: cfg.maxChars,
      playback: cfg.playback,
      player: playerCache,
    },
  };
}

function mcpStatusCompact() {
  const snap = statusSnapshot();
  return {
    speaking: snap.speaking ? `${snap.speaking.client ?? "unknown"} (${snap.speaking.voice ?? "default voice"}, ${snap.speaking.chars} chars)` : null,
    queueCount: snap.queueCount,
    queued: snap.queue.map((q) => `${q.client ?? "anonymous"}: ${q.chars} chars`).slice(0, 6),
    perClient: Object.fromEntries(Object.entries(snap.clients).map(([k, s]) => [k, `${s.spoken} spoken, ${s.errors} errors`])),
    recent: snap.events.slice(-3).map((e) => `${e.kind}${e.client ? ` (${e.client})` : ""}${e.head ? `: ${e.head}` : ""}`),
  };
}

async function handleRpc(msg, respond, clientName) {
  const { id, method, params } = msg ?? {};
  try {
    if (method === "initialize") {
      respond({ jsonrpc: "2.0", id, result: { protocolVersion: msg.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "speakd", version: VERSION } } });
    } else if (method === "tools/list") {
      respond({ jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } });
    } else if (method === "tools/call" && params?.name === "speak") {
      const raw = String(params.arguments?.text ?? "");
      const text = speakableText(raw);
      if (text.length < 2) throw new Error("nothing speakable in the text");
      const spoken = clientName && cfg.announce ? `${clientName} here. ${text}` : text;
      const voice = resolveVoice(clientName); // harness door: may claim a free voice
      const { id: qid, depth } = enqueue(spoken, { via: "mcp", client: clientName, voice });
      respond({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Speaking ${spoken.length} chars (queue depth ${depth}, job ${qid}).` }] } });
    } else if (method === "tools/call" && params?.name === "status") {
      const verbose = params.arguments?.verbose === true;
      const body = verbose ? statusSnapshot() : mcpStatusCompact();
      respond({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(body, null, verbose ? 1 : 0) }] } });
    } else if (method === "tools/call" && params?.name === "user_context") {
      respond({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...userProfile,
                  _usage:
                    "Keep spoken replies short (1-4 sentences). The user prefers spoken summaries first; put technical detail in writing. Address them by name when natural.",
                },
                null,
                1,
              ),
            },
          ],
        },
      });
    } else if (method === "ping") {
      respond({ jsonrpc: "2.0", id, result: {} });
    } else if (id !== undefined && id !== null) {
      respond({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method ?? "(none)"}` } });
    }
  } catch (error) {
    if (id !== undefined && id !== null) respond({ jsonrpc: "2.0", id, error: { code: -32000, message: String(error?.message ?? error).slice(0, 200) } });
  }
}
//#endregion

//#region HTTP mode
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req, res) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 512 * 1024) {
      req.destroy();
      return null;
    }
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    json(res, 400, { ok: false, error: "invalid JSON body" });
    return undefined;
  }
}

/**
 * Queue one cleaned utterance. Shared by /speak (all forms) and both MCP
 * transports. `voiceOverride` comes only from the manual /speak form and
 * never triggers assignment or persistence.
 */
function speakViaHttp(text, clientName, via, voiceOverride) {
  const cleaned = speakableText(text);
  if (cleaned.length < 2) return { error: "nothing speakable", status: 422 };
  const announce = clientName && cfg.announce;
  const spoken = announce ? `${clientName} here. ${cleaned}` : cleaned;
  const voice = voiceOverride !== undefined ? voiceOverride : resolveVoice(clientName);
  const { id, depth, dropped } = enqueue(spoken, { via, client: clientName, voice });
  return { id, depth, dropped, chars: spoken.length };
}

async function runHttp() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${cfg.host}`);
    if (cfg.token !== "" && req.headers.authorization !== `Bearer ${cfg.token}`) {
      json(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    const pathClient = (prefix) => {
      const raw = url.pathname.startsWith(prefix) && url.pathname.length > prefix.length ? decodeURIComponent(url.pathname.slice(prefix.length)).trim() : "";
      return raw.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || undefined;
    };

    (async () => {
      if (req.method === "GET" && url.pathname === "/health") {
        await findPlayer();
        json(res, 200, { ok: true, version: VERSION, provider: cfg.provider, playback: cfg.playback, player: playerCache, queue: queue.length, speaking: Boolean(current) });
        return;
      }
      if (req.method === "GET" && url.pathname === "/status") {
        json(res, 200, statusSnapshot());
        return;
      }
      if (req.method === "POST" && url.pathname === "/stop") {
        json(res, 200, { ok: true, ...stopEverything() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/queue/clear") {
        json(res, 200, { ok: true, ...clearQueue() });
        return;
      }
      if (req.method === "POST" && url.pathname.startsWith("/mcp")) {
        const clientName = url.pathname.startsWith("/mcp/") ? pathClient("/mcp/") : undefined;
        const body = await readBody(req, res);
        if (body === null) return;
        if (body === undefined) return; // response already sent (bad JSON)
        if ((body?.method ?? "").startsWith("notifications/")) {
          res.writeHead(202).end();
          return;
        }
        const headerName = String(req.headers["x-speakd-client"] ?? "") || String(req.headers["x-client-name"] ?? "") || "";
        res.writeHead(200, { "content-type": "application/json" });
        await handleRpc(body, (out) => res.end(JSON.stringify(out)), clientName || headerName || undefined);
        if (!res.writableEnded) res.end(JSON.stringify({ jsonrpc: "2.0", id: body?.id ?? null, result: {} }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/mcp") {
        json(res, 405, { ok: false, error: "stateless server: use POST" });
        return;
      }
      if (req.method === "POST" && (url.pathname === "/speak" || url.pathname.startsWith("/speak/"))) {
        const body = await readBody(req, res);
        if (body === null || body === undefined) return;
        const text = String(body.text ?? "");
        if (url.pathname === "/speak") {
          // Manual form: persona ("as") or forced voice ("voice") — strict,
          // side-effect-free, never assigns or persists a pool voice.
          const wantsAs = body.as !== undefined;
          const wantsVoice = body.voice !== undefined;
          if (wantsAs && wantsVoice) {
            json(res, 400, { ok: false, error: 'use either "as" (client persona) or "voice" (pool voice id), not both' });
            return;
          }
          if (wantsAs) {
            const key = String(body.as).toLowerCase();
            if (!knownClients().includes(key)) {
              json(res, 400, { ok: false, error: `unknown client "${body.as}"`, knownClients: knownClients() });
              return;
            }
            const v = resolveVoice(key, { allowAssign: false });
            if (!v) {
              json(res, 400, { ok: false, error: `client "${body.as}" has no voice assigned yet` });
              return;
            }
            const r = speakViaHttp(text, key, "manual", v);
            if (r.error) json(res, r.status, { ok: false, error: r.error });
            else json(res, 202, { ok: true, queued: true, ...r });
            return;
          }
          if (wantsVoice) {
            const vid = String(body.voice).toLowerCase();
            const pool = Array.isArray(voiceState.pool) ? voiceState.pool : null;
            const entry = pool?.find((p) => String(p.id ?? "").toLowerCase() === vid && typeof p.model === "string");
            if (!entry) {
              json(res, 400, { ok: false, error: `unknown voice id "${body.voice}"`, voiceIds: knownVoiceIds() });
              return;
            }
            const v = { id: entry.id, model: expandPath(entry.model), lengthScale: Number(entry.lengthScale ?? 1.45) };
            const r = speakViaHttp(text, undefined, "manual", v);
            if (r.error) json(res, r.status, { ok: false, error: r.error });
            else json(res, 202, { ok: true, queued: true, ...r });
            return;
          }
          const r = speakViaHttp(text, undefined, "manual", null);
          if (r.error) json(res, r.status, { ok: false, error: r.error });
          else json(res, 202, { ok: true, queued: true, ...r });
          return;
        }
        // Harness door: /speak/<client> — auto voice assignment allowed.
        const clientName = pathClient("/speak/");
        const r = speakViaHttp(text, clientName, "http", undefined);
        if (r.error) json(res, r.status, { ok: false, error: r.error });
        else json(res, 202, { ok: true, queued: true, ...r });
        return;
      }
      json(res, 404, { ok: false, error: "not found" });
    })().catch((e) => {
      if (!res.writableEnded) json(res, 500, { ok: false, error: String(e?.message ?? e).slice(0, 200) });
    });
  });
  server.listen(cfg.port, cfg.host, () => {
    console.error(`speakd: listening on http://${cfg.host}:${cfg.port} (v${VERSION}, provider=${cfg.provider}, playback=${cfg.playback})`);
  });
}
//#endregion

//#region MCP stdio mode
async function runMcp() {
  const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  for await (const line of createInterface({ input: process.stdin, terminal: false })) {
    if (line.trim() === "") continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    await handleRpc(msg, write, process.env.SPEAKD_CLIENT_NAME || undefined);
  }
}
//#endregion

await loadVoiceState();
if (process.argv[2] === "--mcp") await runMcp();
else await runHttp();
