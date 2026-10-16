# UniFi Access for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) integration for **UniFi Access**, Ubiquiti's
access control system (G2 and G3 readers, Intercom, UA Hub, UA Hub Door Mini, UA Ultra): the state
of every door in Gladys, its doorbell, who came in and how, the door alarms — on the local
network, through the official UniFi Access API.

> **Developed without the hardware: feedback welcome.** The integration was written from the
> official API, the Home Assistant integration and real captures published by other projects,
> and tested against a fake controller built from those captures — never against a real UniFi
> Access installation. Please report what works and what does not in the
> [issues](https://github.com/guim31/gladys-unifi-access/issues).

Documentation for users: [English](docs/en.md), [Français](docs/fr.md), [Deutsch](docs/de.md),
[Español](docs/es.md).

## Features

- **One device per door**, read-only: lock (locked/unlocked), door position (open/closed, when a
  door position sensor is wired), doorbell (a ring pulse, on doors with a doorbell), the
  temporary lock rule (normal, always locked, always unlocked, unlocked until…), the last access
  (who, how, which way). Online or offline is the transport badge of the device.
- **Real time** through the notification WebSocket of UniFi Access, and a complete read every
  5 minutes by the container itself (every minute while the WebSocket is down).
- **Scene triggers**: doorbell rang; access granted and access denied (filters: door, method —
  NFC card, PIN, face, hand wave, mobile, wallet, QR code, plate, intercom, remote — and user;
  variables: user, method, direction); door alarm (forced open, held open); door offline and back
  online. Each access is fired once, though UniFi Access reports it twice.
- **Scene actions**: keep a door locked ("always locked", safe), return it to its normal
  schedule, and unlock a door.
- **Remote unlock off by default.** Unlocking exists only as a scene action, and is refused unless
  the user enables it in the configuration; ending "always locked" (which may unlock the door) is
  held to the same switch. No switch, no dashboard button ever unlocks a door.
- **Dashboard widget**: the doors (locked, open, alarm, offline) and the last accesses; for one
  door, "Always locked" and "Normal schedule" buttons.
- Interface texts and documentation in English, French, German and Spanish.

## Requirements

- UniFi Access on a UniFi OS console, with the developer API (Settings → General → Advanced →
  API Token) and an API token with the **Space** and **Device** permissions.
- Gladys Assistant **5.1.0** or later, on a network that reaches port **12445** of the console.

## Installation

In Gladys: **Integrations → Install from GitHub**, enter
`https://github.com/guim31/gladys-unifi-access`, then fill in the configuration: console
address, API token, "Accept the self-signed certificate" (UniFi consoles serve one on port
12445). Press **Test the connection**, then add the doors from the **Discovery** tab.

## How it works

- `src/access/client.js` talks to `https://<console>:12445/api/v1/developer` with the token as
  `Authorization: Bearer`: `GET /doors`, `GET /devices`, `GET|PUT /doors/:id/lock_rule`,
  `PUT /doors/:id/unlock` (only when enabled). Refusals come as HTTP statuses or as envelope
  codes (`CODE_AUTH_FAILED`…), both read.
- `src/access/socket.js` keeps the notification WebSocket (`/devices/notifications`) open,
  reopens it with a growing delay and pings it every 30 s.
- `src/access/model.js` reads the notifications seen on real controllers:
  `access.data.v2.location.update` and `access.data.v2.device.update` (lock, position, alarms,
  availability, lock rule), `access.remote_view` and `access.hw.door_bell` (doorbell),
  `access.logs.insights.add` and its twin `access.logs.add` (accesses).
- `src/hub.js` keeps the doors, publishes the states that change (with a 6 h heartbeat), fires
  the scene triggers, and runs the commands. The devices are published with
  `should_poll: false`: Gladys does not poll external devices reliably (Gladys#3198).
- `scripts/probe.mjs <console>` probes a real console read-only: certificate, refusal of a fake
  token on the REST API and on the WebSocket; with `UNIFI_ACCESS_TOKEN` set, it counts the doors
  and devices and lists the notifications it receives. It prints no token and no name.

## Limitations

- Not tested on real hardware (see above). The alarm vocabulary is the least known: only
  `force_unlock` has been seen in captures; other values are reported as "other" with their raw
  type.
- No management of users, visitors, PIN codes or NFC cards; no evacuation or lockdown control;
  no answering of intercom calls.
- The widget history starts when the integration starts (the last 20 accesses are kept in
  `/data`).
- One console per integration.

## Development

```bash
npm ci
npm run format:check
npm run lint
npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

The tests use the fake Gladys of the SDK (`@gladysassistant/integration-sdk/testing`) and an
in-memory UniFi Access controller (`test/helpers/fakeAccess.js`) answering with real captures
(`test/fixtures/access/`). See [`CLAUDE.md`](CLAUDE.md) for the project rules.

## Credits

- [hjdhjd/unifi-access](https://github.com/hjdhjd/unifi-access) by HJD (ISC): the real API and
  notification captures used as test fixtures (see `test/fixtures/access/README.md`), and the
  meaning of the door alarms.
- Home Assistant's
  [`unifi_access`](https://github.com/home-assistant/core/tree/dev/homeassistant/components/unifi_access)
  integration (Apache-2.0) and its library
  [py-unifi-access](https://github.com/imhotep/py-unifi-access) by imhotep and RaHehl (MIT): the
  endpoints, the notification events and how to tie them to the doors; and the
  [Home Assistant issue #184928](https://github.com/home-assistant/core/issues/184928) on the
  accesses reported twice. No code was copied.
- The architecture and the conformity tests follow
  [gladys-pihole](https://github.com/guim31/gladys-pihole) and
  [gladys-wled](https://github.com/guim31/gladys-wled).

## Disclaimer

This project is not affiliated with, endorsed or sponsored by Ubiquiti Inc. UniFi and UniFi
Access are trademarks of Ubiquiti Inc.

## License

Apache-2.0
