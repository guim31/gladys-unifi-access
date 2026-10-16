// -----------------------------------------------------------------------------
// The scene actions, and the safety rule of the series: whatever unlocks a
// door is disabled by default and never a switch nor a button. "Always
// locked" is safe and always allowed; ending it may unlock the door, so it
// is held to the same switch as the remote unlock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, DOORS, createWorld } from './helpers/world.js';

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

const unlockOn = { config: { ...CONFIG, allow_remote_unlock: true } };
const sent = (w, method, suffix) =>
  w.controller.requests.filter((r) => r.method === method && r.path.endsWith(suffix));

test('the remote unlock is refused by default, and nothing is sent', async (t) => {
  const w = await world(t);
  const ack = await w.fake.sceneAction('unlock_door', { door: w.deviceId(DOORS.FRONT) });
  assert.equal(ack.success, false);
  assert.match(ack.error, /Remote unlock is disabled/);
  assert.equal(sent(w, 'PUT', '/unlock').length, 0);
  assert.equal(w.controller.unlocks.length, 0);
});

test('enabled, the remote unlock is sent once, signed Gladys', async (t) => {
  const w = await world(t, unlockOn);
  const ack = await w.fake.sceneAction('unlock_door', { door: w.deviceId(DOORS.FRONT) });
  assert.deepEqual(ack, { success: true, data: { outputs: { door_name: 'Front door' } } });
  assert.deepEqual(w.controller.unlocks, [
    { id: DOORS.FRONT, body: { actor_id: 'gladys', actor_name: 'Gladys' } },
  ]);
});

test('no device feature can unlock a door', async (t) => {
  const w = await world(t, unlockOn);
  for (const device of w.fake.discoveredDevices) {
    for (const feature of device.features) {
      assert.equal(feature.read_only, true, feature.external_id);
      const ack = await w.fake.setValue(device, feature, 0);
      assert.equal(ack.success, false, 'no command handler');
    }
  }
  assert.equal(w.controller.unlocks.length, 0);
});

test('"Keep a door locked" works without the remote unlock', async (t) => {
  const w = await world(t);
  const ack = await w.fake.sceneAction('keep_door_locked', { door: w.deviceId(DOORS.GARAGE) });
  assert.deepEqual(ack, { success: true, data: { outputs: { door_name: 'Garage' } } });
  assert.deepEqual(sent(w, 'PUT', '/lock_rule')[0].body, { type: 'keep_lock' });
  assert.equal(w.state(DOORS.GARAGE, 'lock_rule'), 'Always locked');
});

test('ending "always locked" needs the remote unlock; ending "always unlocked" does not', async (t) => {
  const w = await world(t);
  await w.fake.sceneAction('keep_door_locked', { door: w.deviceId(DOORS.GARAGE) });
  const refused = await w.fake.sceneAction('end_lock_rule', { door: w.deviceId(DOORS.GARAGE) });
  assert.equal(refused.success, false);
  assert.match(refused.error, /Ending "always locked" may unlock the door/);
  assert.equal(sent(w, 'PUT', '/lock_rule').length, 1, 'only the keep_lock');

  // Set to "always unlocked" in UniFi Access: returning to normal locks it.
  w.controller.lockRules.set(DOORS.FRONT, { type: 'keep_unlock', ended_time: 0 });
  await w.hub.refreshAndPublish();
  const done = await w.fake.sceneAction('end_lock_rule', { door: w.deviceId(DOORS.FRONT) });
  assert.equal(done.success, true);
  assert.deepEqual(sent(w, 'PUT', '/lock_rule').at(-1).body, { type: 'reset' });

  const allowed = await world(t, unlockOn);
  await allowed.fake.sceneAction('keep_door_locked', { door: allowed.deviceId(DOORS.GARAGE) });
  const ended = await allowed.fake.sceneAction('end_lock_rule', {
    door: allowed.deviceId(DOORS.GARAGE),
  });
  assert.equal(ended.success, true);
});

test('an unknown door or a console down: a readable refusal', async (t) => {
  const w = await world(t);
  const unknown = await w.fake.sceneAction('keep_door_locked', { door: 'ext:other:door:x' });
  assert.match(unknown.error, /Unknown door/);
  w.controller.online = false;
  const down = await w.fake.sceneAction('keep_door_locked', { door: w.deviceId(DOORS.GARAGE) });
  assert.equal(down.success, false);
  assert.match(down.error, /does not answer/);
  assert.equal(w.fake.connectionStatus.connected, false);
});

test('"Test the connection" reports the doors, the socket and the unlock switch', async (t) => {
  const w = await world(t);
  const ack = await w.fake.action('test_connection', {});
  assert.equal(ack.success, true);
  assert.equal(
    ack.data.message.en,
    'Connected: 3 door(s), 5 device(s).\nReal-time notifications: connected.\nRemote unlock: disabled.',
  );
  assert.match(ack.data.message.fr, /^Connecté : 3 porte\(s\)/);
  const empty = await world(t, { config: {} });
  const missing = await empty.fake.action('test_connection', {});
  assert.match(missing.data.message.en, /address of your UniFi console/);
});
