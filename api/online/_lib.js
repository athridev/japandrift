const crypto = require("node:crypto");

// Room creation is gated by a shared access key instead of email OTP so the
// online mode has zero third-party dependencies (no Resend, no cookies).
const ACCESS_KEY = process.env.JAPANDRIFT_ACCESS_KEY || "fable5magic";
const ROOM_TTL_SECONDS = 60 * 60 * 3;
const RACE_DURATION_MS = 120000;
const MAX_JSON_BODY = 25000;
const ROOM_PREFIX = "japandrift-online/";

// In-instance hot cache. With Fluid compute both players usually poll the
// same warm instance, so opponent state is served from memory with no Blob
// read latency. Blob remains the source of truth across instances.
function hotStore() {
  if (!globalThis.__JD_HOT__) globalThis.__JD_HOT__ = new Map();
  return globalThis.__JD_HOT__;
}

function hotGet(key) {
  return hotStore().get(key) || null;
}

function hotSet(key, value) {
  const store = hotStore();
  store.set(key, value);
  if (store.size > 500) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
  return value;
}

function getHeader(request, name) {
  return request.headers?.[name] || request.headers?.[name.toLowerCase()] || "";
}

function sendJson(response, status, payload) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  return response.status(status).json(payload);
}

async function parseJsonBody(request) {
  const contentLength = Number(getHeader(request, "content-length") || 0);
  if (contentLength > MAX_JSON_BODY) {
    const error = new Error("Request body is too large.");
    error.status = 413;
    throw error;
  }
  const contentType = String(getHeader(request, "content-type"));
  if (!contentType.includes("application/json")) {
    const error = new Error("Send JSON.");
    error.status = 415;
    throw error;
  }
  if (typeof request.body === "string") return JSON.parse(request.body || "{}");
  return request.body || {};
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyAccessKey(key) {
  return safeEqual(String(key || "").trim(), ACCESS_KEY);
}

// --- Stateless player tokens -------------------------------------------
// Player identity is a signed token, NOT a value looked up in storage. This
// is the core reliability fix: a freshly joined guest can be verified by any
// instance with zero storage reads, so Blob propagation lag can never cause
// a spurious "invalid token" that kicks them out of the room.
const TOKEN_SECRET = process.env.JAPANDRIFT_SESSION_SECRET || "jd-fable5-online-v1";
const TOKEN_TTL_MS = 60 * 60 * 3 * 1000;

function base64url(value) {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signPlayerToken(code, playerId) {
  const payload = `${normalizeRoomCode(code)}.${playerId}.${Date.now() + TOKEN_TTL_MS}`;
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex").slice(0, 32);
  return `${base64url(payload)}.${sig}`;
}

function verifyPlayerToken(token, code, playerId) {
  const [encoded, sig] = String(token || "").split(".");
  if (!encoded || !sig) return false;
  let payload;
  try {
    payload = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return false;
  }
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex").slice(0, 32);
  if (!safeEqual(sig, expected)) return false;
  const [tokenCode, tokenPlayer, exp] = payload.split(".");
  if (tokenCode !== normalizeRoomCode(code) || tokenPlayer !== playerId) return false;
  if (Date.now() > Number(exp)) return false;
  return true;
}

function storageMode() {
  return process.env.BLOB_READ_WRITE_TOKEN ? "blob" : "memory";
}

function localStore() {
  if (!globalThis.__JAPAN_DRIFT_ONLINE_STORE__) {
    globalThis.__JAPAN_DRIFT_ONLINE_STORE__ = new Map();
  }
  return globalThis.__JAPAN_DRIFT_ONLINE_STORE__;
}

async function putJson(pathname, payload) {
  const body = JSON.stringify(payload);
  if (storageMode() === "memory") {
    localStore().set(pathname, body);
    return;
  }
  const { put } = await import("@vercel/blob");
  await put(pathname, body, {
    access: "private",
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
}

function blobStoreHost() {
  const token = String(process.env.BLOB_READ_WRITE_TOKEN || "");
  const match = token.match(/^vercel_blob_rw_([A-Za-z0-9]+)_/);
  return match ? `${match[1].toLowerCase()}.private.blob.vercel-storage.com` : null;
}

async function getJson(pathname) {
  if (storageMode() === "memory") {
    const raw = localStore().get(pathname);
    return raw ? JSON.parse(raw) : null;
  }
  // Read straight from the store origin with a unique query so the CDN can
  // never serve a cached (or negatively cached) copy. Freshness here is what
  // the whole sync protocol stands on.
  const host = blobStoreHost();
  if (host) {
    try {
      const bust = `${Date.now()}-${crypto.randomInt(1e9)}`;
      const response = await fetch(`https://${host}/${pathname}?nc=${bust}`, {
        headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
        cache: "no-store",
      });
      if (response.status === 404) return null;
      if (response.ok) return await response.json();
    } catch (error) {
      console.error("JDO_BLOB_DIRECT_READ_ERROR", error.message);
    }
  }
  const { get } = await import("@vercel/blob");
  const stored = await get(pathname, { access: "private" });
  if (stored?.statusCode !== 200 || !stored.stream) return null;
  return JSON.parse(await new Response(stored.stream).text());
}

async function deleteJson(pathname) {
  if (storageMode() === "memory") {
    localStore().delete(pathname);
    return;
  }
  const { del } = await import("@vercel/blob");
  await del(pathname);
}

function normalizeRoomCode(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(0, alphabet.length)];
  return code;
}

function roomPath(code) {
  return `${ROOM_PREFIX}rooms/${normalizeRoomCode(code)}.json`;
}

function playerPath(code, playerId) {
  return `${ROOM_PREFIX}rooms/${normalizeRoomCode(code)}-${playerId}.json`;
}

function playerHotKey(code, playerId) {
  return `hot:${normalizeRoomCode(code)}:${playerId}`;
}

// Write-through for player docs: hot cache first (visible instantly to any
// request on this instance), then Blob.
async function putPlayerDoc(code, playerId, doc) {
  hotSet(playerHotKey(code, playerId), { doc, cachedAt: Date.now() });
  await putJson(playerPath(code, playerId), doc);
}

// Freshest available copy: hot if recent, else Blob.
async function getPlayerDoc(code, playerId, hotWindowMs = 2500) {
  const hot = hotGet(playerHotKey(code, playerId));
  if (hot && Date.now() - hot.cachedAt < hotWindowMs) return hot.doc;
  const doc = await getJson(playerPath(code, playerId));
  if (doc) hotSet(playerHotKey(code, playerId), { doc, cachedAt: Date.now() });
  return doc || (hot ? hot.doc : null);
}

function cleanName(name, fallback) {
  return String(name || fallback).trim().slice(0, 20) || fallback;
}

function cleanCar(car) {
  return String(car || "s15").slice(0, 12);
}

// The room doc holds only host-controlled shared fields (status + timing).
// Player identity/roster lives in per-player docs, which each player rewrites
// every poll, so presence converges in one poll instead of waiting on this
// rarely-written doc to propagate.
function freshRoom(code) {
  const now = Date.now();
  return {
    code,
    status: "lobby",
    createdAt: now,
    expiresAt: now + ROOM_TTL_SECONDS * 1000,
    raceDurationMs: RACE_DURATION_MS,
    countdownAt: 0,
    startedAt: 0,
    endedAt: 0,
    result: null,
  };
}

function freshPlayerDoc(id, name, car) {
  return {
    id,
    role: id === "p1" ? "host" : "guest",
    name: cleanName(name, id === "p1" ? "Host" : "Challenger"),
    car: cleanCar(car),
    ready: false,
    lastSeen: Date.now(),
    joinedAt: Date.now(),
    score: 0,
    progress: 0,
  };
}

async function getRoom(code, { fresh = false } = {}) {
  const key = roomPath(code);
  // Serve the hot copy briefly, but only stamp readAt on REAL blob reads —
  // stamping on cache hits would let steady polling keep a stale room alive
  // forever. Callers pass fresh:true to force a blob read (e.g. before
  // rejecting a player token that might come from a just-joined guest).
  const hot = hotGet(key);
  if (!fresh && hot && Date.now() - hot.readAt < 1500) {
    if (Date.now() > hot.room.expiresAt) return null;
    return hot.room;
  }
  const room = await getJson(key);
  if (!room) return null;
  if (Date.now() > room.expiresAt) return null;
  // Never replace a newer local copy with an older blob read.
  if (hot && Number(hot.room.updatedAt || 0) > Number(room.updatedAt || 0)) {
    hotSet(key, { room: hot.room, readAt: Date.now() });
    return hot.room;
  }
  hotSet(key, { room, readAt: Date.now() });
  return room;
}

// Blob writes propagate asynchronously (measured 0.3-2s). A room that was
// just created can legitimately 404 on another instance, so callers that
// KNOW the room should exist retry briefly before giving up.
async function getRoomWithRetry(code, attempts = 4, delayMs = 600) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const room = await getRoom(code);
    if (room) return room;
    if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

async function saveRoom(room) {
  room.updatedAt = Date.now();
  hotSet(roomPath(room.code), { room, readAt: Date.now() });
  await putJson(roomPath(room.code), room);
}

module.exports = {
  RACE_DURATION_MS,
  cleanCar,
  cleanName,
  deleteJson,
  freshPlayerDoc,
  freshRoom,
  generateRoomCode,
  getHeader,
  getJson,
  getRoom,
  getRoomWithRetry,
  hotGet,
  hotSet,
  normalizeRoomCode,
  parseJsonBody,
  playerHotKey,
  playerPath,
  getPlayerDoc,
  putPlayerDoc,
  putJson,
  roomPath,
  safeEqual,
  saveRoom,
  sendJson,
  signPlayerToken,
  storageMode,
  verifyAccessKey,
  verifyPlayerToken,
};
