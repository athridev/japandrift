const {
  getJson,
  getRoom,
  getRoomWithRetry,
  hotGet,
  hotSet,
  normalizeRoomCode,
  parseJsonBody,
  playerHotKey,
  playerPath,
  putJson,
  saveRoom,
  sendJson,
  storageMode,
  verifyPlayerToken,
} = require("./_lib");

const HOT_FRESH_MS = 2500;
const STALE_PLAYER_MS = 15000;
const CONNECTED_WINDOW_MS = 6000;
const END_GRACE_MS = 5000;

const hotKey = playerHotKey;

// Read a player doc, preferring a very fresh in-instance copy (co-located
// polling) and falling back to Blob. Player docs are rewritten every poll, so
// a single lagged Blob read self-heals on the next poll.
async function loadPlayerDoc(code, playerId, { preferHot = true } = {}) {
  const hot = preferHot ? hotGet(hotKey(code, playerId)) : null;
  if (hot && Date.now() - hot.cachedAt < HOT_FRESH_MS) return hot.doc;
  const doc = await getJson(playerPath(code, playerId));
  if (doc) hotSet(hotKey(code, playerId), { doc, cachedAt: Date.now() });
  return doc;
}

function rosterEntry(doc, now) {
  return {
    id: doc.id,
    name: doc.name,
    car: doc.car,
    role: doc.role,
    ready: Boolean(doc.ready),
    connected: now - Number(doc.lastSeen || 0) < CONNECTED_WINDOW_MS,
    score: Number(doc.score || 0),
    progress: Number(doc.progress || 0),
    finishedAt: doc.finishedAt || null,
  };
}

function buildResult(docs, { forcedWinnerId = "", reason = "finish" } = {}) {
  const players = ["p1", "p2"]
    .filter((id) => docs[id])
    .map((id) => ({
      id,
      name: docs[id].name,
      car: docs[id].car,
      score: Number(docs[id].score || 0),
      progress: Number(docs[id].progress || 0),
      finishedAt: docs[id].finishedAt || null,
    }));
  players.sort((a, b) => (b.score - a.score) || (b.progress - a.progress));
  return { reason, winnerId: forcedWinnerId || players[0]?.id || null, players };
}

function publicView(room, docs, now) {
  const players = ["p1", "p2"].filter((id) => docs[id]).map((id) => rosterEntry(docs[id], now));
  return {
    code: room.code,
    status: room.status,
    raceDurationMs: room.raceDurationMs,
    countdownAt: room.countdownAt || 0,
    startedAt: room.startedAt || 0,
    endedAt: room.endedAt || 0,
    result: room.result || null,
    players,
  };
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: "Method not allowed." });
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return sendJson(response, error.status || 400, { error: error.message || "Invalid request." });
  }

  const code = normalizeRoomCode(body.code);
  const playerId = body.playerId === "p2" ? "p2" : "p1";

  // Stateless auth: no storage read, so propagation lag can never reject a
  // legitimate player.
  if (!verifyPlayerToken(body.playerToken, code, playerId)) {
    return sendJson(response, 403, { error: "Invalid player token.", gone: true });
  }

  try {
    const room = await getRoomWithRetry(code, 3, 400);
    if (!room) return sendJson(response, 404, { error: "Session not found or expired.", gone: true });

    const now = Date.now();
    const opponentId = playerId === "p1" ? "p2" : "p1";

    // --- Update my own doc (I am the single writer of this doc). ---
    const myDoc = (await loadPlayerDoc(code, playerId)) || {
      id: playerId,
      role: playerId === "p1" ? "host" : "guest",
      name: playerId === "p1" ? "Host" : "Challenger",
      car: "s15",
      joinedAt: now,
    };
    myDoc.lastSeen = now;
    if (body.name) myDoc.name = String(body.name).slice(0, 20);
    if (body.car) myDoc.car = String(body.car).slice(0, 12);
    if (body.ready === true) myDoc.ready = true;
    if (body.state && typeof body.state === "object") {
      myDoc.state = body.state;
      myDoc.stateAt = now;
    }
    if (typeof body.score === "number") myDoc.score = body.score;
    if (typeof body.progress === "number") myDoc.progress = body.progress;
    if (body.finish === true && !myDoc.finishedAt) myDoc.finishedAt = now;
    if (body.leave === true) myDoc.leftAt = now;
    hotSet(hotKey(code, playerId), { doc: myDoc, cachedAt: now });

    // --- Read opponent doc (memory fast path, else Blob). ---
    const opponentHot = hotGet(hotKey(code, opponentId));
    const opponentCoLocated = Boolean(opponentHot && now - opponentHot.cachedAt < HOT_FRESH_MS);
    const opponentDoc = opponentCoLocated
      ? opponentHot.doc
      : await loadPlayerDoc(code, opponentId, { preferHot: false });
    const hasOpponent = Boolean(opponentDoc);

    // Persist my doc. Lobby/finish/leave events persist immediately; during a
    // race, throttle when the opponent is co-located (already reads my hot copy).
    const mustPersist =
      body.ready === true || body.finish === true || body.leave === true || !myDoc.persistedAt;
    const persistEvery = opponentCoLocated ? 900 : 250;
    if (mustPersist || now - Number(myDoc.persistedAt || 0) >= persistEvery) {
      myDoc.persistedAt = now;
      await putJson(playerPath(code, playerId), myDoc);
    }

    const docs = { [playerId]: myDoc, [opponentId]: opponentDoc || null };
    let roomChanged = false;

    // --- Lobby -> countdown (host is the sole room writer). ---
    if (
      room.status === "lobby" &&
      playerId === "p1" &&
      hasOpponent &&
      myDoc.ready &&
      opponentDoc.ready
    ) {
      room.status = "countdown";
      room.countdownAt = now + 800;
      room.startedAt = now + 3800;
      roomChanged = true;
    }

    if (room.status === "countdown" && playerId === "p1" && now >= room.startedAt) {
      room.status = "racing";
      roomChanged = true;
    }

    // --- Race end. Host decides; guest may decide only when the host has
    // gone quiet, so both can never write the room doc at once. ---
    if (room.status === "racing" || room.status === "countdown") {
      const raceOver = room.startedAt && now > room.startedAt + room.raceDurationMs + END_GRACE_MS;
      const bothFinished = Boolean(myDoc.finishedAt && opponentDoc?.finishedAt);
      const opponentStale =
        room.status === "racing" &&
        hasOpponent &&
        (now - Number(opponentDoc.lastSeen || 0) > STALE_PLAYER_MS || opponentDoc.leftAt);
      const mayEnd = playerId === "p1" || (opponentId === "p1" && opponentStale);

      if (mayEnd && (bothFinished || raceOver || opponentStale)) {
        room.status = "ended";
        room.endedAt = now;
        room.result = opponentStale
          ? buildResult(docs, { forcedWinnerId: playerId, reason: "disconnect" })
          : buildResult(docs, { reason: raceOver && !bothFinished ? "timer" : "finish" });
        roomChanged = true;
      }
    }

    if (roomChanged) await saveRoom(room);

    const payload = {
      ok: true,
      serverTime: now,
      storage: storageMode(),
      room: publicView(room, docs, now),
    };
    if (opponentDoc?.state && opponentDoc.stateAt) {
      payload.opponent = { id: opponentId, state: opponentDoc.state, stateAt: opponentDoc.stateAt };
    }
    return sendJson(response, 200, payload);
  } catch (error) {
    console.error("JAPAN_DRIFT_SYNC_ERROR", error);
    return sendJson(response, 500, { error: "Sync failed.", detail: error.message });
  }
};
