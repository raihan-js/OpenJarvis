import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

/** One-shot talk-back arms: voice replies go out only when armed by tap. */
const armedTalkBack = new Set<string>();

export function armTalkBack(chatId: number, sessionId: string): void {
  armedTalkBack.add(`${chatId}:${sessionId}`);
}

export function takeTalkBackArm(chatId: number, sessionId: string): boolean {
  const key = `${chatId}:${sessionId}`;
  if (!armedTalkBack.has(key)) return false;
  armedTalkBack.delete(key);
  return true;
}

/** Synthesize speech locally (Piper, offline) → Opus OGG buffer for Telegram voice. */
export async function synthesizeVoice(text: string): Promise<Buffer | null> {
  const clean = text
    .replace(/[*_`#>\[\]()|~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  if (!clean) return null;

  const tag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const wav = join(tmpdir(), `tg-tts-${tag}.wav`);
  const ogg = join(tmpdir(), `tg-tts-${tag}.ogg`);
  try {
    // Piper reads text from stdin — no shell involved.
    await new Promise<void>((resolve, reject) => {
      const p = spawn(
        config.voice.python,
        ["-m", "piper", "--model", config.voice.ttsModel, "--output_file", wav],
        { timeout: 90_000 },
      );
      let err = "";
      p.stderr.on("data", (d) => {
        err += d.toString();
      });
      p.on("error", reject);
      p.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`piper exit ${code}: ${err.slice(0, 200)}`)),
      );
      p.stdin.write(clean);
      p.stdin.end();
    });
    await execFileAsync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-i", wav, "-c:a", "libopus", ogg],
      { timeout: 60_000 },
    );
    const audio = readFileSync(ogg);
    if (audio.byteLength > 2 * 1024 * 1024) {
      logger.warn("TTS output too large, skipping voice reply", { bytes: audio.byteLength });
      return null;
    }
    return audio;
  } catch (err) {
    logger.warn("TTS synthesis failed", { error: String(err) });
    return null;
  } finally {
    try {
      unlinkSync(wav);
    } catch {
      // gone
    }
    try {
      unlinkSync(ogg);
    } catch {
      // gone
    }
  }
}
