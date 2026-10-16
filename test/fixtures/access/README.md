# UniFi Access fixtures

Real answers of the UniFi Access API, captured on live controllers (UniFi Access 4.3.3, 2024 and 2026) by [hjdhjd/unifi-access](https://github.com/hjdhjd/unifi-access) and published in its test
suite (`src/official/devices.fixtures.ts`, `src/protocol/events.fixtures.ts`). They were already
anonymized there (MAC addresses `aabbcc…`, IP addresses `192.0.2.x`, UUIDs `00000000-…`, names
`Test Name N`). Here, the placeholder names were replaced by readable ones (Front door, Garage,
Alice Martin…), and the NFC card number, the authentication id and the intercom call ids by
invented values.

| File                          | Content                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `doors.json`                  | `GET /api/v1/developer/doors`: three doors, two open, one without position sensor                                                      |
| `devices.json`                | `GET /api/v1/developer/devices`: a UA Hub with a G2 Pro and an offline G2 Mini, an unadopted UA Ultra, a UA Hub Door Mini              |
| `events-interactive.json`     | an intercom ring, a hand-wave access, a refused NFC card, a remote unlock: each access as `logs.insights.add` then its `logs.add` twin |
| `events-door-state.json`      | a door forced open (`alarms: [{ type: "force_unlock" }]`), then unlocked                                                               |
| `events-historical.json`      | 2024 firmware: an intercom ring without `door_id`, a remote unlock                                                                     |
| `events-official-socket.json` | an answered intercom call                                                                                                              |
| `events-tamper.json`          | a tamper alert of a UA Ultra                                                                                                           |
| `events-corpus-2026.json`     | location and device updates of a 2026 controller (both dialects)                                                                       |

`test/fixtures/gladys-feature-table.json` (one level up) is the table of the category/type couples
of the Gladys core, extracted from its code.

## License of the captures

The captures come from hjdhjd/unifi-access, under the ISC license:

```
Copyright (c) 2017-2026, HJD https://github.com/hjdhjd

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```
