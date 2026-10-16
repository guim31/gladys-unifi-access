// -----------------------------------------------------------------------------
// What the integration writes at the default level (info): the lifecycle
// only. A normal cycle (reads, notifications, accesses) writes nothing, a
// failure that repeats is logged once, and its end once. Never the token.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, TOKEN, createWorld, packets } from './helpers/world.js';

/** Capture the lines of the SDK logger at `level`. */
function captureLogs(t, level = 'info') {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  const lines = [];
  const record =
    (stream) =>
    (...args) =>
      lines.push({
        stream,
        text: args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' '),
      });
  t.mock.method(console, 'log', record('out'));
  t.mock.method(console, 'error', record('err'));
  t.mock.method(console, 'warn', record('err'));
  return {
    lines,
    clear: () => lines.splice(0),
    texts: () => lines.map((line) => line.text),
  };
}

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

test('a normal cycle writes nothing at info', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  assert.ok(
    logs.texts().some((text) => /connected, 3 door/.test(text)),
    'the start is logged',
  );
  logs.clear();
  for (let i = 0; i < 3; i += 1) {
    await w.hub.refreshAndPublish();
  }
  for (const packet of [
    ...packets('events-interactive'),
    ...packets('events-corpus-2026'),
    ...packets('events-official-socket'),
  ]) {
    await w.notify(packet);
  }
  assert.deepEqual(logs.texts(), []);
});

test('the console down is logged once, and once when it is back', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  logs.clear();
  w.controller.online = false;
  for (let i = 0; i < 5; i += 1) {
    await w.hub.refreshAndPublish();
  }
  assert.equal(logs.lines.length, 1, logs.texts().join('\n'));
  assert.equal(logs.lines[0].stream, 'err');
  logs.clear();
  w.controller.online = true;
  await w.hub.refreshAndPublish();
  await w.hub.refreshAndPublish();
  assert.equal(logs.lines.length, 1, logs.texts().join('\n'));
  assert.match(logs.lines[0].text, /connection restored/);
});

test('a refused token is logged once, never written', async (t) => {
  const logs = captureLogs(t, 'debug');
  const wrong = 'refused-token-value-1234';
  const w = await world(t, { config: { ...CONFIG, api_token: wrong } });
  for (let i = 0; i < 3; i += 1) {
    await w.hub.refreshAndPublish();
  }
  const warnings = logs.lines.filter((line) => line.stream === 'err');
  assert.ok(warnings.length >= 1);
  const text = logs.texts().join('\n');
  assert.ok(!text.includes(wrong), 'never the token');
  assert.equal(
    warnings.filter((line) => /token refused/.test(line.text) && /GET/.test(line.text)).length,
    1,
    'the REST refusal once',
  );
});

test('no secret of the configuration appears in the logs, even in debug', async (t) => {
  const logs = captureLogs(t, 'debug');
  const w = await world(t, { config: { ...CONFIG, allow_remote_unlock: true } });
  for (const packet of packets('events-interactive')) {
    await w.notify(packet);
  }
  await w.fake.sceneAction('unlock_door', {
    door: w.deviceId('00000000-0000-0000-0000-000000000006'),
  });
  await w.fake.action('test_connection', {});
  w.controller.online = false;
  await w.hub.refreshAndPublish();
  const text = logs.texts().join('\n');
  assert.ok(text.length > 0);
  assert.ok(!text.includes(TOKEN), 'never the token');
  assert.ok(!/Bearer/.test(text), 'never an Authorization header');
});

test('a user command writes one line', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  logs.clear();
  await w.fake.sceneAction('keep_door_locked', {
    door: w.deviceId('00000000-0000-0000-0000-00000000000e'),
  });
  assert.deepEqual(logs.texts().length, 1);
  assert.match(logs.texts()[0], /Garage": always locked \(scene\)/);
});

test('LOG_LEVEL=debug shows the notifications', async (t) => {
  const logs = captureLogs(t, 'debug');
  const w = await world(t);
  for (const packet of packets('events-interactive', 'access.logs.insights.add')) {
    await w.notify(packet);
  }
  assert.match(logs.texts().join('\n'), /\[DEBUG\].*Access granted at "Front door"/);
});
