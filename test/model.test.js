// -----------------------------------------------------------------------------
// The parsers of src/access/model.js, on the real captures of the fixtures.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALARMS,
  LOCK,
  METHODS,
  POSITION,
  RULES,
  accessMethod,
  alarmKind,
  epochMs,
  parseDevice,
  parseDoor,
  parseDoorState,
  parseLockRule,
  parseNotification,
} from '../src/access/model.js';
import { DOORS, fixture } from './helpers/fakeAccess.js';

const packets = (name, event) => fixture(name).filter((packet) => packet.event === event);

test('the doors of GET /doors', () => {
  const doors = fixture('doors').data.map(parseDoor);
  const garage = doors.find((door) => door.id === DOORS.GARAGE);
  assert.equal(garage.name, 'Garage');
  assert.equal(garage.lock, LOCK.LOCKED);
  assert.equal(garage.position, POSITION.OPEN);
  assert.equal(garage.hasPositionSensor, true);
  const front = doors.find((door) => door.id === DOORS.FRONT);
  assert.equal(front.position, null, 'door_position_status none: no sensor');
  assert.equal(front.hasPositionSensor, false);
  assert.equal(parseDoor({ id: 'x', type: 'gate_group' }), null);
  assert.equal(parseDoor(null), null);
});

test('the devices of GET /devices: hubs, doorbells, online', () => {
  const devices = fixture('devices').data.flat().map(parseDevice);
  const byId = Object.fromEntries(devices.map((device) => [device.id, device]));
  assert.equal(byId.aabbcc000001.hub, true, 'UA Hub');
  assert.equal(byId.aabbcc000001.doorbell, true, 'the UA Hub doorbell input');
  assert.equal(byId.aabbcc000002.hub, false, 'G2 Pro reader');
  assert.equal(byId.aabbcc000003.online, false);
  assert.equal(byId.aabbcc000004.hub, true, 'UA Hub Door Mini');
  assert.equal(byId.aabbcc000004.doorId, DOORS.GARAGE);
  assert.equal(byId.aabbcc000000.adopted, false);
});

test('the lock rules', () => {
  assert.deepEqual(parseLockRule({ type: '', ended_time: 0 }), { type: RULES.NORMAL, until: null });
  assert.deepEqual(parseLockRule({ type: 'keep_lock', ended_time: 1700000000 }), {
    type: RULES.KEEP_LOCK,
    until: 1700000000000,
  });
  assert.equal(parseLockRule({ type: 'reset' }).type, RULES.NORMAL);
  assert.equal(parseLockRule({ type: 'something_new' }).type, RULES.OTHER);
  assert.equal(epochMs(1786729410000), 1786729410000);
  assert.equal(epochMs(0), null);
  const state = parseDoorState({
    lock: 'locked',
    dps: 'close',
    remain_lock: { type: 'keep_lock', until: 1700000000, state: 'start' },
  });
  assert.deepEqual(state.rule, { type: RULES.KEEP_LOCK, until: 1700000000000 });
  assert.deepEqual(parseDoorState({ lock: 'locked', remain_unlock: null }).rule, {
    type: RULES.NORMAL,
    until: null,
  });
  assert.equal(parseDoorState({ lock: 'locked' }).rule, undefined, 'not mentioned');
});

test('a door forced open: the alarm, then its end', () => {
  const [forced, cleared] = packets('events-door-state', 'access.data.v2.location.update');
  const [update] = parseNotification(forced).filter((u) => u.kind === 'door_state');
  assert.equal(update.doorId, DOORS.GARAGE);
  assert.deepEqual(update.state.alarms, ['force_unlock']);
  assert.equal(update.state.lock, LOCK.LOCKED);
  assert.equal(update.state.position, POSITION.OPEN);
  assert.equal(alarmKind('force_unlock'), ALARMS.FORCED);
  const [after] = parseNotification(cleared).filter((u) => u.kind === 'door_state');
  assert.deepEqual(after.state.alarms, [], 'a complete report without alarms: cleared');
  assert.equal(after.state.lock, LOCK.UNLOCKED);
});

test('a door without position sensor reports none', () => {
  const [packet] = packets('events-corpus-2026', 'access.data.v2.location.update').filter(
    (p) => p.data.state,
  );
  const [update] = parseNotification(packet).filter((u) => u.kind === 'door_state');
  assert.equal(update.state.hasPositionSensor, false);
  assert.equal(update.state.position, null);
  assert.equal(update.state.unavailable, false);
});

test('a device update carries its door states and its online flag', () => {
  const updates = packets('events-door-state', 'access.data.v2.device.update').flatMap(
    parseNotification,
  );
  assert.ok(updates.some((u) => u.kind === 'device' && u.deviceId === 'aabbcc000004'));
  assert.ok(updates.some((u) => u.kind === 'door_state' && u.doorId === DOORS.GARAGE));
});

test('an access is read from insights and from its logs twin alike', () => {
  const [insights] = packets('events-interactive', 'access.logs.insights.add');
  const [logs] = packets('events-interactive', 'access.logs.add');
  const [a] = parseNotification(insights);
  const [b] = parseNotification(logs);
  for (const access of [a, b]) {
    assert.equal(access.kind, 'access');
    assert.equal(access.result, 'ACCESS');
    assert.equal(access.published, 1786729410000);
    assert.equal(accessMethod(access.provider), METHODS.HAND_WAVE);
    assert.equal(access.direction, 'entry');
    assert.deepEqual(access.doors, [{ id: 'aabbcc000001', name: 'Front door' }]);
    assert.equal(access.user, 'Alice Martin');
  }
  const denied = parseNotification(packets('events-interactive', 'access.logs.insights.add')[1]);
  assert.equal(denied[0].result, 'BLOCKED');
  assert.equal(accessMethod(denied[0].provider), METHODS.NFC);
});

test('the access methods, as UniFi names them', () => {
  const cases = {
    nfc: METHODS.NFC,
    NFC: METHODS.NFC,
    pin_code: METHODS.PIN,
    FACE: METHODS.FACE,
    wave: METHODS.HAND_WAVE,
    remote_through_uah: METHODS.REMOTE,
    mobile_tap: METHODS.MOBILE,
    bluetooth: METHODS.MOBILE,
    apple_pass: METHODS.WALLET,
    touch_pass: METHODS.WALLET,
    qr_code: METHODS.QR,
    license_plate: METHODS.PLATE,
    call: METHODS.INTERCOM,
    '': METHODS.OTHER,
    something: METHODS.OTHER,
  };
  for (const [provider, method] of Object.entries(cases)) {
    assert.equal(accessMethod(provider), method, provider);
  }
});

test('the doorbell: an intercom call, with or without door id', () => {
  const [recent] = parseNotification(packets('events-interactive', 'access.remote_view')[0]);
  assert.equal(recent.kind, 'doorbell');
  assert.equal(recent.doorId, DOORS.FRONT);
  const [old] = parseNotification(packets('events-historical', 'access.remote_view')[0]);
  assert.equal(old.doorId, null, '2024 firmware: no door_id');
  assert.equal(old.doorName, 'Front door');
  assert.deepEqual(old.deviceIds, ['aabbcc000002', 'aabbcc000001']);
  const [hardware] = parseNotification({
    event: 'access.hw.door_bell',
    event_object_id: 'aabbcc000001',
    data: { door_id: DOORS.FRONT, door_name: 'Front door', request_id: 'r1' },
  });
  assert.equal(hardware.doorId, DOORS.FRONT);
});

test('unknown and malformed packets are ignored', () => {
  assert.deepEqual(parseNotification({ event: 'access.base.info', data: {} }), []);
  assert.deepEqual(parseNotification('Hello'), []);
  assert.deepEqual(parseNotification({ event: 'access.logs.add', data: null }), []);
  assert.deepEqual(parseNotification(packets('events-tamper', 'access.tamper_resistant')[0]), []);
  // An insights entry that is not an unlock (a future event type).
  assert.deepEqual(
    parseNotification({
      event: 'access.logs.insights.add',
      data: { event_type: 'access.visitor.created', result: 'ACCESS' },
    }),
    [],
  );
});
