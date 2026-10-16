// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, a fake UniFi Access
// controller, a temporary /data and a manual clock, with the integration
// wired on top through registerHandlers. No timer runs unless `timers: true`
// (with node:test mock timers): the tests read the console with
// `world.hub.refreshAndPublish()` and deliver notifications with `world.notify`.
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { Store } from '../../src/store.js';
import { DOORS, FakeAccess, TOKEN, fixture } from './fakeAccess.js';

// The integration logs the lifecycle; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

export const HOST = '192.0.2.1';

export const CONFIG = Object.freeze({
  host: HOST,
  api_token: TOKEN,
  allow_self_signed: true,
  language: 'en',
});

/** A manual clock. */
export function createClock(start = Date.UTC(2026, 9, 12, 10, 0, 0)) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

/** Let the fake sockets and the async handlers settle. */
export async function settle() {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * @param {object} [options]
 * @param {FakeAccess} [options.controller]
 * @param {object} [options.config] raw integration config
 * @param {Array} [options.devices] devices already created in Gladys
 * @param {boolean} [options.connect]
 */
export async function createWorld({
  clock = createClock(),
  controller = new FakeAccess(),
  config = CONFIG,
  devices = [],
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-unifi-access-')),
  timings = {},
  socketTimings = {},
  timers = false,
} = {}) {
  const gladys = createFakeGladys({ config: { ...config }, devices });
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    transport: controller.transport,
    timers,
    timings,
    socketTimings,
    now: clock.now,
  });
  const world = {
    gladys,
    fake: gladys.fake,
    controller,
    app,
    hub: app.hub,
    clock,
    dataDir,
    /** The controller sends a notification; resolves once handled. */
    async notify(packet) {
      controller.emit(packet);
      await settle();
    },
    deviceId: (doorId) => gladys.externalIds('door', doorId).device,
    featureId: (doorId, key) => gladys.externalIds('door', doorId).feature(key),
    state: (doorId, key) => gladys.fake.lastState(gladys.externalIds('door', doorId).feature(key)),
    events: (key) => gladys.fake.sceneEvents.filter((event) => event.key === key),
  };
  if (connect) {
    await gladys.connect();
    await app.ready;
    await settle();
  }
  return world;
}

/** Add every discovered door in Gladys, as the user would. */
export async function createAll(world) {
  for (const device of world.fake.discoveredDevices) {
    await world.fake.deviceCreated(device);
  }
}

/** The packets of a fixture file, optionally only one event. */
export const packets = (name, event) =>
  fixture(name).filter((packet) => event === undefined || packet.event === event);

export { DOORS, FakeAccess, TOKEN, fixture };
