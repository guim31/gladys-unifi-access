// -----------------------------------------------------------------------------
// The hub, end to end against the fake controller: discovery, states, the
// notifications of the real captures, the scene events, the deduplication,
// the online/offline transitions, the lost socket and the console down.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_KEYS } from '../src/devices.js';
import { TRIGGERS } from '../src/hub.js';
import {
  CONFIG,
  DOORS,
  FakeAccess,
  createAll,
  createWorld,
  packets,
  settle,
  until,
} from './helpers/world.js';

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

const featureKeysOf = (w, doorId) =>
  w.fake.discoveredDevices
    .find((device) => device.external_id === w.deviceId(doorId))
    .features.map((feature) => feature.external_id.split(':').pop());

test('one device per door, with the features its hardware has', async (t) => {
  const w = await world(t);
  assert.deepEqual(
    w.fake.discoveredDevices.map((device) => device.name),
    ['Garage', 'Back door', 'Front door'],
  );
  assert.deepEqual(featureKeysOf(w, DOORS.GARAGE), [
    'lock',
    'door_position',
    'lock_rule',
    'last_access',
  ]);
  // UA Hub with a doorbell input, no position sensor wired.
  assert.deepEqual(featureKeysOf(w, DOORS.FRONT), ['lock', 'doorbell', 'lock_rule', 'last_access']);
  for (const device of w.fake.discoveredDevices) {
    assert.equal(device.should_poll, false);
    assert.ok(
      device.features.every((feature) => feature.read_only === true),
      'nothing to command',
    );
  }
});

test('the states of the doors are published, opening sensor 0 = open', async (t) => {
  const w = await world(t);
  assert.equal(w.state(DOORS.GARAGE, FEATURE_KEYS.LOCK), 1, 'locked');
  assert.equal(w.state(DOORS.GARAGE, FEATURE_KEYS.POSITION), 0, 'open (OPENING_SENSOR_STATE.OPEN)');
  assert.equal(w.state(DOORS.GARAGE, FEATURE_KEYS.RULE), 'Normal');
  assert.equal(w.state(DOORS.GARAGE, FEATURE_KEYS.LAST_ACCESS), 'No access yet');
  assert.equal(w.state(DOORS.FRONT, FEATURE_KEYS.DOORBELL), 0);
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
});

test('the transport badge says which door is offline', async (t) => {
  const w = await world(t);
  const badge = (doorId) =>
    w.fake.transports.filter((entry) => entry.device_external_id === w.deviceId(doorId)).at(-1);
  assert.equal(badge(DOORS.GARAGE).transport, 'local');
  assert.equal(badge(DOORS.FRONT).transport, 'local', 'its UA Hub answers (a reader is offline)');
  assert.equal(badge(DOORS.BACK).transport, 'unreachable', 'its only device is offline');
});

test('a door state notification updates the states, the alarm fires once', async (t) => {
  const w = await world(t);
  const before = w.fake.states.length;
  for (const packet of packets('events-door-state')) {
    await w.notify(packet);
  }
  assert.equal(w.state(DOORS.GARAGE, FEATURE_KEYS.LOCK), 0, 'unlocked at the end');
  assert.ok(w.fake.states.length > before);
  const alarms = w.events(TRIGGERS.ALARM);
  assert.equal(alarms.length, 1, 'device and location updates carry the same alarm');
  assert.deepEqual(alarms[0].data, {
    door: w.deviceId(DOORS.GARAGE),
    door_name: 'Garage',
    alarm: 'forced_open',
    alarm_type: 'force_unlock',
    alarm_label: 'Door forced open',
  });
  // The alarm cleared, then comes back: a new event.
  const [forced] = packets('events-door-state', 'access.data.v2.location.update');
  await w.notify(forced);
  assert.equal(w.events(TRIGGERS.ALARM).length, 2);
});

test('an unchanged state is not published again', async (t) => {
  const w = await world(t);
  const [forced] = packets('events-door-state', 'access.data.v2.location.update');
  await w.notify(forced);
  const count = w.fake.states.length;
  await w.notify(forced);
  await w.hub.refreshAndPublish();
  // The capture says what the REST read said (locked, open): nothing new.
  assert.equal(w.fake.states.length, count);
});

test('each access fires one event, though UniFi reports it twice', async (t) => {
  const w = await world(t);
  for (const packet of packets('events-interactive')) {
    await w.notify(packet);
  }
  const granted = w.events(TRIGGERS.GRANTED);
  const denied = w.events(TRIGGERS.DENIED);
  assert.equal(granted.length, 2, 'hand wave and remote, not four');
  assert.equal(denied.length, 1);
  assert.deepEqual(granted[0].data, {
    door: w.deviceId(DOORS.FRONT),
    door_name: 'Front door',
    user: 'Alice Martin',
    method: 'hand_wave',
    method_label: 'Hand wave',
    direction: 'entry',
  });
  assert.equal(denied[0].data.method, 'nfc');
  assert.equal(w.state(DOORS.FRONT, FEATURE_KEYS.LAST_ACCESS), 'Bob Durand · Remote · Entry');
  assert.equal(w.hub.history.length, 3);
});

test('an access reported only by logs.add (older firmware) still fires', async (t) => {
  const w = await world(t);
  const [logs] = packets('events-interactive', 'access.logs.add');
  await w.notify(logs);
  assert.equal(w.events(TRIGGERS.GRANTED).length, 1);
});

test('the doorbell fires, pulses 1 then 0, and is not doubled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = await world(t);
  const [ring] = packets('events-interactive', 'access.remote_view');
  await w.notify(ring);
  await w.notify({
    event: 'access.hw.door_bell',
    event_object_id: 'aabbcc000001',
    data: { door_id: DOORS.FRONT, door_name: 'Front door', request_id: 'another-id' },
  });
  const rings = w.events(TRIGGERS.DOORBELL);
  assert.equal(rings.length, 1);
  assert.deepEqual(rings[0].data, {
    door: w.deviceId(DOORS.FRONT),
    door_name: 'Front door',
    device_name: 'Reader front outside',
  });
  assert.equal(w.state(DOORS.FRONT, FEATURE_KEYS.DOORBELL), 1);
  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(w.state(DOORS.FRONT, FEATURE_KEYS.DOORBELL), 0);
});

test('a 2024 intercom call without door id is found by the reader', async (t) => {
  const w = await world(t);
  const [ring] = packets('events-historical', 'access.remote_view');
  await w.notify(ring);
  assert.equal(w.events(TRIGGERS.DOORBELL)[0].data.door, w.deviceId(DOORS.FRONT));
});

test('a door that rings gets a doorbell feature, kept across restarts', async (t) => {
  const w = await world(t);
  assert.ok(!featureKeysOf(w, DOORS.GARAGE).includes('doorbell'));
  await w.notify({
    event: 'access.hw.door_bell',
    data: { door_id: DOORS.GARAGE, door_name: 'Garage', request_id: 'r-garage' },
  });
  assert.ok(featureKeysOf(w, DOORS.GARAGE).includes('doorbell'));
  await w.app.stop();
  const again = await world(t, { dataDir: w.dataDir });
  assert.ok(featureKeysOf(again, DOORS.GARAGE).includes('doorbell'));
  assert.equal(again.hub.history.length, 0);
});

test('a door hub going offline and back fires the two events', async (t) => {
  const w = await world(t);
  const hubUpdate = (online) => ({
    event: 'access.data.v2.device.update',
    data: {
      id: 'aabbcc000004',
      device_type: 'UA-Hub-Door-Mini',
      online,
      location_id: DOORS.GARAGE,
    },
    meta: { object_type: 'device', target_field: ['online'], all_field: false },
  });
  await w.notify(hubUpdate(false));
  assert.equal(w.events(TRIGGERS.OFFLINE).length, 1);
  assert.equal(w.events(TRIGGERS.OFFLINE)[0].data.door_name, 'Garage');
  w.clock.advance(12 * 60_000);
  await w.notify(hubUpdate(false));
  assert.equal(w.events(TRIGGERS.OFFLINE).length, 1, 'once');
  await w.notify(hubUpdate(true));
  const online = w.events(TRIGGERS.ONLINE);
  assert.equal(online.length, 1);
  assert.equal(online[0].data.down_minutes, 12);
  // No event for the door offline since the start (Back door).
  assert.ok(!w.fake.sceneEvents.some((event) => event.data.door === w.deviceId(DOORS.BACK)));
});

test('a door added in UniFi Access appears after its first notification', async (t) => {
  const w = await world(t, { timings: { topologyDelayMs: 0 } });
  w.controller.doors.push({
    door_lock_relay_status: 'lock',
    door_position_status: 'close',
    extras: {},
    full_name: 'Home / Shed',
    id: '00000000-0000-0000-0000-0000000000aa',
    name: 'Shed',
    type: 'door',
  });
  w.controller.lockRules.set('00000000-0000-0000-0000-0000000000aa', { type: '', ended_time: 0 });
  await w.notify({
    event: 'access.data.v2.location.update',
    data: {
      id: '00000000-0000-0000-0000-0000000000aa',
      location_type: 'door',
      state: { lock: 'locked', dps: 'close' },
    },
  });
  assert.ok(await until(() => w.fake.discoveredDevices.some((device) => device.name === 'Shed')));
});

test('a door added after a configuration change still appears', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = await world(t);
  // A notification arms the topology read; the configuration changes before it runs.
  w.hub.scheduleTopology();
  w.controller.token = `${CONFIG.api_token}x`;
  await w.fake.configUpdated({ ...CONFIG, api_token: `${CONFIG.api_token}x` });
  await settle();
  w.controller.doors.push({
    door_lock_relay_status: 'lock',
    door_position_status: 'none',
    id: '00000000-0000-0000-0000-0000000000bb',
    name: 'Cellar',
    type: 'door',
  });
  w.controller.lockRules.set('00000000-0000-0000-0000-0000000000bb', { type: '', ended_time: 0 });
  await w.notify({ event: 'access.data.v2.device.delete', data: { id: 'aabbcc000003' } });
  t.mock.timers.tick(3_000);
  await settle();
  assert.ok(w.fake.discoveredDevices.some((device) => device.name === 'Cellar'));
});

test('adding a door in Gladys publishes its states again', async (t) => {
  const w = await world(t);
  const before = w.fake.states.length;
  await createAll(w);
  assert.ok(w.fake.states.length >= before + 11, 'every state of the three doors');
  assert.ok(w.fake.widgetRefreshes.includes('doors'));
});

test('a lost socket degrades the badge, its return reads everything again', async (t) => {
  const w = await world(t);
  const reads = () => w.controller.requests.filter((r) => r.path === '/doors').length;
  const before = reads();
  w.controller.socketsAccepted = false;
  w.controller.dropSockets();
  await settle();
  const garage = w.fake.transports
    .filter((entry) => entry.device_external_id === w.deviceId(DOORS.GARAGE))
    .at(-1);
  assert.equal(garage.degraded, true);
  assert.equal(
    garage.message.en,
    'Real-time notifications unavailable: the doors are read every minute.',
  );
  w.controller.socketsAccepted = true;
  w.hub.socket.reconnectNow();
  await settle();
  assert.equal(w.hub.socket.connected, true);
  assert.equal(reads(), before + 1, 'read again on reconnection');
  const after = w.fake.transports
    .filter((entry) => entry.device_external_id === w.deviceId(DOORS.GARAGE))
    .at(-1);
  assert.equal(after.degraded, undefined);
});

test('the console down: status, badges, and recovery', async (t) => {
  const w = await world(t);
  w.controller.online = false;
  await w.hub.refreshAndPublish();
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.en, /does not answer/);
  for (const doorId of Object.values(DOORS)) {
    const badge = w.fake.transports
      .filter((entry) => entry.device_external_id === w.deviceId(doorId))
      .at(-1);
    assert.equal(badge.transport, 'unreachable', doorId);
  }
  w.controller.online = true;
  await w.hub.refreshAndPublish();
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
});

test('a refused token or certificate is explained in the connection status', async (t) => {
  const refused = await world(t, { config: { ...CONFIG, api_token: 'wrong' } });
  assert.match(refused.fake.connectionStatus.message.fr, /Jeton d'API refusé/);
  const tls = await world(t, { config: { ...CONFIG, allow_self_signed: false } });
  assert.match(tls.fake.connectionStatus.message.en, /self-signed/);
  const empty = await world(t, { config: {} });
  assert.match(empty.fake.connectionStatus.message.en, /address of your UniFi console/);
  assert.equal(empty.fake.discoveredDevices.length, 0);
});

test('a firmware without lock rules: no lock rule feature', async (t) => {
  const w = await world(t, { controller: new FakeAccess({ lockRules: false }) });
  assert.deepEqual(featureKeysOf(w, DOORS.GARAGE), ['lock', 'door_position', 'last_access']);
  const reads = w.controller.requests.filter((r) => r.path.endsWith('/lock_rule')).length;
  await w.hub.refreshAndPublish();
  assert.equal(
    w.controller.requests.filter((r) => r.path.endsWith('/lock_rule')).length,
    reads,
    'not asked again',
  );
});

test('a lock rule notification updates the text, its silence reads the rule again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = await world(t);
  const until = Date.UTC(2026, 9, 12, 18, 30) / 1000;
  await w.notify({
    event: 'access.data.v2.location.update',
    data: {
      id: DOORS.GARAGE,
      location_type: 'door',
      state: { lock: 'unlocked', dps: 'close', remain_unlock: { type: 'custom', until } },
    },
  });
  assert.match(w.state(DOORS.GARAGE, FEATURE_KEYS.RULE), /^Unlocked for a while until /);
  // The rule ended: the next state does not mention it.
  await w.notify({
    event: 'access.data.v2.location.update',
    data: { id: DOORS.GARAGE, location_type: 'door', state: { lock: 'locked', dps: 'close' } },
  });
  t.mock.timers.tick(2_000);
  await settle();
  assert.equal(w.state(DOORS.GARAGE, FEATURE_KEYS.RULE), 'Normal');
});

test('the feature names and texts follow the configured language', async (t) => {
  const w = await world(t, { config: { ...CONFIG, language: 'de' } });
  const garage = w.fake.discoveredDevices.find((d) => d.name === 'Garage');
  assert.deepEqual(
    garage.features.map((f) => f.name),
    ['Schloss', 'Türposition', 'Verriegelungsregel', 'Letzter Zutritt'],
  );
  assert.equal(w.state(DOORS.GARAGE, FEATURE_KEYS.LAST_ACCESS), 'Noch kein Zutritt');
});

test('Gladys restarting: everything is sent again', async (t) => {
  const w = await world(t);
  const count = w.fake.states.length;
  await w.gladys.disconnect();
  await w.gladys.connect();
  await settle();
  assert.ok(w.fake.states.length >= count + 11);
});
