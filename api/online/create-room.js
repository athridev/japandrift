const {
  cleanCar,
  cleanName,
  freshPlayerDoc,
  freshRoom,
  generateRoomCode,
  getRoom,
  parseJsonBody,
  playerPath,
  putJson,
  saveRoom,
  sendJson,
  signPlayerToken,
  storageMode,
  verifyAccessKey,
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

  if (!verifyAccessKey(body.accessKey)) {
    return sendJson(response, 403, { error: "Invalid access key." });
  }

  try {
    let code = generateRoomCode();
    for (let tries = 0; tries < 8 && (await getRoom(code)); tries++) code = generateRoomCode();

    const room = freshRoom(code);
    const host = freshPlayerDoc("p1", body.name, body.car);
    await saveRoom(room);
    await putJson(playerPath(code, "p1"), host);

    return sendJson(response, 200, {
      ok: true,
      playerId: "p1",
      playerToken: signPlayerToken(code, "p1"),
      storage: storageMode(),
      room: {
        code: room.code,
        status: room.status,
        raceDurationMs: room.raceDurationMs,
        players: [
          { id: "p1", name: cleanName(body.name, "Host"), car: cleanCar(body.car), role: "host", connected: true, ready: false, score: 0, progress: 0 },
        ],
      },
    });
  } catch (error) {
    console.error("JAPAN_DRIFT_CREATE_ROOM_ERROR", error);
    return sendJson(response, 500, { error: "Could not create room.", detail: error.message });
  }
};
