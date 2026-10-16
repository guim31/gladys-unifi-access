// -----------------------------------------------------------------------------
// What the UniFi Access API says, in the integration's own words.
//
// The vocabulary comes from real captures (test/fixtures/access, from
// hjdhjd/unifi-access) and from the Home Assistant integration and its
// library py-unifi-access:
//   - REST `GET /doors`: `door_lock_relay_status` lock|unlock,
//     `door_position_status` open|close|none (none: no position sensor);
//   - notifications `access.data.v2.location.update` (`data.state`) and
//     `access.data.v2.device.update` (`data.location_states[]`): `lock`
//     locked|unlocked, `dps` open|close|none, `dps_connected`, `alarms`
//     ([{ type: "force_unlock" }] while in force, absent once cleared),
//     `is_unavailable`, `remain_lock` / `remain_unlock` (temporary rule);
//   - the legacy `access.data.device.location_update_v2` (same `state`);
//   - doorbell: `access.remote_view` (intercom call) and `access.hw.door_bell`;
//   - accesses: `access.logs.insights.add` and, a few milliseconds later, the
//     same access again as `access.logs.add` (deduplicated by the hub).
//
// Every parser here is pure: the hub (src/hub.js) resolves the doors and
// keeps the state.
// -----------------------------------------------------------------------------

export const LOCK = Object.freeze({ LOCKED: 'locked', UNLOCKED: 'unlocked' });
export const POSITION = Object.freeze({ OPEN: 'open', CLOSED: 'closed' });

// Temporary lock rules (`PUT /doors/:id/lock_rule` types), plus `normal`.
export const RULES = Object.freeze({
  NORMAL: 'normal',
  KEEP_LOCK: 'keep_lock',
  KEEP_UNLOCK: 'keep_unlock',
  CUSTOM: 'custom', // unlocked for a while
  SCHEDULE: 'schedule', // an unlock schedule is running
  LOCK_EARLY: 'lock_early', // the running unlock schedule was ended early
  LOCK_NOW: 'lock_now',
  OTHER: 'other',
});

// Door alarms (scene trigger filter values: permanent once published).
export const ALARMS = Object.freeze({
  FORCED: 'forced_open',
  HELD: 'held_open',
  OTHER: 'other',
});

// Access methods (scene trigger filter values: permanent once published).
export const METHODS = Object.freeze({
  NFC: 'nfc',
  PIN: 'pin',
  FACE: 'face',
  HAND_WAVE: 'hand_wave',
  MOBILE: 'mobile',
  REMOTE: 'remote',
  QR: 'qr',
  WALLET: 'wallet',
  PLATE: 'plate',
  INTERCOM: 'intercom',
  OTHER: 'other',
});

export const DIRECTIONS = Object.freeze({ ENTRY: 'entry', EXIT: 'exit' });

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const list = (value) => (Array.isArray(value) ? value : isObject(value) ? [value] : []);

/** Door names are compared as UniFi writes them (NFC, trimmed), case-insensitively. */
export const sameName = (a, b) =>
  Boolean(a) &&
  Boolean(b) &&
  text(a).normalize('NFC').toLowerCase() === text(b).normalize('NFC').toLowerCase();

export function lockOf(value) {
  const word = text(value).toLowerCase();
  if (word === 'lock' || word === 'locked') {
    return LOCK.LOCKED;
  }
  if (word === 'unlock' || word === 'unlocked') {
    return LOCK.UNLOCKED;
  }
  return null;
}

/** `open` / `closed`, null when the door has no position sensor. */
export function positionOf(value) {
  const word = text(value).toLowerCase();
  if (word === 'open') {
    return POSITION.OPEN;
  }
  if (word === 'close' || word === 'closed') {
    return POSITION.CLOSED;
  }
  return null;
}

/** A door of `GET /doors`, or null when it is not a door. */
export function parseDoor(raw) {
  if (!isObject(raw) || !text(raw.id)) {
    return null;
  }
  if (raw.type && raw.type !== 'door') {
    return null;
  }
  const position = positionOf(raw.door_position_status);
  return {
    id: text(raw.id),
    name: text(raw.name).normalize('NFC') || text(raw.full_name) || text(raw.id),
    fullName: text(raw.full_name),
    lock: lockOf(raw.door_lock_relay_status),
    position,
    hasPositionSensor: position !== null,
  };
}

const HUB_TYPE = /^(UAH|UA-HUB|UA-ULTRA|UA-INTERCOM|UA-LITE|UA-GATE)/i;

/** A device of `GET /devices`, or null. */
export function parseDevice(raw) {
  if (!isObject(raw) || !text(raw.id)) {
    return null;
  }
  const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities : [];
  const type = text(raw.type);
  const online =
    typeof raw.is_online === 'boolean'
      ? raw.is_online
      : typeof raw.is_connected === 'boolean'
        ? raw.is_connected
        : null;
  return {
    id: text(raw.id),
    type,
    name: text(raw.alias) || text(raw.name) || type,
    doorId: text(raw.location_id) || null,
    online,
    adopted: raw.is_adopted !== false,
    // The device that drives the lock: its loss takes the door offline.
    hub:
      capabilities.includes('is_hub') ||
      capabilities.includes('identity_is_hub') ||
      HUB_TYPE.test(type),
    doorbell: capabilities.includes('door_bell') || /INTERCOM/i.test(type),
  };
}

const RULE_TYPES = new Set(Object.values(RULES));

/** Normalize a lock rule type: '' and `reset` mean no temporary rule. */
export function ruleType(value) {
  const word = text(value).toLowerCase();
  if (!word || word === 'reset' || word === 'none') {
    return RULES.NORMAL;
  }
  return RULE_TYPES.has(word) ? word : RULES.OTHER;
}

/** Seconds or milliseconds since the epoch → milliseconds, null for 0/none. */
export function epochMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }
  return number < 1e12 ? number * 1000 : number;
}

/** The answer of `GET /doors/:id/lock_rule`. */
export function parseLockRule(raw) {
  const type = ruleType(raw?.type);
  return { type, until: type === RULES.NORMAL ? null : epochMs(raw?.ended_time) };
}

/** The lock rule carried by a notification state; undefined when it says nothing. */
function socketRule(state) {
  for (const key of ['remain_lock', 'remain_unlock']) {
    if (key in state) {
      const rule = state[key];
      if (!isObject(rule)) {
        return { type: RULES.NORMAL, until: null };
      }
      const type = ruleType(rule.type);
      return { type, until: type === RULES.NORMAL ? null : epochMs(rule.until ?? rule.ended_time) };
    }
  }
  return undefined;
}

/** Kind of a door alarm type. Only `force_unlock` has been seen on the wire. */
export function alarmKind(type) {
  const word = text(type).toLowerCase();
  if (/force/.test(word)) {
    return ALARMS.FORCED;
  }
  if (/held|timeout|too_long|keep_open|left_open/.test(word)) {
    return ALARMS.HELD;
  }
  return ALARMS.OTHER;
}

/**
 * A door state of a notification (`data.state` or a `location_states` entry).
 * Each member is undefined when the notification does not state it.
 */
export function parseDoorState(state) {
  if (!isObject(state)) {
    return null;
  }
  const result = {};
  if ('lock' in state) {
    result.lock = lockOf(state.lock) ?? undefined;
  }
  if ('dps' in state || 'dps_connected' in state) {
    const position = positionOf(state.dps);
    // `dps: none` or `dps_connected: false`: no sensor wired.
    result.hasPositionSensor = state.dps_connected === false ? false : position !== null;
    result.position = result.hasPositionSensor ? position : null;
  }
  if (Array.isArray(state.alarms)) {
    result.alarms = state.alarms.map((alarm) => text(alarm?.type)).filter(Boolean);
  } else if ('lock' in state && 'dps' in state) {
    // A complete report without `alarms`: no alarm in force (the controller
    // omits the member once the alarm clears).
    result.alarms = [];
  }
  if (typeof state.is_unavailable === 'boolean') {
    result.unavailable = state.is_unavailable;
  }
  const rule = socketRule(state);
  if (rule) {
    result.rule = rule;
  }
  return result;
}

export function accessMethod(provider) {
  const word = text(provider).toLowerCase();
  const rules = [
    [/^nfc|card/, METHODS.NFC],
    [/pin/, METHODS.PIN],
    [/face/, METHODS.FACE],
    [/wave|hand/, METHODS.HAND_WAVE],
    [/touch_?pass|wallet|apple|google/, METHODS.WALLET],
    [/remote|api|web|admin/, METHODS.REMOTE],
    [/mobile|bluetooth|ble|tap|app/, METHODS.MOBILE],
    [/qr/, METHODS.QR],
    [/lpr|plate|license/, METHODS.PLATE],
    [/call|intercom|bell|visitor/, METHODS.INTERCOM],
  ];
  for (const [pattern, method] of rules) {
    if (pattern.test(word)) {
      return method;
    }
  }
  return METHODS.OTHER;
}

export function directionOf(value) {
  const word = text(value).toLowerCase();
  if (word === 'entry' || word === 'in' || word === 'enter') {
    return DIRECTIONS.ENTRY;
  }
  if (word === 'exit' || word === 'out') {
    return DIRECTIONS.EXIT;
  }
  return '';
}

const NOT_A_DEVICE = new Set([
  'door',
  'device_config',
  'reason_code',
  'three_button_method',
  'floor',
  'building',
  'user_status',
  'unlock_source',
  'nfc',
  'nfc_id',
  'opened_method',
  'opened_direction',
  'authentication',
  'user',
  'policy',
  'camera',
  'camera_capture',
  'reader_capture',
]);

const refOf = (entry) => ({ id: text(entry?.id), name: text(entry?.display_name) });

const userOf = (actor) => {
  const name = text(actor?.display_name);
  return name && name.toUpperCase() !== 'N/A' ? name : '';
};

function insightsAccess(packet) {
  const data = packet.data;
  const metadata = isObject(data.metadata) ? data.metadata : {};
  const type = text(data.event_type);
  if (type && !type.startsWith('access.door.unlock')) {
    return null;
  }
  const authentication = isObject(metadata.authentication) ? metadata.authentication : {};
  const provider =
    text(authentication.credential_provider) || text(authentication.display_name) || '';
  return {
    result: text(data.result).toUpperCase(),
    doors: list(metadata.door).map(refOf),
    devices: [
      ...list(metadata.device).map(refOf),
      ...list(metadata.device_ua_hub).map(refOf),
    ].filter((ref) => ref.id),
    user: userOf(metadata.actor),
    provider,
    direction: directionOf(list(metadata.opened_direction)[0]?.display_name),
    published: epochMs(data.published),
    message: text(data.message),
  };
}

function logsAccess(packet) {
  const source = isObject(packet.data._source)
    ? packet.data._source
    : isObject(packet.data.source)
      ? packet.data.source
      : null;
  if (!source) {
    return null;
  }
  const event = isObject(source.event) ? source.event : {};
  const type = text(event.type);
  if (type && !type.startsWith('access.door.unlock')) {
    return null;
  }
  const targets = list(source.target);
  return {
    result: text(event.result).toUpperCase(),
    doors: targets.filter((t) => t?.type === 'door').map(refOf),
    devices: targets
      .filter((t) => t && !NOT_A_DEVICE.has(String(t.type).toLowerCase()))
      .map(refOf)
      .filter((ref) => ref.id),
    user: userOf(source.actor),
    provider: text(source.authentication?.credential_provider),
    direction: directionOf(
      targets.find((t) => t?.type === 'device_config' && t.id === 'door_entry_method')
        ?.display_name,
    ),
    published: epochMs(event.published),
    message: text(event.display_message),
  };
}

/**
 * One notification packet → the updates it carries, in the hub's words.
 * Unknown events → [].
 * @returns {Array<object>}
 */
export function parseNotification(packet) {
  if (!isObject(packet) || typeof packet.event !== 'string') {
    return [];
  }
  const data = isObject(packet.data) ? packet.data : null;
  switch (packet.event) {
    case 'access.data.v2.location.update':
    case 'access.data.device.location_update_v2': {
      if (!data || (data.location_type && data.location_type !== 'door')) {
        return [];
      }
      const updates = [];
      if (Array.isArray(data.device_ids)) {
        updates.push({
          kind: 'door_devices',
          doorId: text(data.id),
          deviceIds: data.device_ids.map(text).filter(Boolean),
        });
      }
      const state = parseDoorState(data.state);
      if (state) {
        updates.push({ kind: 'door_state', doorId: text(data.id), state });
      }
      return updates.filter((update) => update.doorId);
    }
    case 'access.data.v2.device.update': {
      if (!data || !text(data.id)) {
        return [];
      }
      const updates = [
        {
          kind: 'device',
          deviceId: text(data.id),
          doorId: text(data.location_id) || null,
          online: typeof data.online === 'boolean' ? data.online : null,
        },
      ];
      for (const entry of Array.isArray(data.location_states) ? data.location_states : []) {
        const state = parseDoorState(entry);
        if (state && text(entry.location_id)) {
          updates.push({ kind: 'door_state', doorId: text(entry.location_id), state });
        }
      }
      return updates;
    }
    case 'access.data.device.update':
      // The legacy device record: only its door matters here.
      return data && text(data.unique_id) && text(data.location_id ?? data.door?.unique_id)
        ? [
            {
              kind: 'device',
              deviceId: text(data.unique_id),
              doorId: text(data.location_id ?? data.door?.unique_id),
              online: null,
            },
          ]
        : [];
    case 'access.data.location.update':
      // The legacy twin of every v2 location update: only a rename matters.
      return data && data.location_type === 'door' && text(data.unique_id)
        ? [{ kind: 'door_name', doorId: text(data.unique_id), name: text(data.name) }]
        : [];
    case 'access.data.device.delete':
    case 'access.data.v2.device.delete':
    case 'access.data.location.delete':
      // Doors or devices removed: read the site again.
      return [{ kind: 'topology' }];
    case 'access.remote_view':
      return data
        ? [
            {
              kind: 'doorbell',
              requestId: text(data.request_id),
              doorId: text(data.door_id) || null,
              deviceIds: [text(data.device_id), text(data.connected_uah_id)].filter(Boolean),
              doorName: text(data.door_name),
              deviceName: text(data.device_name),
            },
          ]
        : [];
    case 'access.hw.door_bell':
      return data
        ? [
            {
              kind: 'doorbell',
              requestId: text(data.request_id),
              doorId: text(data.door_id) || null,
              deviceIds: [text(packet.event_object_id)].filter(Boolean),
              doorName: text(data.door_name),
              deviceName: '',
            },
          ]
        : [];
    case 'access.logs.insights.add': {
      const access = data ? insightsAccess(packet) : null;
      return access?.result
        ? [{ kind: 'access', source: 'insights', hubId: text(packet.event_object_id), ...access }]
        : [];
    }
    case 'access.logs.add': {
      const access = data ? logsAccess(packet) : null;
      return access?.result
        ? [{ kind: 'access', source: 'logs', hubId: text(packet.event_object_id), ...access }]
        : [];
    }
    default:
      return [];
  }
}
