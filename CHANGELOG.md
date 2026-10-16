# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- UniFi Access doors in Gladys, through the official UniFi Access API of the
  console (port 12445, API token), on the local network: one device per door
  with its lock (locked/unlocked), door position (open/closed, when a sensor
  is wired), doorbell, temporary lock rule and last access. Nothing on the
  dashboard can unlock a door.
- Real-time updates through the notification WebSocket of UniFi Access, and a
  complete read every 5 minutes (every minute while the WebSocket is down).
  The badge of each door shows whether it is online.
- Scene triggers: doorbell rang, access granted, access denied (with the user,
  the method and the direction), door alarm (forced open, held open), door
  offline and back online.
- Scene actions: keep a door locked, return a door to its normal schedule,
  unlock a door. The remote unlock is disabled by default and refused until it
  is enabled in the configuration.
- A "UniFi Access doors" dashboard widget: the doors and the last accesses,
  with "Always locked" and "Normal schedule" buttons for a single door.
- A "Test the connection" button, and a connection status that explains the
  problem (console not answering, certificate, token refused, permission
  missing).
- Interface texts and documentation in English, French, German and Spanish;
  feature names in French by default.
- `scripts/probe.mjs`, a read-only probe of a real console.
- Apache-2.0 `LICENSE` file.

[Unreleased]: https://github.com/guim31/gladys-unifi-access/commits/main
