// -----------------------------------------------------------------------------
// One Gladys device per UniFi Access door.
//
// Identity: the door id of UniFi Access (a UUID that survives renames and
// device replacements), never its name.
//
// Features (category/type couples of the core table, see
// test/gladys-rules.test.js), all read-only — nothing here can unlock a door:
//   - lock: lock/state, 1 locked, 0 unlocked (LOCK.STATE of the core). Not
//     lock/binary: that couple is a command the dashboard renders as a switch;
//   - door position: opening-sensor/binary, 1 closed, 0 open (the core's
//     OPENING_SENSOR_STATE, the reverse of the other detectors), only on a
//     door whose position sensor (DPS) is wired;
//   - doorbell: doorbell/ring, a 1 → 0 pulse at each ring, only on a door
//     with a doorbell (reader Pro, intercom, hub with a doorbell input);
//   - lock rule: text/text, the temporary rule (normal, always locked…);
//   - last access: text/text, who, how, which way.
//
// Online/offline is the transport badge of the device (src/hub.js), not a
// feature: Gladys has no connectivity couple.
//
// The devices are published with should_poll: false: the container reads the
// doors itself (notification socket + its own timer, src/hub.js).
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { LOCK, POSITION } from './access/model.js';
import { ACCESS_TEXT, accessText, pick, ruleText } from './texts.js';

export const DEVICE_TYPE = 'door';
export const DOOR_PARAM = 'UNIFI_ACCESS_DOOR';

// Suffixes of the feature external ids: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  LOCK: 'lock',
  POSITION: 'door_position',
  DOORBELL: 'doorbell',
  RULE: 'lock_rule',
  LAST_ACCESS: 'last_access',
});

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    [FEATURE_KEYS.LOCK]: 'Lock',
    [FEATURE_KEYS.POSITION]: 'Door position',
    [FEATURE_KEYS.DOORBELL]: 'Doorbell',
    [FEATURE_KEYS.RULE]: 'Lock rule',
    [FEATURE_KEYS.LAST_ACCESS]: 'Last access',
  },
  fr: {
    [FEATURE_KEYS.LOCK]: 'Verrou',
    [FEATURE_KEYS.POSITION]: 'Position de la porte',
    [FEATURE_KEYS.DOORBELL]: 'Sonnette',
    [FEATURE_KEYS.RULE]: 'Règle de verrouillage',
    [FEATURE_KEYS.LAST_ACCESS]: 'Dernier accès',
  },
  de: {
    [FEATURE_KEYS.LOCK]: 'Schloss',
    [FEATURE_KEYS.POSITION]: 'Türposition',
    [FEATURE_KEYS.DOORBELL]: 'Türklingel',
    [FEATURE_KEYS.RULE]: 'Verriegelungsregel',
    [FEATURE_KEYS.LAST_ACCESS]: 'Letzter Zutritt',
  },
  es: {
    [FEATURE_KEYS.LOCK]: 'Cerradura',
    [FEATURE_KEYS.POSITION]: 'Posición de la puerta',
    [FEATURE_KEYS.DOORBELL]: 'Timbre',
    [FEATURE_KEYS.RULE]: 'Regla de bloqueo',
    [FEATURE_KEYS.LAST_ACCESS]: 'Último acceso',
  },
};

const sensor = (category, type, max, keepHistory = true) => ({
  category,
  type,
  read_only: true,
  has_feedback: false,
  keep_history: keepHistory,
  min: 0,
  max,
});

// min/max are NOT NULL in the core, text features included (0/0).
const textFeature = () =>
  sensor(DEVICE_FEATURE_CATEGORIES.TEXT, DEVICE_FEATURE_TYPES.TEXT.TEXT, 0, false);

const DEFINITIONS = {
  [FEATURE_KEYS.LOCK]: sensor(DEVICE_FEATURE_CATEGORIES.LOCK, DEVICE_FEATURE_TYPES.LOCK.STATE, 3),
  [FEATURE_KEYS.POSITION]: sensor(
    DEVICE_FEATURE_CATEGORIES.OPENING_SENSOR,
    DEVICE_FEATURE_TYPES.SENSOR.BINARY,
    1,
  ),
  [FEATURE_KEYS.DOORBELL]: sensor(
    DEVICE_FEATURE_CATEGORIES.DOORBELL,
    DEVICE_FEATURE_TYPES.DOORBELL.RING,
    1,
  ),
  [FEATURE_KEYS.RULE]: textFeature(),
  [FEATURE_KEYS.LAST_ACCESS]: textFeature(),
};

// Values of the core constants (server/utils/constants.js, v5.2.1).
export const LOCK_STATE = Object.freeze({ UNLOCKED: 0, LOCKED: 1 });
export const OPENING_SENSOR_STATE = Object.freeze({ OPEN: 0, CLOSE: 1 });

/** External ids of a door's device and features. */
export const doorIds = (gladys, doorId) => gladys.externalIds(DEVICE_TYPE, doorId);

/** The features a door has: some depend on its hardware. Order = display order. */
export function featureKeys(door) {
  return [
    FEATURE_KEYS.LOCK,
    ...(door.hasPositionSensor ? [FEATURE_KEYS.POSITION] : []),
    ...(door.doorbell ? [FEATURE_KEYS.DOORBELL] : []),
    ...(door.ruleSupported ? [FEATURE_KEYS.RULE] : []),
    FEATURE_KEYS.LAST_ACCESS,
  ];
}

/**
 * The discovery payload of a door.
 * @param {object} gladys SDK client
 * @param {object} door hub door record (src/hub.js)
 * @param {string} language feature names language
 */
export function buildDevice(gladys, door, language = 'fr') {
  const ids = doorIds(gladys, door.id);
  const names = NAMES[language] ?? NAMES.fr;
  return {
    name: door.name,
    external_id: ids.device,
    should_poll: false,
    params: [{ name: DOOR_PARAM, value: door.id }],
    features: featureKeys(door).map((key) => ({
      ...DEFINITIONS[key],
      name: names[key],
      external_id: ids.feature(key),
    })),
  };
}

/**
 * The states of a door, in the publishStates format (nothing for an unknown value).
 * @returns {Array<{ device_feature_external_id: string, state?: number, text?: string }>}
 */
export function doorStates(gladys, door, language = 'fr') {
  const ids = doorIds(gladys, door.id);
  const states = [];
  const number = (key, state) => {
    if (state !== null && state !== undefined) {
      states.push({ device_feature_external_id: ids.feature(key), state });
    }
  };
  const text = (key, value) => {
    if (value) {
      states.push({ device_feature_external_id: ids.feature(key), text: value });
    }
  };
  for (const key of featureKeys(door)) {
    switch (key) {
      case FEATURE_KEYS.LOCK:
        number(
          key,
          door.lock === LOCK.LOCKED
            ? LOCK_STATE.LOCKED
            : door.lock === LOCK.UNLOCKED
              ? LOCK_STATE.UNLOCKED
              : null,
        );
        break;
      case FEATURE_KEYS.POSITION:
        number(
          key,
          door.position === POSITION.OPEN
            ? OPENING_SENSOR_STATE.OPEN
            : door.position === POSITION.CLOSED
              ? OPENING_SENSOR_STATE.CLOSE
              : null,
        );
        break;
      case FEATURE_KEYS.DOORBELL:
        number(key, door.ringing ? 1 : 0);
        break;
      case FEATURE_KEYS.RULE:
        text(key, door.rule ? ruleText(door.rule, language) : null);
        break;
      case FEATURE_KEYS.LAST_ACCESS:
        text(
          key,
          door.lastAccess
            ? accessText(door.lastAccess, language)
            : pick(ACCESS_TEXT.none, language),
        );
        break;
    }
  }
  return states;
}
