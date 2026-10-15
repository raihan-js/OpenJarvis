import { logger } from "../utils/logger.js";

/**
 * Download with long backoff. The route to api.telegram.org flaps for
 * minutes at a time here — 4 quick tries are not enough. ~8 attempts
 * span roughly 4 minutes before giving up.
 */
export async function downloadToBuffer(url: string, maxBytes = 25 * 1024 * 1024): Promise<Buffer> {
  const delays = [2000, 4000, 8000, 15000, 30000, 45000, 60000, 90000];
  let lastErr = "";
  for (let attempt = 1; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > maxBytes) throw new Error("file too large");
      if (attempt > 1) logger.info("Download recovered after retry", { attempt });
      return buf;
    } catch (err) {
      lastErr = String(err);
      logger.warn("Download failed, retrying", { attempt, error: lastErr });
      await new Promise((r) => setTimeout(r, delays[attempt - 1]!));
    }
  }
  throw new Error(`download failed after ${delays.length} tries: ${lastErr}`);
}
