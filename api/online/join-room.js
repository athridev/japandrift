const {
  getJson,
  getRoomWithRetry,
  guestPlayer,
  normalizeRoomCode,
  parseJsonBody,
  playerPath,
  putJson,
  saveRoom,
  sendJson,
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

    const existingGuest = room.players.find((player) => player.id === "p2");
    if (existingGuest) {
      // Allow reclaiming the guest slot only if the previous guest went quiet
      // (closed tab, dropped connection). An active guest keeps the seat.
      const guestDoc = (await getJson(playerPath(code, "p2"))) || {};
      const quietForMs = Date.now() - Number(guestDoc.lastSeen || 0);
      if (quietForMs < 8000) {
        return sendJson(response, 409, { error: "This 1v1 room is full." });
      }
      room.players = room.players.filter((player) => player.id !== "p2");
    }

    const guest = guestPlayer(body.name, body.car);
    room.players.push(guest);
    await saveRoom(room);
    await putJson(playerPath(code, "p2"), { lastSeen: Date.now() });

    const host = room.players.find((player) => player.id === "p1");
    return sendJson(response, 200, {
      ok: true,
      playerId: "p2",
      playerToken: guest.token,
      storage: storageMode(),
      room: {
        code: room.code,
        status: room.status,
        raceDurationMs: room.raceDurationMs,
        players: [
          { id: "p1", name: host?.name || "Host", car: host?.car || "s15", role: "host", connected: true, ready: false, score: 0, progress: 0 },
          { id: "p2", name: guest.name, car: guest.car, role: "guest", connected: true, ready: false, score: 0, progress: 0 },
        ],
      },
    });
  } catch (error) {
    console.error("JAPAN_DRIFT_JOIN_ROOM_ERROR", error);
    return sendJson(response, 500, { error: "Could not join room.", detail: error.message });
  }
};
