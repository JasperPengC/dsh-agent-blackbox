# dsh-agent-blackbox

[中文](README.md) · English

DeepSeek Harness plugin that opens the
[agent-blackbox](https://github.com/JasperPengC/agent-blackbox) dashboard in the
sidebar: live session monitoring, timeline replay and a cross-session cost
overview. It mounts inside the host process — no extra process, no extra port.

[![npm](https://img.shields.io/npm/v/dsh-agent-blackbox?label=npm&color=4f7cff)](https://www.npmjs.com/package/dsh-agent-blackbox)
[![ci](https://github.com/JasperPengC/dsh-agent-blackbox/actions/workflows/ci.yml/badge.svg)](https://github.com/JasperPengC/dsh-agent-blackbox/actions/workflows/ci.yml)
![license](https://img.shields.io/badge/license-MIT-green)

![Panel replay](https://raw.githubusercontent.com/JasperPengC/agent-blackbox/main/docs/playback-dark.gif)

<sub>Real panel UI · synthetic session · 4× playback · [light recording](https://raw.githubusercontent.com/JasperPengC/agent-blackbox/main/docs/playback-light.gif) · slow connection? [open the static light screenshot](https://raw.githubusercontent.com/JasperPengC/dsh-agent-blackbox/main/docs/panel-light.png)</sub>

## Install

```bash
dsh plugin --profile desktop add dsh-agent-blackbox
```

Restart DSH, then open *Blackbox* from the sidebar. It can also be installed from
*Settings → Plugin market* by searching `agent-blackbox`.

The published package bundles the compiled core (`core/`) and renderer (`web/`),
so no separate agent-blackbox install or local build is required.

For development, link the checkout:

```bash
git clone https://github.com/JasperPengC/dsh-agent-blackbox.git
cd dsh-agent-blackbox
dsh plugin --profile desktop add link:$PWD
npm test
```

## What you get

- **Live**: sessions that are still being written refresh incrementally
- **Replay**: timeline zoom and brush, tool waterfall, event inspector
- **Attribution**: per-agent tools, tokens, cost and blocking relationships
- **Overview**: cost ranking across sessions, grouped by runtime and project

## How it works

The plugin mounts the core HTTP router under the host's own web server at
`/blackbox`, so the panel is same-origin with DSH and needs no extra port. The host
half (`lib/index.js`) registers the router inside the host process; the browser
half (`lib/client.js`) registers the sidebar entry and panel. Both reuse the same
renderer as agent-blackbox. Everything is local: the plugin only reads local
session files and makes no network requests.

## Development

```bash
npm test                                                    # host smoke tests
node scripts/sync-core.mjs --from /path/to/agent-blackbox    # refresh core/web
```

`core/` and `web/` are build output from the main repository; do not edit them by hand.

## Requirements and limitations

- DeepSeek Harness `>=0.2.0-rc.2 <0.3.0`; Node.js `>=22.19`
- Sessions larger than 24 MB load an 8 MB tail window
- Cost estimates need a local pricing file; unknown models are excluded
- Restart DSH after upgrading the plugin

## Related repositories

- [agent-blackbox](https://github.com/JasperPengC/agent-blackbox) — main project:
  session event model, dashboard, CLI and HTTP API

## Community

Promoted in the [LINUX DO](https://linux.do) community.

## Links

- npm: https://www.npmjs.com/package/dsh-agent-blackbox
- Issues: https://github.com/JasperPengC/dsh-agent-blackbox/issues
