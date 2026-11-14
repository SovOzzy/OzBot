# OzBot

A bespoke, modular Discord bot that runs all the time on a small shared VPS. It learns how a server talks (Markov
chain), joins voice channels, and says things in custom voices (Piper TTS). A private, tailnet-only dashboard switches
each function on or off and holds all its settings.

```
core/       Discord client, module system, settings store (SQLite), TTS manager, dashboard web server
modules/    one folder per function (manifest.json + index.mjs + optional panel.js)
  markov/   learns from chosen channels, makes sentences, /markov
  voice/    joins voice, speaks random sentences on a timer, /join /leave /say /speak /voice set|list|current;
            not in voice: /say and /speak reply with an MP3 clip
  voicelog/ posts every spoken line to a channel ("text" - Voice + MP3), join/leave notes
  voices/   voice library: record training clips in the browser, upload .onnx voices, name/tune/preview them
web/        dashboard (no build step)
tts/        Piper worker (Python), started on demand, stopped when idle
trainer/    run on your PC (WSL + NVIDIA) to train new voices; see trainer/README.md
deploy/     systemd unit + install script
tests/      node --test
```

## Running it

On the VPS:

```bash
deploy/install.sh   # node packages, Python venv with piper-tts, stock voices, systemd unit, tailscale serve :8447
```

- Dashboard: `https://gildesk.tailb6fe1d.ts.net:8447`. Tailnet only, and only the machine owner's Tailscale login is
  accepted (`allowedLogins` in `config.json` changes that).
- After changing server code: `sudo systemctl restart ozbot`. Front-end changes only need a page reload.
- Logs: `journalctl -u ozbot -f`
- Tests: `npm test`
- Test instance: `OZBOT_PORT=4499 OZBOT_DATA=/tmp/ozbot-test node core/main.mjs` (no token means no Discord, but the
  dashboard and TTS work).

### Discord setup (once)

1. Go to https://discord.com/developers/applications, click **New Application**, then open **Bot**.
2. **Reset Token** and copy it. On the same page, turn on **Message Content Intent**.
3. In the dashboard, open the cog (Bot settings) and paste the token. Then use **Invite to a server**, which adds the
   bot with the right permissions (read and send messages, connect, speak) plus slash commands.
4. Back in the dashboard, set **Markov chat** to the channels to learn from, and **Voice chat** to its home voice channel.

## Resource use (2 vCPU ARM, shared with Gildesk Studio and OzAds)

| Part | Memory | CPU |
|---|---|---|
| Bot + dashboard | ~110 MB | ~0 at idle |
| Markov (20k messages) | a few MB | negligible |
| Piper voice engine | ~250 MB, **only while in use** (exits after 10 min idle) | ~0.7 s of one core per sentence |

The systemd unit runs at `Nice=10` with `CPUWeight=50`, `MemoryHigh=600M` and `MemoryMax=800M`, so it always gives way
to the other services. Speech is generated one sentence at a time.

## Adding a function (module)

Create `modules/<id>/`:

- `manifest.json`: `id` (same as the folder name), `name`, `description` (2 lines, separated by `\n`), `icon`
  (`chat`/`mic`/`wave`/`puzzle`), `order`, optional `requires`/`provides` (service names), `enabledByDefault`, and
  `settings` (a list of fields).
  - Field types: `text`, `textarea`, `number` (min/max/step), `boolean`, `select` (options), `textChannel`,
    `textChannels`, `voiceChannel`, `voice`, `role`.
  - The dashboard builds the settings form from this list, and the core validates values before your module sees them.
- `index.mjs`: `export default { start(ctx), stop?(ctx), settingsChanged?(ctx, now, old), commands?, routes?, status?(ctx) }`
  - `ctx.on(event, fn)`, `ctx.every(ms, fn)` and `ctx.after(ms, fn)` are cleaned up automatically when the module is
    switched off. Errors inside them are counted, and 5 errors in 10 minutes switches the module off with the reason
    shown on its page.
  - `ctx.emit(event, payload)` / `ctx.subscribe(event, fn)`: module events (e.g. Voice chat emits `voice:spoken`,
    `voice:joined`, `voice:left`; Voice log subscribes). `ctx.saveSettings(partial)`, `ctx.setStatus(text|null)`.
  - `buttons(ctx, interaction)`: button/menu clicks whose customId starts with `<id>:`.
  - `ctx.settings`, `ctx.db` (shared SQLite; prefix your tables with your id), `ctx.store`, `ctx.guild()`,
    `ctx.client`, `ctx.tts`, `ctx.log()`, `ctx.provide(name, api)` / `ctx.use(name)` to share with other modules,
    `ctx.fail(err)`.
  - `commands`: `[{ data: SlashCommandBuilder, run(ctx, interaction), autocomplete?(ctx, interaction) }]`. These are
    registered in the server only while the module is on.
  - `routes`: `{ 'POST name': async (ctx, { body, query, req }) => json }`, served at `/api/m/<id>/<name>`. To keep a
    route working while the module is off, or to read the raw upload, use `{ fn, always: true, raw: true }`. Return
    `{ file, remove, type }` to stream a file.
  - `status(ctx)`: live data shown on the module's page (`d.live` in the panel).
- `panel.js` (optional): `export async function render(el, api)` adds your own UI above the settings form. `api` has
  `h`, `toast`, `get/post/put(name)`, `fetchRaw`, `guild()`, `voices()`, `module` and `onUpdate(fn)` (called about
  every 10 s with fresh data).

Restart the service and the new function appears as a tile.

## Licence

MIT © Liam Osborne. Piper (piper-tts / piper1-gpl) is GPL-3.0. OzBot runs it as a separate process and doesn't bundle
it. Stock voices: see the model cards at https://huggingface.co/rhasspy/piper-voices.
