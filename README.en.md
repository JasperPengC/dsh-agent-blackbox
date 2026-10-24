# dsh-agent-blackbox

[中文](README.md) · English

Puts the [agent-blackbox](https://github.com/JasperPengC/agent-blackbox) dashboard
inside DeepSeek Harness: a sidebar entry and a full-size panel with live session
monitoring, replay and a cross-session cost overview. No extra process, no extra
port.

[![npm](https://img.shields.io/npm/v/dsh-agent-blackbox?label=npm&color=4f7cff)](https://www.npmjs.com/package/dsh-agent-blackbox)
[![ci](https://github.com/JasperPengC/dsh-agent-blackbox/actions/workflows/ci.yml/badge.svg)](https://github.com/JasperPengC/dsh-agent-blackbox/actions/workflows/ci.yml)
![license](https://img.shields.io/badge/license-MIT-green)

## Install

```bash
dsh plugin --profile desktop add dsh-agent-blackbox
```

Restart DSH, then open *Blackbox* from the sidebar. You can also install it from
*Plugins → Add plugin* by entering the package name and refresh the page.

The published package bundles the compiled core (`core/`) and renderer (`web/`),
so no separate agent-blackbox install or local build is required.

## What you get

- **Live**: sessions that are still being written refresh incrementally
- **Replay**: timeline zoom and brush, tool waterfall, event inspector; events and
  tools are revealed as playback advances
- **Attribution**: per-agent tools, tokens, cost and blocking relationships
- **Overview**: cost ranking across sessions, grouped by runtime and project

## How it works

The plugin mounts the core HTTP router under the host's own web server at
`/blackbox`, so the panel is same-origin with DSH and needs no extra port. The host
half (`lib/index.js`) registers the router inside the host process; the browser
half (`lib/client.js`) registers the sidebar entry and panel. Both reuse the same
renderer as the standalone app, so the plugin and the app cannot drift apart.

Everything is local: the plugin only reads local session files and makes no
network requests.

## Development

```bash
git clone https://github.com/JasperPengC/dsh-agent-blackbox.git
cd dsh-agent-blackbox

dsh plugin --profile desktop add link:$PWD
npm test
```

`core/` and `web/` are synced from the main
[agent-blackbox](https://github.com/JasperPengC/agent-blackbox) build output and
are not edited by hand:

```bash
node scripts/sync-core.mjs --from /path/to/agent-blackbox
```

## Requirements

- DeepSeek Harness `>=0.2.0-rc.2 <0.3.0`
- Node.js `>=22.19`

## Known limitations

- Sessions larger than 24 MB are loaded from an 8 MB tail window
- Cost estimates need a local pricing file; models without a price are excluded
- Restart DSH after upgrading the plugin

## Related repositories

- [agent-blackbox](https://github.com/JasperPengC/agent-blackbox) — the main project:
  session event model, dashboard, CLI and HTTP API. The bundled `core/` and `web/`
  in this package are built and synced from it.

## Links

- Main repository and documentation: https://github.com/JasperPengC/agent-blackbox
- npm: https://www.npmjs.com/package/dsh-agent-blackbox
- Issues: https://github.com/JasperPengC/dsh-agent-blackbox/issues
