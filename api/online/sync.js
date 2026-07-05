const {
  findPlayer,
  getJson,
  getRoom,
  getRoomWithRetry,
  hotGet,
  hotSet,
  normalizeRoomCode,
  parseJsonBody,
  playerPath,
  putJson,
  saveRoom,
  sendJson,
  storageMode,
} = require("./_lib");

const HOT_FRESH_MS = 2500;
const STALE_PLAYER_MS = 15000;
const CONNECTED_WINDOW_MS = 4500;
const END_GRACE_MS = 5000;

function hotKey(code, playerId) {
  return `hot:${normalizeRoomCode(code)}:${playerId}`;
}

async function loadPlayerDoc(code, playerId, { preferHot = true } = {}) {
  const hot = preferHot ? hotGet(hotKey(code, playerId)) : null;
  if (hot && Date.now() - hot.cachedAt < HOT_FRESH_MS) return hot.doc;
  const doc = (await getJson(playerPath(code, playerId))) || {};
  hotSet(hotKey(code, playerId), { doc, cachedAt: Date.now() });
  return doc;
}

function buildResult(room, docs, { forcedWinnerId = "", reason = "finish" } = {}) {
  const players = room.players.map((player) => {
    const doc = docs[player.id] || {};
    return {
      id: player.id,
      name: player.name,
      car: player.car,
      score: Number(doc.score || 0),
      progress: Number(doc.progress || 0),
      finishedAt: doc.finishedAt || null,
    };
  });
  players.sort((a, b) => (b.score - a.score) || (b.progress - a.progress));
  return {
    reason,
    winnerId: forcedWinnerId || players[0]?.id || null,
    players,
  };
}

function publicView(room, docs, now) {
  return {
    code: room.code,
    status: room.status,
    raceDurationMs: room.raceDurationMs,
    countdownAt: room.countdownAt || 0,
    startedAt: room.startedAt || 0,
    endedAt: room.endedAt || 0,
    result: room.result || null,
    players: room.players.map((player) => {
      const doc = docs[player.id] || {};
      return {
        id: player.id,
        name: player.name,
        car: player.car,
        role: player.role,
        ready: Boolean(doc.ready),
        connected: now - Number(doc.lastSeen || 0) < CONNECTED_WINDOW_MS,
        score: Number(doc.score || 0),
        progress: Number(doc.progress || 0),
        finishedAt: doc.finishedAt || null,
      };
    }),
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

  try {
    let room = await getRoomWithRetry(code, 2, 400);
    if (!room) return sendJson(response, 404, { error: "Session not found or expired.", gone: true });
    if (!findPlayer(room, playerId, body.playerToken)) {
      // The token may belong to a guest who joined milliseconds ago on
      // another instance; re-read the room from storage before rejecting.
      room = await getRoom(code, { fresh: true });
      if (!room || !findPlayer(room, playerId, body.playerToken)) {
        return sendJson(response, 403, { error: "Invalid player token.", gone: true });
      }
    }

    const now = Date.now();
    const opponentId = playerId === "p1" ? "p2" : "p1";
    const hasOpponent = room.players.some((player) => player.id === opponentId);

    // --- Update my doc (single writer per doc: no cross-player races). ---
    const myDoc = await loadPlayerDoc(code, playerId);
    myDoc.lastSeen = now;
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

    // --- Read opponent (memory fast path; Blob when not co-located). ---
    const opponentHot = hasOpponent ? hotGet(hotKey(code, opponentId)) : null;
    const opponentCoLocated = Boolean(opponentHot && now - opponentHot.cachedAt < HOT_FRESH_MS);
    const opponentDoc = hasOpponent
      ? opponentCoLocated
        ? opponentHot.doc
        : await loadPlayerDoc(code, opponentId, { preferHot: false })
      : null;

    // Persist my doc to Blob. When the opponent polls this same instance the
    // hot copy is already authoritative, so throttle Blob writes; lobby
    // events (ready/finish/leave) always persist immediately.
    const mustPersist =
      body.ready === true || body.finish === true || body.leave === true || !myDoc.persistedAt;
    const persistEvery = opponentCoLocated ? 1200 : 250;
    if (mustPersist || now - Number(myDoc.persistedAt || 0) >= persistEvery) {
      myDoc.persistedAt = now;
      await putJson(playerPath(code, playerId), myDoc);
    }

    const docs = { [playerId]: myDoc, [opponentId]: opponentDoc || {} };
    let roomChanged = false;

    // --- Lobby -> countdown: host observes both ready flags. Ready flags
    // are monotonic, so a delayed Blob read only postpones this, never
    // corrupts it. ---
    if (
      room.status === "lobby" &&
      playerId === "p1" &&
      hasOpponent &&
      myDoc.ready &&
      opponentDoc?.ready
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

    // --- Race end. The host decides; the guest may decide only when the
    // host has gone quiet, so the two can never both write the room doc in
    // the same window. ---
    if (room.status === "racing" || room.status === "countdown") {
      const raceOver = room.startedAt && now > room.startedAt + room.raceDurationMs + END_GRACE_MS;
      const bothFinished = Boolean(myDoc.finishedAt && opponentDoc?.finishedAt);
      const opponentStale =
        room.status === "racing" &&
        hasOpponent &&
        (now - Number(opponentDoc?.lastSeen || 0) > STALE_PLAYER_MS || opponentDoc?.leftAt);
      const opponentIsHost = opponentId === "p1";
      const mayEnd = playerId === "p1" || (opponentIsHost && opponentStale);

      if (mayEnd && (bothFinished || raceOver || opponentStale)) {
        room.status = "ended";
        room.endedAt = now;
        room.result = opponentStale
          ? buildResult(room, docs, { forcedWinnerId: playerId, reason: "disconnect" })
          : buildResult(room, docs, { reason: raceOver && !bothFinished ? "timer" : "finish" });
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
