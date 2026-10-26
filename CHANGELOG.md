# Changelog

## [0.1.2] - 2026-10-26

### Fixed

- The event list stayed empty after opening or switching a session until a tab was
  clicked; switching sessions now also restores follow-latest.
- Focus-mode playback near the end of a session showed `跳过 Infinity:NaN:NaN`.

### Changed

- Bundled core and renderer refreshed from agent-blackbox main.

## [0.1.1] - 2026-10-25

First release from this repository.

### Changed

- The plugin is now developed and published from its own repository; the bundled
  core (`core/`) and renderer (`web/`) are synced from the agent-blackbox main
  repository.
- npm metadata points at this repository.

### Added

- Host smoke tests (`npm test`) and CI on Node 22/24.
- `scripts/sync-core.mjs` for maintainers refreshing the bundled core.

## [0.1.0] - 2026-10-25

### Added

- Sidebar entry and full-size panel for the agent-blackbox dashboard inside
  DeepSeek Harness.
- Live session monitoring, timeline replay, per-agent attribution and the
  cross-session cost overview, all served from the host process.
- Self-contained package: compiled core and renderer are bundled.
- Bundled synthetic fixture used when no local session exists.
