# OpenJarvis — pocket terminal for OpenCode

Run **multiple OpenCode coding sessions from Telegram**, from anywhere. One bot, one group with a topic per session: prompts, live tool output, Approve/Deny permission dialogs, model switching, voice notes in and spoken answers out, photo input, and a morning digest. Built for people who keep a 24/7 machine and juggle several projects at once — including local-model setups.

```
iPhone Telegram ⇄ Telegram Cloud ⇄ OpenJarvis (your PC, outbound polling only)
                                        ⇄ opencode serve on 127.0.0.1:4096
```

No port forwarding, no tunnel, no screen-sharing. The bot polls Telegram outbound, so it works behind NAT and survives reboots via systemd.

> Originated as a hard fork of
> [zPeppOz/opencode-telegram-bot](https://github.com/zPeppOz/opencode-telegram-bot)
> (base commit `855dde6`), rebuilt around multi-project topic workflows,
> reliable delivery, voice, and approvals. See [Credits](#credits).

## Who this is for

- You run OpenCode on a machine that's always on (homelab, workstation, VPS).
- You run **several sessions in parallel** across projects and want each as its own chat thread.
- You use local models (Ollama etc.) or hosted ones — the bot doesn't care, it talks to `opencode serve`.
- You want approvals on your phone instead of babysitting terminals.

## Features

- **Controller + topics workflow.** One group is the controller (`/project`, `/sessions`, `/new`, `/status`); every session gets its **own forum topic** with history, prompts, and replies threaded in place.
- **Multi-project picker.** `/project` lists your project folders, creates new ones by name (`/project my-thing`), and `/sessions` scopes to the active project (`/sessions all`, `/recent` across everything).
- **Live streaming.** Tool calls stream into the Thinking message as they run; outputs render as tap-to-expand quotes, like the terminal's collapsible sections.
- **Phone approvals.** Sessions created from Telegram run in ask-mode (bash/edit/write): every side effect arrives as an **Approve/Deny** dialog in the session's topic. Question-tool prompts arrive as tappable option dialogs.
- **Reliable delivery.** Prompt queueing (no abort-and-resend), reply attribution per prompt, restart-resume journal, late delivery instead of silent loss, heartbeat liveness on long runs.
- **Voice duplex.** Send voice notes (transcribed locally with faster-whisper, up to 10 min); tap **🔊 Talk back** for a spoken reply (local Piper TTS). Nothing voice ever touches a cloud.
- **Photo & file input.** Snap an error screen or send a document — the agent receives it by path.
- **Morning digest.** Weekday 07:00 push: overnight activity, sessions touched, what needs attention.
- **Lock-screen friendly.** Completion receipts read `Session — done in 34s` + project, never emoji-only.
- **Hardened by default.** Owner/PIN auth, rate limits, localhost-only server, no open ports, secrets stay in `chmod 600` files.

## Quick start

Prerequisites: Node.js 20+, OpenCode installed, a Telegram account.

**1. Create the bot.** Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token. Message [@userinfobot](https://t.me/userinfobot) → copy your numeric user ID.

**2. Install & configure.**

```bash
git clone https://github.com/<you>/OpenJarvis
cd OpenJarvis
npm install
cp .env.example .env
# edit .env: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS=<your id>, AUTH_PIN, OPENCODE_DEFAULT_DIR
chmod 600 .env
npm run build
```

**3. Enable groups (for the controller workflow).** In [@BotFather](https://t.me/BotFather): `/setprivacy` → your bot → **Disable** (so it reads group messages). Create a group, add the bot, make it admin (Post Messages + Manage Topics), then enable **Topics** in group settings.

**4. Run 24/7.**

```bash
# opencode serve (headless, localhost only)
opencode serve --port 4096 --hostname 127.0.0.1
# the bot (second terminal, or see systemd/ below)
npm start
```

Tap `/start` in the bot chat → `/auth <PIN>` → `/sessions` → pick one → chat.

**systemd (recommended):** see `systemd/` for user units (`openjarvis-serve`, `openjarvis-bot`, digest timer). Enable linger so they survive logout: `loginctl enable-linger $USER`.

## Voice setup (optional, all local)

```bash
python3 -m venv .venv-whisper
.venv-whisper/bin/pip install "faster-whisper" "av<14" piper-tts
# whisper model auto-downloads on first note (base ~150MB)
# TTS voice, e.g.:
mkdir -p .data/piper && cd .data/piper
curl -sL -o en_US-lessac-medium.onnx \
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx"
curl -sL -o en_US-lessac-medium.onnx.json \
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json"
```

Set `WHISPER_PYTHON` to the venv python in `.env`. Tune with `WHISPER_MODEL` (tiny/base/small), `TTS_MODEL`, `VOICE_MAX_SEC`.

## Commands

| Command | What it does |
|---|---|
| `/new` | Create a session in the active project (own topic in groups) |
| `/sessions` | This project's sessions (`/sessions all` for everything) |
| `/recent` | Last 8 touched sessions across all projects |
| `/project` | Switch/create project folder |
| `/models`, `/agent` | Switch model / agent |
| `/status` | Session, directory, tokens, cost, queue |
| `/history [N]` | Last exchanges, newest last (default 6) |
| `/continue`, `/undo` | Keep going / revert last reply's file changes |
| `/abort` | Stop the running generation (+ clears queue) |
| `/compact`, `/fork`, `/share`, `/stats` | As in OpenCode |
| `/auth`, `/whoami`, `/grant`, `/revoke` | Access control (owner-only grants) |

Plain text = prompt to the active session (or the topic's session). Voice notes, photos, and documents work the same way.

## Configuration

All in `.env` (see `.env.example`): bot token, allowlist, PIN, server URL, projects root, default model for fresh sessions, stream throttles, voice/STT/TTS settings, digest chat.

## Security model

- Allowlist + PIN (5 tries / 15-min lockout) + 30 req/min rate limit.
- Server binds `127.0.0.1`; bot polls outbound — **no inbound ports**.
- Telegram's Bot API necessarily sees message plaintext: **never paste passwords, API keys, or secrets** into the bot.
- Private groups only; Group Privacy OFF is required for group mode (the bot then reads group messages by design).
- `npm audit` clean; dependencies are grammY + dotenv + eventsource-parser only.

## Troubleshooting (earned the hard way)

- **`SESSIONS list looks empty / sessions "missing".`** The serve list endpoint only returns the daemon's current-project subset. The bot unions per-directory listings — if you query the API directly, always pass `?directory=`.
- **New sessions land in the wrong folder.** The daemon ignores the create-time directory; the bot records the intended project itself and anchors the agent there. Always create via `/new`, not raw API calls.
- **No permission dialogs on old sessions.** Ask-rules apply at creation; pre-existing sessions stay auto-allow. Use `/new` where you want approvals.
- **Buttons fail with `BUTTON_DATA_INVALID`.** Telegram caps `callback_data` at 64 bytes — ids must be tokenized, never embedded raw.
- **Telegram API flakiness.** Retries with backoff are everywhere; if the network to Telegram flaps, runs slow down but don't lose answers.
- **A run wedged on a tool (e.g. `read /`).** Stall notes name the stuck tool; `/abort` releases the session.

## Development

```bash
npm run build      # tsc + copy transcribe.py
npm run typecheck
npm test           # unit suite (tsx --test)
```

E2E scripts in `scripts/` (`e2e-serve`, `e2e-runprompt`, `e2e-ask`, `e2e-askq`) run against a live daemon on scratch sessions only. Contributions welcome: open an issue first for anything behavioral, PRs with tests preferred.

## Roadmap

- Per-group isolation (same bot, several groups, zero cross-talk)
- Scheduled prompts ("weekday 8am: triage inbox")
- Cross-session memory (`MEMORY.md` pattern)
- Read-only PC stats on demand (CPU/GPU/disk, service health)

## Credits

- Base: [zPeppOz/opencode-telegram-bot](https://github.com/zPeppOz/opencode-telegram-bot) — session management, streaming, topics, permission scaffolding.
- OpenJarvis work: multi-project controller/topics flow, ask-mode creation, reliable delivery (queue, attribution, journal, late-watch), voice duplex + cleanup, photo/doc input, morning digest, union listing, hardening, tests.

## License

MIT — see [LICENSE-MIT](LICENSE-MIT). The upstream README likewise states MIT.
