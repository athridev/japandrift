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

function cleanName(name, fallback) {
  return String(name || fallback).trim().slice(0, 20) || fallback;
}

function cleanCar(car) {
  return String(car || "s15").slice(0, 12);
}

function freshRoom(code, hostName, hostCar) {
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
    players: [
      {
        id: "p1",
        role: "host",
        name: cleanName(hostName, "Host"),
        car: cleanCar(hostCar),
        token: crypto.randomUUID(),
      },
    ],
  };
}

function guestPlayer(name, car) {
  return {
    id: "p2",
    role: "guest",
    name: cleanName(name, "Challenger"),
    car: cleanCar(car),
    token: crypto.randomUUID(),
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

function findPlayer(room, playerId, token) {
  const player = room.players.find((item) => item.id === playerId);
  if (!player || !safeEqual(player.token, token)) return null;
  return player;
}

module.exports = {
  RACE_DURATION_MS,
  cleanCar,
  cleanName,
  deleteJson,
  findPlayer,
  freshRoom,
  generateRoomCode,
  getHeader,
  getJson,
  getRoom,
  getRoomWithRetry,
  guestPlayer,
  hotGet,
  hotSet,
  normalizeRoomCode,
  parseJsonBody,
  playerPath,
  putJson,
  roomPath,
  safeEqual,
  saveRoom,
  sendJson,
  storageMode,
  verifyAccessKey,
};
