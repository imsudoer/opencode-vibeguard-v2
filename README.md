# opencode-vibeguard-v2

A security-focused fork of [`inkdust2021/opencode-vibeguard`](https://github.com/inkdust2021/opencode-vibeguard),
ported to the **OpenCode V2 plugin API**.

The plugin replaces configured secrets and PII with placeholders **before a request
is sent to the model provider**, restores placeholders **before local tools run**,
and can optionally restore them in the model response.

> This is a fork, not an official upstream release. The redaction engine comes from
> upstream VibeGuard; the V2 adapter, response restoration and short-placeholder
> mode are maintained here.

---

## Why this fork exists

Upstream `opencode-vibeguard@0.1.0` is a V1 plugin. OpenCode V2 loads plugins from
a default export and rejects it with:

```text
Plugin must export a default definition with an id and an effect or setup function.
```

This fork adds:

- A V2 plugin definition (`export default { id, setup }`).
- Request-time redaction through the V2 `context` hook, covering `system` and all
  message parts (`text`, `reasoning`, `compaction`, `tool-call.input`,
  `tool-result.result`).
- Tool argument restoration through `tool.hook("execute.before")`.
- Optional response restoration through `session.hook("http.response")`, including
  SSE chunk reassembly when a placeholder is split across several `data:` events.
- A fix for `ReadableStream is locked`: response bodies are read through
  `response.clone()`, so the original stream is never consumed.
- Short placeholders (`test@example.com`) by default. Models copy them reliably;
  long hex placeholders are frequently corrupted during generation, which makes
  restoration impossible.
- Updated secret patterns (`gsk_...`, `sk_...`, `xai-...`, GitHub, AWS, etc.).

---

## How it works

```text
user prompt / history / tool output
              │
              ▼
   context hook: redact secrets
              │
              ▼
       provider request
   (only __VG_*__ placeholders)
              │
              ▼
       provider response
              │
      ┌───────┴────────┐
      │                │
      ▼                ▼
 restore_response   stream as-is
     = true           = false
      │                │
      └───────┬────────┘
              ▼
      local OpenCode UI

tool call args ──► execute.before: restore real values ──► local tool
```

### Placeholder format

Default (`placeholder_style: "short"`):

```text
test@example.com
sk-305cba0c467dd30f-13d5c0-9cee4a66
```

Upstream-compatible (`placeholder_style: "hash"`):

```text
__VG_EMAIL_ab12cd34ef56__
```

`hash` mode uses `HMAC-SHA256(session secret, original)` truncated to 12 hex
characters. `short` mode uses a per-session counter. Both keep a stable
placeholder for the same value within a session.

---

## Installation

### 1. Clone into the global plugin directory

OpenCode V2 auto-discovers plugins placed in `~/.config/opencode/plugins/`:

```bash
git clone https://github.com/imsudoer/opencode-vibeguard-v2.git \
  ~/.config/opencode/plugins/opencode-vibeguard
```

If you already have this repository checked out somewhere else, copy or symlink
the directory instead.

### 2. Create the configuration

```bash
cp ~/.config/opencode/plugins/opencode-vibeguard/vibeguard.config.json.example \
   ~/.config/opencode/vibeguard.config.json
chmod 600 ~/.config/opencode/vibeguard.config.json
```

Edit the file and add at least one detection rule. The plugin is a **no-op** when
the config is missing or `enabled` is `false`.

Keep the config private: it can contain literal secret values under
`patterns.keywords`.

### 3. Restart OpenCode

Restart OpenCode, or trigger a plugin reload. Check the log if the plugin does not
appear to run:

```bash
tail -f ~/.local/share/opencode/log/opencode.log
```

With debug enabled you should see `[opencode-vibeguard]` lines.

---

## Configuration

Config lookup order (first match wins):

1. `OPENCODE_VIBEGUARD_CONFIG` environment variable
2. `<project>/vibeguard.config.json`
3. `<project>/.opencode/vibeguard.config.json`
4. `~/.config/opencode/vibeguard.config.json`

Example:

```json
{
  "enabled": true,
  "debug": false,
  "placeholder_prefix": "__VG_",
  "placeholder_style": "short",
  "restore_response": false,
  "session": {
    "ttl": "1h",
    "max_mappings": 100000
  },
  "patterns": {
    "keywords": [
      { "value": "literal-secret-to-hide", "category": "API_KEY" }
    ],
    "regex": [
      { "pattern": "sk-[A-Za-z0-9_-]{16,}", "category": "OPENAI_KEY" },
      { "pattern": "gsk_[A-Za-z0-9]{20,}", "category": "GROQ_KEY" },
      { "pattern": "(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}", "category": "GITHUB_TOKEN" },
      { "pattern": "AKIA[0-9A-Z]{16}", "category": "AWS_ACCESS_KEY" }
    ],
    "builtin": ["email"],
    "exclude": ["example.com", "localhost", "127.0.0.1"]
  }
}
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `false` | Master switch. A missing config also disables the plugin. |
| `debug` | `false` | Log redaction/restoration counts and the config path. Never logs plaintext. |
| `placeholder_prefix` | `"__VG_"` | Prefix for generated placeholders. |
| `placeholder_style` | `"short"` | `short` (`test@example.com`) or `hash` (`__VG_EMAIL_ab12cd34ef56__`). |
| `restore_response` | `false` | Restore placeholders in provider responses. See the trade-off below. |
| `session.ttl` | `"1h"` | Mapping lifetime, e.g. `30m`, `2h`, `1d`. Disable expiry with `0`. |
| `session.max_mappings` | `100000` | Maximum placeholders kept per session. |
| `patterns.keywords` | `[]` | Exact literal values to redact. |
| `patterns.regex` | `[]` | Custom regex rules. Each rule needs `pattern` and `category`. |
| `patterns.builtin` | `[]` | Built-in rules: `email`, `china_phone`, `china_id`, `uuid`, `ipv4`, `mac`. |
| `patterns.exclude` | `[]` | Exact strings that must not be redacted. |

`patterns.builtin` is empty by default. Enable only the rules you need; broad rules
such as `uuid` and `ipv4` can fill the conversation with placeholders.

### Enabling response restoration

`restore_response: false` (default) keeps token-by-token streaming. Placeholders
may be visible in the live response, but they are still restored in tool arguments,
and the provider never receives the plaintext.

`restore_response: true` rewrites the completed provider response before OpenCode
sees it. This is the closest V2 equivalent of V1's `experimental.text.complete`.
The trade-off is important:

- OpenCode must buffer the entire response before parsing it, so streaming output
  becomes one final block.
- The hook reads `response.clone()`. The original stream is left untouched, which
  avoids `TypeError: ReadableStream is locked`.
- SSE deltas are grouped by JSON path and concatenated before restoration, so a
  placeholder split across several events is still restored.
- Non-JSON and non-SSE response bodies are left unchanged.
- If the model writes a placeholder incorrectly, it cannot be restored. This is
  why `short` placeholders are the default.

Set it to `true` if you need readable secrets in the assistant's answer and can
accept buffered output.

---

## What is covered

Redaction runs before every provider request on:

- `system` prompt parts;
- user and assistant `text`;
- `reasoning` and `compaction` text;
- `tool-call.input` (arguments of historical tool calls);
- `tool-result.result` (outputs of historical tools).

Before local tool execution, the plugin walks the tool arguments and restores
every placeholder it knows. This lets `bash`, `read`, `write`, `edit`, and other
tools work with the real value while the model only ever saw the placeholder.

The plugin does **not**:

- protect secrets that match no configured rule;
- hide the fact that a value was redacted (the category and counter are visible);
- persist mappings across restarts (the map is in memory);
- encrypt the local OpenCode database. Tool arguments and outputs are stored
  locally with real values after execution; the plugin re-redacts them before
  they are sent upstream in later turns.

Treat this as a guardrail, not as a replacement for revoking leaked credentials.

---

## Compatibility

- OpenCode **2.x** (tested on 2.2.2).
- Node.js 18+.
- The V1 export (`VibeGuardPrivacy`) is kept for backward compatibility, but this
  fork is maintained for V2.

---

## Development

```bash
npm test
```

The test suite covers request redaction, tool-argument restoration, SSE responses
split across events, JSON responses, and the "leave untouched bodies alone" path.

Syntax check:

```bash
for f in src/*.js index.js server.js; do node --check "$f"; done
```

---

## Credits

- Upstream project: [`inkdust2021/opencode-vibeguard`](https://github.com/inkdust2021/opencode-vibeguard)
- Original inspiration: [`inkdust2021/VibeGuard`](https://github.com/inkdust2021/VibeGuard)
- V2 port and response restoration: [`imsudoer`](https://github.com/imsudoer)

## License

MIT. See [LICENSE](LICENSE).