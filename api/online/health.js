const crypto = require("node:crypto");
const { getJson, putJson, deleteJson, sendJson, storageMode } = require("./_lib");

// Exercises the OVERWRITE path on a fixed pathname — the case the CDN can
// serve stale — and reports what the direct store read actually does.
async function overwriteProbe() {
  const pathname = "japandrift-online/health/overwrite-probe.json";
  const value = crypto.randomUUID();
  await putJson(pathname, { value });
  await new Promise((r) => setTimeout(r, 150));
  const read = await getJson(pathname);
  const token = String(process.env.BLOB_READ_WRITE_TOKEN || "");
  const match = token.match(/^vercel_blob_rw_([A-Za-z0-9]+)_/);
  let direct = { attempted: false };
  if (match) {
    try {
      const response = await fetch(
        `https://${match[1].toLowerCase()}.private.blob.vercel-storage.com/${pathname}?nc=${Date.now()}`,
        { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
      );
      const body = response.ok ? await response.json() : null;
      direct = { attempted: true, status: response.status, fresh: body?.value === value };
    } catch (error) {
      direct = { attempted: true, error: error.message };
    }
  }
  return { overwriteFresh: read?.value === value, direct };
}

// Verifies the storage backbone from inside the deployment. Vercel Blob is
// eventually consistent, so the probe measures how long a fresh write takes
// to become readable. The sync protocol is monotonic and tolerates this lag;
// `consistent` means the write became visible within the poll budget.
module.exports = async function handler(request, response) {
  const id = crypto.randomUUID();
  const pathname = `japandrift-online/health/probe-${id}.json`;

  try {
    const writeStart = Date.now();
    await putJson(pathname, { value: id });
    const writeMs = Date.now() - writeStart;

    let visibleAfterMs = -1;
    const pollStart = Date.now();
    for (let attempt = 0; attempt < 12; attempt++) {
      const read = await getJson(pathname);
      if (read?.value === id) {
        visibleAfterMs = Date.now() - pollStart;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    await deleteJson(pathname).catch(() => null);

    const overwrite = storageMode() === "blob" ? await overwriteProbe() : null;

    return sendJson(response, 200, {
      ok: true,
      storage: storageMode(),
      consistent: visibleAfterMs >= 0,
      writeMs,
      visibleAfterMs,
      overwrite,
    });
  } catch (error) {
    console.error("JAPAN_DRIFT_HEALTH_ERROR", error);
    return sendJson(response, 500, { ok: false, storage: storageMode(), error: error.message });
  }
};
