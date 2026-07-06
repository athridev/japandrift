const {
  cleanCar,
  cleanName,
  freshPlayerDoc,
  getPlayerDoc,
  getRoomWithRetry,
  normalizeRoomCode,
  parseJsonBody,
  putPlayerDoc,
  sendJson,
  signPlayerToken,
  storageMode,
} = require("./_lib");

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
  if (!code) return sendJson(response, 400, { error: "Enter a session code." });

  try {
    const room = await getRoomWithRetry(code);
    if (!room || room.status === "ended") return sendJson(response, 404, { error: "Session not found." });
    if (room.status !== "lobby") return sendJson(response, 409, { error: "This race already started." });

    // The guest slot is taken only if a guest doc exists AND is still active.
    // A quiet slot (closed tab) can be reclaimed.
    const existing = await getPlayerDoc(code, "p2");
    if (existing && Date.now() - Number(existing.lastSeen || 0) < 8000) {
      return sendJson(response, 409, { error: "This 1v1 room is full." });
    }

    const guest = freshPlayerDoc("p2", body.name, body.car);
    await putPlayerDoc(code, "p2", guest);
    const host = await getPlayerDoc(code, "p1");

    return sendJson(response, 200, {
      ok: true,
      playerId: "p2",
      playerToken: signPlayerToken(code, "p2"),
      storage: storageMode(),
      room: {
        code: room.code,
        status: room.status,
        raceDurationMs: room.raceDurationMs,
        players: [
          { id: "p1", name: host?.name || "Host", car: host?.car || "s15", role: "host", connected: true, ready: false, score: 0, progress: 0 },
          { id: "p2", name: cleanName(body.name, "Challenger"), car: cleanCar(body.car), role: "guest", connected: true, ready: false, score: 0, progress: 0 },
        ],
      },
    });
  } catch (error) {
    console.error("JAPAN_DRIFT_JOIN_ROOM_ERROR", error);
    return sendJson(response, 500, { error: "Could not join room.", detail: error.message });
  }
};
