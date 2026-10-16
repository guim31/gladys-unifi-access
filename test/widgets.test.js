// -----------------------------------------------------------------------------
// The `doors` widget: content valid for the core vocabulary and budget
// (validateWidgetContent), every door or one, the history, the buttons —
// and never an unlock button.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { CONFIG, DOORS, createWorld, packets } from './helpers/world.js';

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

async function content(w, settings = {}, language = 'en') {
  const ack = await w.fake.widgetGet('doors', { settings, language, units: 'metric' });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(validateWidgetContent(ack.data.content), [], 'rendered exactly as sent');
  return ack.data.content;
}

const ofType = (c, type) => c.components.filter((component) => component.type === type);

test('every door: one status row each, no button', async (t) => {
  const w = await world(t);
  const c = await content(w);
  const [status] = ofType(c, 'status');
  assert.deepEqual(
    status.items.map((item) => [item.label, item.value]),
    [
      ['Garage', 'Locked · open'],
      ['Back door', 'Offline'],
      ['Front door', 'Locked'],
    ],
  );
  assert.equal(ofType(c, 'button').length, 0);
  assert.match(ofType(c, 'text')[0].text, /No access recorded/);
});

test('the last accesses, with the door when several are shown', async (t) => {
  const w = await world(t);
  for (const packet of packets('events-interactive')) {
    await w.notify(packet);
  }
  const c = await content(w, {}, 'fr');
  const [list] = ofType(c, 'card-list');
  assert.equal(list.items.length, 3);
  assert.deepEqual(list.items[1], {
    title: 'Alice Martin',
    subtitle: 'Front door · Badge NFC · Entrée',
    date: '2026-08-14T17:46:05.000Z',
    badge: { text: 'Refusé', color: 'danger' },
  });
  const one = await content(w, { door: w.deviceId(DOORS.FRONT) });
  assert.equal(ofType(one, 'card-list')[0].items[0].subtitle, 'Remote · Entry');
  const garage = await content(w, { door: w.deviceId(DOORS.GARAGE) });
  assert.equal(ofType(garage, 'card-list').length, 0, 'no access at the garage');
});

test('an alarm shows first on its row', async (t) => {
  const w = await world(t);
  const [forced] = packets('events-door-state', 'access.data.v2.location.update');
  await w.notify(forced);
  const [status] = ofType(await content(w), 'status');
  assert.deepEqual(status.items[0], {
    label: 'Garage',
    value: 'Door forced open',
    color: 'danger',
    icon: 'alert-triangle',
  });
});

test('one door: "Always locked", then "Normal schedule" only when allowed', async (t) => {
  const w = await world(t);
  const settings = { door: w.deviceId(DOORS.GARAGE) };
  let buttons = ofType(await content(w, settings), 'button');
  assert.deepEqual(
    buttons.map((b) => b.action.key),
    ['keep_locked'],
  );
  assert.equal(buttons[0].action.confirm, true);
  const ack = await w.fake.widgetAction('doors', 'keep_locked', buttons[0].action.params, {
    settings,
  });
  assert.equal(ack.success, true);
  assert.equal(ack.data.message.fr, "Garage reste verrouillée jusqu'à « Planning normal ».");
  buttons = ofType(await content(w, settings), 'button');
  assert.equal(buttons[0].icon, 'check-circle', 'the active choice is told by its icon');
  assert.equal(buttons.length, 1, 'no way out of "always locked" without the unlock switch');

  const allowed = await world(t, { config: { ...CONFIG, allow_remote_unlock: true } });
  const s2 = { door: allowed.deviceId(DOORS.GARAGE) };
  await allowed.fake.widgetAction('doors', 'keep_locked', { door: s2.door }, { settings: s2 });
  const both = ofType(await content(allowed, s2), 'button');
  assert.deepEqual(
    both.map((b) => b.action.key),
    ['keep_locked', 'end_rule'],
  );
});

test('never an unlock button, whatever the configuration', async (t) => {
  const w = await world(t, { config: { ...CONFIG, allow_remote_unlock: true } });
  for (const doorId of Object.values(DOORS)) {
    for (const button of ofType(await content(w, { door: w.deviceId(doorId) }), 'button')) {
      assert.ok(!/unlock/i.test(button.action.key), button.action.key);
      assert.ok(!/unlock/i.test(button.label), button.label);
    }
  }
  const ack = await w.fake.widgetAction('doors', 'unlock', { door: w.deviceId(DOORS.FRONT) }, {});
  assert.equal(ack.success, false);
  assert.equal(w.controller.unlocks.length, 0);
});

test('the messages: not configured, unknown door', async (t) => {
  const empty = await world(t, { config: {} });
  assert.match(ofType(await content(empty), 'text')[0].text, /address of your UniFi console/);
  const w = await world(t);
  assert.match(
    ofType(await content(w, { door: 'ext:test-integration:door:gone' }), 'text')[0].text,
    /no longer in UniFi Access/,
  );
});
