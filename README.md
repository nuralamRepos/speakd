# speakd — universal speak gateway for CLI agents

One tiny local server that **any** agent can call to speak its replies aloud:
Claude Code, Codex, opencode, DSH, Gemini CLI, your own scripts — anything
that can make an HTTP POST or run a command. The provider, key and voice are
configured **once**, in one place.

- **Zero dependencies** — plain Node ≥ 18, a single ~330-line file.
- **Loopback only** — binds `127.0.0.1`, never exposed to the network.
- **Cloud synthesis, local playback** — fits low-RAM machines (no local TTS model).
- **Two universal doors**: an HTTP endpoint and an MCP stdio tool.

## Run it

```bash
GEMINI_API_KEY=your-key node speakd.mjs
# or: OPENAI_API_KEY=sk-... SPEAKD_PROVIDER=openai node speakd.mjs
# local engine: SPEAKD_PROVIDER=command SPEAKD_COMMAND=piper SPEAKD_ARGS='[--model,en_US-amy-medium.onnx]' node speakd.mjs
```

Keep it alive with your session/service manager, e.g.:

```bash
# ~/.config/systemd/user/speakd.service
[Service]
Environment=GEMINI_API_KEY=your-key
ExecStart=/usr/bin/node %h/speak-gateway/speakd.mjs
Restart=on-failure
[Install]
WantedBy=default.target
# then: systemctl --user enable --now speakd
```

## Door 1 — HTTP (for hooks and scripts)

```bash
curl -s http://127.0.0.1:8777/health
# {"ok":true,"provider":"gemini","playback":"host","player":"pw-play","queue":0}

curl -s -X POST http://127.0.0.1:8777/speak \
  -H 'content-type: application/json' \
  -d '{"text":"Build finished. All 42 tests passed."}'
# {"ok":true,"queued":true,"chars":38,"depth":1}
```

Optional: set `SPEAKD_TOKEN=secret` and send `-H 'Authorization: Bearer secret'`.

## Door 2 — MCP (for agents that speak tools)

`speakd.mjs --mcp` is a stdio **MCP server** with one `speak` tool. Any MCP
client (Claude Code, opencode, DSH's mcp-client rows, …) registers it once:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/speakd.mjs", "--mcp"],
  "env": { "GEMINI_API_KEY": "your-key" }
}
```

The agent then calls `speak` on demand: *"summarize that out loud"*.

## Wire auto-speak into CLI agents (hooks)

**Claude Code** (`~/.claude/settings.json`) — speak a short line on Stop:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "curl -s -X POST http://127.0.0.1:8777/speak -H 'content-type: application/json' -d '{\"text\":\"Claude Code finished the turn.\"}'" }] }]
  }
}
```

**Codex / opencode / anything else**: the same one-line `curl` as their
"task finished" / notification hook.

**DSH**: the `dsh-tts-announce` plugin pairs with this — point its
`command` provider at `curl` (below), or keep its direct Gemini/OpenAI mode.

## dsh-tts-announce ⇄ speakd

Two ways to combine:

1. **Independent** — plugin speaks finished replies; other agents use speakd.
2. **Gateway mode** — the plugin stops holding keys and just forwards:

```yaml
- id: tts-announce
  config:
    provider: command
    command: curl
    args: ["-s", "-X", "POST", "http://127.0.0.1:8777/speak", "-H", "content-type: application/json", "-d"]
    mime: audio/wav   # unused; the gateway plays
```

(The text arrives on the command's stdin; adapt with a tiny wrapper if you
prefer `-d @-`.)

## One server, every harness (as wired on this machine)

speakd is the shared server; each harness connects through its own door:

| Harness | Door | Config location |
| --- | --- | --- |
| **DSH (Deepy)** | MCP streamable-http → tool `mcp__speakd__speak` | `~/.dsh/profiles/web/cordis.patch.yml` (`mcp-speakd` entry, already added) |
| **opencode** | MCP remote | `~/.config/opencode/opencode.json` → `"mcp": {"speakd": {"type": "remote", "url": "http://127.0.0.1:8777/mcp"}}` (already added) |
| **Codex CLI** | stdio wrapper (curl bridge) | `~/.codex/config.toml` → `[mcp_servers.speakd]` (already added) |
| **Claude Code** | Stop hook + MCP stdio | not installed on this machine; see hooks section above when it is |
| **Anything else** | plain HTTP | `curl -X POST http://127.0.0.1:8777/speak -H 'content-type: application/json' -d '{"text":"..."}'` |

DSH note: the profile patch change takes effect after restarting DSH (the web
profile has no HMR key). The tool appears as `mcp__speakd__speak`.

## Identity protocol — who is speaking

Every harness gets its own MCP address. The gateway announces the name and
applies that client's voice profile:

| Harness | Address it connects to | Voice you hear | Announced as |
|---|---|---|---|
| DSH (Deepy) | `http://127.0.0.1:8777/mcp/deepy` | American female (lessac) | "Deepy here." |
| opencode | `http://127.0.0.1:8777/mcp/opencode` | British male (alan) | "opencode here." |
| Codex | `http://127.0.0.1:8777/mcp/codex` | American male (ryan) | "Codex here." |
| anything else | `http://127.0.0.1:8777/mcp` | service default | (no announcement) |

Names are free-form: `/mcp/anything` works, hyphens become spaces, the name
is capitalized for the announcement. Clients can also send the header
`x-speakd-client: <name>` on the plain `/mcp` path. Disable announcements
with `SPEAKD_ANNOUNCE=off`.

Per-client voices live in `~/.config/speakd/voices.json`. **Recommended:
pool mode** — list voices with `"clients": []` and `"usage": 0`; any client
that connects claims the least-used free voice automatically and keeps it
(sticky, persisted). No harness names are hardcoded; a new harness just
works. When every voice is taken, newcomers share the least-used one.

```json
{
  "pool": [
    { "id": "in-accent",  "model": "~/.cache/piper-test/voice-in.onnx",       "lengthScale": 1.45, "usage": 0, "clients": [] },
    { "id": "us-female",  "model": "~/.cache/piper-test/voice.onnx",          "lengthScale": 1.45, "usage": 0, "clients": [] },
    { "id": "gb-male",    "model": "~/.cache/piper-test/voice-gb-male.onnx",  "lengthScale": 1.45, "usage": 0, "clients": [] },
    { "id": "us-male",    "model": "~/.cache/piper-test/voice-us-male.onnx",  "lengthScale": 1.45, "usage": 0, "clients": [] }
  ]
}
```

Current auto-assignments on this machine: deepy → us-female,
opencode → gb-male, codex → us-male, zed → in-accent (Indian English).
A fixed per-name map (old format) also still works.

Model paths support `~`. Restart speakd after editing: `systemctl --user
restart speakd`. Extra piper voices (~60 MB each) are at
github.com/rhasspy/piper-voices under `en/en_US|en_GB/.../medium/`.

## Speech protocol (how agents should talk)

The `speak` tool's schema enforces this, and the gateway cleans anything that
slips through. When calling speakd — via MCP or HTTP — send a **spoken
summary**, not the reply itself:

- 1–4 conversational sentences, ~2–3 max for one call
- no code, no URLs, no tables, no file paths, no numbered step lists
- numbers and names only when they matter
- the full technical answer stays in the written reply; the voice is the headline

Bursts (many agents finishing at once) are safe: one message plays at a time,
a ~0.9 s pause separates jobs, the queue holds at most 6 and drops the oldest
under pressure. Tune with `SPEAKD_MIN_GAP_MS` and `SPEAKD_QUEUE_LIMIT`.

## Design notes

- Queue: one synthesis at a time, drop-oldest at 6 jobs, ~0.9 s gap between
  jobs — a multi-harness burst never piles up or overlaps.
- Streaming: the local piper pipeline pipes raw PCM straight into the player,
  so RAM stays flat (~20–30 MB) regardless of message length; cloud providers
  still buffer per message (bounded by maxChars).
- Cleaner: code fences, inline code, tables, URLs are stripped before
  synthesis — "heavy lines" are never spoken.
- Pace: piper runs with `--length-scale 1.15 --sentence-silence 0.35`
  (slower, with a natural pause after each sentence).
- Body cap 512 KB; playback failures log 5 diagnostics then stay quiet.
- Nothing is recorded or stored; temp audio files are deleted after playback.

## Voice engines (as installed on this machine)

Current setup: **Piper neural voice, fully offline** (installed via `uv tool install piper-tts`,
voice `en_US-lessac-medium` in `~/.cache/piper-test/`, 22050 Hz raw PCM wrapped to WAV by speakd).

The service (`~/.config/systemd/user/speakd.service`) currently sets:

```ini
Environment=SPEAKD_PROVIDER=command
Environment=SPEAKD_COMMAND=%h/.local/bin/piper
Environment="SPEAKD_ARGS=[\"-m\",\"%h/.cache/piper-test/voice.onnx\",\"--output-raw\"]"
Environment=SPEAKD_MIME=audio/pcm
Environment=SPEAKD_PCM_RATE=22050
```

Other engines:

- **system speech** (robotic): `SPEAKD_PROVIDER=selfplay`, `SPEAKD_COMMAND=spd-say`
  (speakd has built-in default args; add `SPEAKD_ARGS` JSON array with `{text}` to customize).
- **cloud natural voice**: `SPEAKD_PROVIDER=gemini` + `GEMINI_API_KEY=…` (or `openai` + `OPENAI_API_KEY`).

After edits: `systemctl --user daemon-reload && systemctl --user restart speakd`.

