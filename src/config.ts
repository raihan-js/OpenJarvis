import "dotenv/config";
import { join } from "node:path";

const requiredEnv = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env: ${key}`);
  return val;
};

function parseModel(raw: string): { providerID: string; modelID: string } {
  const i = raw.indexOf("/");
  if (i === -1) return { providerID: "opencode", modelID: raw };
  return { providerID: raw.slice(0, i), modelID: raw.slice(i + 1) };
}

export const config = {
  telegram: {
    token: requiredEnv("TELEGRAM_BOT_TOKEN"),
    allowedUsers: (process.env["TELEGRAM_ALLOWED_USERS"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number),
  },
  auth: {
    pin: process.env["AUTH_PIN"] ?? "",
    dataDir: process.env["AUTH_DATA_DIR"] ?? ".data",
  },
  opencode: {
    apiUrl: process.env["OPENCODE_API_URL"] ?? "http://127.0.0.1:4096",
    password: process.env["OPENCODE_SERVER_PASSWORD"] ?? "",
    defaultDir: process.env["OPENCODE_DEFAULT_DIR"] ?? process.env["HOME"] ?? "/tmp",
    autoStart: process.env["OPENCODE_AUTO_START"] !== "false",
    binPath: process.env["OPENCODE_BIN_PATH"] ?? "",
  },
  stream: {
    throttleMs: Number(process.env["STREAM_THROTTLE_MS"] ?? "800"),
    maxMessageLength: Number(process.env["MAX_MESSAGE_LENGTH"] ?? "4000"),
  },
  voice: {
    // faster-whisper model for Telegram voice notes (tiny/base/small).
    model: process.env["WHISPER_MODEL"] ?? "base",
    // Python with faster-whisper installed (venv recommended on Debian).
    python: process.env["WHISPER_PYTHON"] ?? "python3",
    // Piper TTS voice model for spoken replies (local, offline).
    ttsModel:
      process.env["TTS_MODEL"] ?? join(process.cwd(), ".data/piper/en_US-lessac-medium.onnx"),
    // Voice notes longer than this are rejected before download.
    maxDurationSec: Number(process.env["VOICE_MAX_SEC"] ?? "600"),
  },
  defaults: {
    // Model pinned onto FRESH sessions (no history yet): they inherit the
    // global default (anthropic) which stalls with no API key. Sessions with
    // history keep their own model. Overridable per user via /models.
    model: parseModel(
      process.env["OPENCODE_DEFAULT_MODEL"] ?? "opencode/muse-spark-1.3-contributor-free",
    ),
  },
  logLevel: (process.env["LOG_LEVEL"] ?? "info") as "debug" | "info" | "warn" | "error",
} as const;
