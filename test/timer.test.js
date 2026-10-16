// -----------------------------------------------------------------------------
// The reading timer of the container. Gladys never polls a device published
// with should_poll: false (and never polls the devices created without
// should_poll, GladysAssistant/Gladys#3198): the doors must be read by the
// hub's own timer, with no onPoll at all — every 5 minutes while the
// notification socket brings the changes, every minute without it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_KEYS } from '../src/devices.js';
import { DOORS, FakeAccess, createAll, createWorld, settle } from './helpers/world.js';

const doorReads = (controller) => controller.requests.filter((r) => r.path === '/doors').length;

test('the internal timer reads the doors without any onPoll from Gladys', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const controller = new FakeAccess();
  const w = await createWorld({ controller, timers: true });
  t.after(() => w.app.stop());
  // Gladys is never asked to poll: no fake.poll() anywhere in this test.
  await createAll(w);
  assert.equal(w.fake.discoveredDevices[0].should_poll, false, 'Gladys is not asked to poll');
  assert.equal(w.hub.socket.connected, true);

  const before = doorReads(controller);
  // A change the socket did not report (an event lost): the timer catches it.
  controller.door(DOORS.GARAGE).door_lock_relay_status = 'unlock';
  t.mock.timers.tick(5 * 60_000);
  await settle();
  assert.equal(doorReads(controller) - before, 1, 'one read per 5 minutes with the socket');
  assert.equal(w.state(DOORS.GARAGE, FEATURE_KEYS.LOCK), 0);
  controller.door(DOORS.GARAGE).door_lock_relay_status = 'lock';
  t.mock.timers.tick(5 * 60_000);
  await settle();
  assert.equal(w.state(DOORS.GARAGE, FEATURE_KEYS.LOCK), 1);
  assert.ok(!w.fake.wsMessages.some((message) => /poll/i.test(message.type)), 'no poll ack');
});

test('without the socket, the doors are read every minute', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const controller = new FakeAccess();
  controller.socketsAccepted = false;
  const w = await createWorld({ controller, timers: true });
  t.after(() => w.app.stop());
  assert.equal(w.hub.socket.connected, false);
  const before = doorReads(controller);
  for (let minute = 0; minute < 3; minute += 1) {
    t.mock.timers.tick(60_000);
    await settle();
  }
  assert.equal(doorReads(controller) - before, 3);
});

test('the socket is reopened with a growing delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const controller = new FakeAccess();
  controller.socketsAccepted = false;
  const w = await createWorld({ controller, timers: true });
  t.after(() => w.app.stop());
  const attempts = () => controller.sockets.length;
  const first = attempts();
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(attempts(), first + 1, 'after 1 s');
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(attempts(), first + 1, 'not after 1 s more');
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(attempts(), first + 2, 'after 2 s');
  controller.socketsAccepted = true;
  t.mock.timers.tick(4_000);
  await settle();
  assert.equal(w.hub.socket.connected, true);
});

test('a silent socket is closed by the ping and reopened', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const controller = new FakeAccess();
  const w = await createWorld({ controller, timers: true });
  t.after(() => w.app.stop());
  const [socket] = controller.openSockets;
  socket.ping = () => {}; // never answered: no pong
  t.mock.timers.tick(30_000);
  await settle();
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(socket.readyState, 3, 'terminated');
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(controller.openSockets.length, 1, 'a new socket');
  assert.notEqual(controller.openSockets[0], socket);
});

test('the timers stop with the integration', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const controller = new FakeAccess();
  const w = await createWorld({ controller, timers: true });
  await w.app.stop();
  const before = controller.requests.length;
  const sockets = controller.sockets.length;
  t.mock.timers.tick(60 * 60_000);
  await settle();
  assert.equal(controller.requests.length, before);
  assert.equal(controller.sockets.length, sockets);
});
