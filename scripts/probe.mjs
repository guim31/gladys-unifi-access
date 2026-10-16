#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Read-only probe of a UniFi Access console, with the very client of the
// integration (src/access/), for whoever has the network the development
// session lacked.
//
//   node scripts/probe.mjs <console>[:port]
//       Without a token: walks the real connection up to the refusal of a
//       fake token (certificate, REST, WebSocket upgrade). Changes nothing.
//
//   UNIFI_ACCESS_TOKEN=... node scripts/probe.mjs <console> [seconds]
//       With a real token (read from the environment, never from the command
//       line, never printed): counts the doors and devices, reads the lock
//       rules, then listens to the notifications for `seconds` (30 by
//       default) and prints the event names and the shape of the door
//       states. Only GET requests and the notification socket: nothing is
//       locked, unlocked or modified.
//
// Prints no token, no name, no address beyond the one given.
// -----------------------------------------------------------------------------

import { AccessClient, ERROR_KINDS } from '../src/access/client.js';
import { parseNotification } from '../src/access/model.js';
import { NotificationSocket } from '../src/access/socket.js';
import { createNodeTransport } from '../src/access/transport.js';
import { describeHost, parseHost } from '../src/config.js';

const FAKE_TOKEN = 'gladys-probe-fake-token-0000000000';

const [, , rawHost, rawSeconds] = process.argv;
const host = parseHost(rawHost);
if (!host) {
  console.error('Usage: node scripts/probe.mjs <console>[:port] [seconds]');
  process.exit(2);
}
const token = process.env.UNIFI_ACCESS_TOKEN?.trim() || null;
const seconds = Math.max(5, Math.min(600, Number(rawSeconds) || 30));
const transport = createNodeTransport();
const line = (label, value) => console.log(`${label.padEnd(34)} ${value}`);

const client = (secret, insecure) =>
  new AccessClient({ host, token: secret, insecure, transport, timeoutMs: 10_000 });

async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, kind: err.kind ?? 'error', message: err.message };
  }
}

function socketOnce(secret) {
  return new Promise((resolve) => {
    const socket = new NotificationSocket({
      open: () => client(secret, true).openNotifications(),
      onPacket: () => {},
      onOpen: () => {
        socket.stop();
        resolve({ opened: true });
      },
      onClose: (error) => resolve({ opened: false, kind: error?.kind, message: error?.message }),
      timers: false,
    });
    socket.start();
  });
}

console.log(`UniFi Access probe — ${describeHost(host)}${token ? ' (with a token)' : ''}\n`);

// 1. The certificate: trusted by the system, or self-signed.
const strict = await attempt(() => client(FAKE_TOKEN, false).getDoors());
line(
  'Certificate',
  strict.kind === ERROR_KINDS.TLS
    ? `not trusted by the system (${strict.message.split('(').pop().replace(')', '')}): tick "Accept the self-signed certificate"`
    : strict.kind === ERROR_KINDS.UNREACHABLE
      ? 'no answer'
      : 'trusted',
);

// 2. The REST API with a fake token: must be refused.
const fake = await attempt(() => client(FAKE_TOKEN, true).getDoors());
line('REST, fake token', fake.ok ? 'ACCEPTED (unexpected!)' : `${fake.kind} — ${fake.message}`);
if (fake.kind === ERROR_KINDS.UNREACHABLE) {
  console.log('\nThe console does not answer on this port: check the address and port 12445.');
  process.exit(1);
}

// 3. The WebSocket upgrade with a fake token: must be refused too.
const fakeSocket = await socketOnce(FAKE_TOKEN);
line(
  'Notification socket, fake token',
  fakeSocket.opened ? 'OPENED (unexpected!)' : `${fakeSocket.kind} — ${fakeSocket.message}`,
);

if (!token) {
  console.log(
    `\n${fake.kind === ERROR_KINDS.AUTH ? 'OK: the developer API answers and refuses a fake token.' : 'Unexpected answer: see above.'}` +
      '\nSet UNIFI_ACCESS_TOKEN to go further (read-only).',
  );
  process.exit(fake.kind === ERROR_KINDS.AUTH ? 0 : 1);
}

// 4. With the real token, read-only.
const real = client(token, true);
const doors = await attempt(() => real.getDoors());
if (!doors.ok) {
  line('REST, real token', `${doors.kind} — ${doors.message}`);
  process.exit(1);
}
const devices = await attempt(() => real.getDevices());
line('Doors', doors.value.length);
line(
  'Door states (lock/position)',
  doors.value
    .map((door) => `${door.door_lock_relay_status ?? '?'}/${door.door_position_status ?? '?'}`)
    .join(', ') || '-',
);
if (devices.ok) {
  const types = {};
  for (const device of devices.value) {
    types[device.type] = (types[device.type] ?? 0) + 1;
  }
  line('Devices by type', JSON.stringify(types));
  line(
    'Devices online',
    `${devices.value.filter((d) => d.is_online).length}/${devices.value.length}`,
  );
  const caps = new Set(devices.value.flatMap((d) => d.capabilities ?? []));
  line('Doorbell capability seen', caps.has('door_bell') ? 'yes' : 'no');
} else {
  line('Devices', `${devices.kind} — ${devices.message}`);
}
const rules = await Promise.all(
  doors.value.map((door) => attempt(() => real.getLockRule(door.id))),
);
line(
  'Lock rules',
  rules.map((rule) => (rule.ok ? rule.value?.type || 'normal' : rule.kind)).join(', ') || '-',
);

// 5. Listen to the notifications.
console.log(`\nListening to the notifications for ${seconds} s (open a door, ring, badge…)`);
const counts = {};
const shapes = new Set();
const socket = new NotificationSocket({
  open: () => real.openNotifications(),
  onPacket: (packet) => {
    counts[packet.event] = (counts[packet.event] ?? 0) + 1;
    for (const update of parseNotification(packet)) {
      if (update.kind === 'door_state') {
        shapes.add(JSON.stringify(Object.keys(update.state).sort()));
        if (update.state.alarms?.length) {
          shapes.add(`alarms: ${JSON.stringify(update.state.alarms)}`);
        }
      }
      if (update.kind === 'access') {
        shapes.add(`access: ${update.result} via "${update.provider}" (${update.source})`);
      }
      if (update.kind === 'doorbell') {
        shapes.add(`doorbell: door id ${update.doorId ? 'present' : 'absent'}`);
      }
    }
  },
  onOpen: () => line('Notification socket, real token', 'open'),
  onClose: (error) =>
    line(
      'Notification socket closed',
      error ? `${error.kind} — ${error.message}` : 'by the console',
    ),
  timers: false,
});
socket.start();
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
socket.stop();
line('Events received', JSON.stringify(counts));
for (const shape of shapes) {
  line('  seen', shape);
}
