# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- **Secrets**: the UniFi Access API token is a `secret` field of the Gladys
  configuration. The integration reads it from Gladys at startup, keeps it in
  memory, sends it only to the console it belongs to (`Authorization` header of
  the API requests and of the notification WebSocket), and never writes it to
  `/data` nor to the logs.
- **Stored in `/data`**: `unifi-access-state.json`, the last 20 accesses shown
  by the widget (door, user name, method, direction, time) and the doors that
  have rung. Nothing else.
- **Network**: requests go only to the console address typed in the
  configuration, on port 12445 (HTTPS and one outgoing WebSocket). The
  certificate is verified unless the user ticks "Accept the self-signed
  certificate"; the integration opens no port and calls no cloud service.
- **Doors**: the integration unlocks a door only through the scene action
  "Unlock a door", and only when the user enabled the remote unlock in the
  configuration (off by default). No device feature, widget button or
  configuration action can unlock a door.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
UniFi Access and the UniFi consoles (report those to Ubiquiti), and the other
devices and services of your network.
