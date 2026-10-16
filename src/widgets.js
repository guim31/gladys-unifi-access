// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `doors`.
//
// The use case: a glance at the wall tablet before leaving — are the doors
// locked and closed, did the children come home (last accesses). For one
// door, a direct "Always locked" button (safe), and "Normal schedule" when a
// temporary rule is in force (ending "always locked" only with the remote
// unlock enabled, see src/hub.js). No unlock button, ever.
//
// Budget (8 components, 1 focal, 1 status, 4 buttons): one status list (one
// row per door, 10 at most), one card list (the last accesses), two buttons
// at most. The rows are values, not device-bound tiles: the widget works
// before the doors are added to Gladys.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { ALARMS, LOCK, METHODS, POSITION, RULES, alarmKind } from './access/model.js';
import { doorIds } from './devices.js';
import { WIDGET_KEY } from './hub.js';
import {
  ACCESS_TEXT,
  ALARM_TEXT,
  CONNECTION_TEXT,
  DIRECTION_TEXT,
  ERROR_TEXT,
  METHOD_TEXT,
  pick,
  ruleText,
} from './texts.js';

// Action keys of the buttons: permanent once published (unique, the core
// drops a button whose key is taken).
export const ACTIONS = Object.freeze({
  KEEP_LOCKED: 'keep_locked',
  END_RULE: 'end_rule',
});

const MAX_ROWS = 10;
const MAX_ACCESSES = 6;
// In dark mode the `primary` style does not show (Gladys#3153): the active
// choice is told by its icon.
const ACTIVE_ICON = 'check-circle';

export const TEXT = {
  noDoor: {
    en: 'No door found in UniFi Access yet.',
    fr: "Aucune porte trouvée dans UniFi Access pour l'instant.",
    de: 'Noch keine Tür in UniFi Access gefunden.',
    es: 'Todavía no se ha encontrado ninguna puerta en UniFi Access.',
  },
  unknown: {
    en: 'This door is no longer in UniFi Access: choose another one in the widget settings.',
    fr: "Cette porte n'est plus dans UniFi Access : choisissez-en une autre dans les réglages du widget.",
    de: 'Diese Tür ist nicht mehr in UniFi Access: Wähle eine andere in den Widget-Einstellungen.',
    es: 'Esta puerta ya no está en UniFi Access: elija otra en la configuración del widget.',
  },
  noAccess: {
    en: 'No access recorded since the integration started.',
    fr: "Aucun accès enregistré depuis le démarrage de l'intégration.",
    de: 'Seit dem Start der Integration wurde kein Zutritt erfasst.',
    es: 'Ningún acceso registrado desde el inicio de la integración.',
  },
  locked: { en: 'Locked', fr: 'Verrouillée', de: 'Verriegelt', es: 'Bloqueada' },
  unlocked: { en: 'Unlocked', fr: 'Déverrouillée', de: 'Entriegelt', es: 'Desbloqueada' },
  open: { en: 'open', fr: 'ouverte', de: 'offen', es: 'abierta' },
  closed: { en: 'closed', fr: 'fermée', de: 'geschlossen', es: 'cerrada' },
  offline: { en: 'Offline', fr: 'Hors ligne', de: 'Offline', es: 'Sin conexión' },
  waiting: { en: 'Waiting…', fr: 'En attente…', de: 'Warte…', es: 'Esperando…' },
  keepLocked: {
    en: 'Always locked',
    fr: 'Toujours verrouiller',
    de: 'Immer verriegeln',
    es: 'Siempre bloquear',
  },
  endRule: {
    en: 'Normal schedule',
    fr: 'Planning normal',
    de: 'Normaler Plan',
    es: 'Horario normal',
  },
};

// Toasts after a tap (≤ 200 characters).
export const DONE_TEXT = {
  en: {
    keepLocked: (door) => `${door} stays locked until "Normal schedule".`,
    endRule: (door) => `${door} follows its normal schedule again.`,
  },
  fr: {
    keepLocked: (door) => `${door} reste verrouillée jusqu'à « Planning normal ».`,
    endRule: (door) => `${door} suit de nouveau son planning normal.`,
  },
  de: {
    keepLocked: (door) => `${door} bleibt verriegelt bis „Normaler Plan“.`,
    endRule: (door) => `${door} folgt wieder ihrem normalen Plan.`,
  },
  es: {
    keepLocked: (door) => `${door} permanece bloqueada hasta «Horario normal».`,
    endRule: (door) => `${door} vuelve a seguir su horario normal.`,
  },
};

const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function message(text, language) {
  return {
    ttl_seconds: 60,
    components: [{ type: 'text', variant: 'body', text: pick(text, language) }],
  };
}

/** One status row: the door and what matters most about it. */
function doorRow(hub, door, language) {
  const t = (text) => pick(text, language);
  if (door.online === false || hub.reachable === false) {
    return {
      label: fit(door.name, 40),
      value: t(TEXT.offline),
      color: WIDGET_COLORS.NEUTRAL,
      icon: 'wifi-off',
    };
  }
  if (door.alarms.length > 0) {
    const kind = alarmKind(door.alarms[0]);
    return {
      label: fit(door.name, 40),
      value: fit(t(ALARM_TEXT[kind] ?? ALARM_TEXT[ALARMS.OTHER]), 40),
      color: WIDGET_COLORS.DANGER,
      icon: 'alert-triangle',
    };
  }
  const parts = [];
  if (door.lock === LOCK.LOCKED) {
    parts.push(t(TEXT.locked));
  } else if (door.lock === LOCK.UNLOCKED) {
    parts.push(t(TEXT.unlocked));
  }
  if (door.position === POSITION.OPEN) {
    parts.push(t(TEXT.open));
  } else if (door.position === POSITION.CLOSED) {
    parts.push(t(TEXT.closed));
  }
  const secure = door.lock === LOCK.LOCKED && door.position !== POSITION.OPEN;
  return {
    label: fit(door.name, 40),
    value: fit(parts.join(' · ') || t(TEXT.waiting), 40),
    color: secure ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.WARNING,
    icon: door.lock === LOCK.UNLOCKED ? 'unlock' : 'lock',
  };
}

function accessItem(access, showDoor, language) {
  const t = (text) => pick(text, language);
  const details = [
    ...(showDoor && access.doorName ? [access.doorName] : []),
    t(METHOD_TEXT[access.method] ?? METHOD_TEXT[METHODS.OTHER]),
    ...(DIRECTION_TEXT[access.direction] ? [t(DIRECTION_TEXT[access.direction])] : []),
  ];
  return {
    title: fit(access.user || t(ACCESS_TEXT.unknownUser), 60),
    subtitle: details.join(' · '),
    date: new Date(access.at).toISOString(),
    badge: access.granted
      ? { text: fit(t(ACCESS_TEXT.granted), 16), color: WIDGET_COLORS.SUCCESS }
      : { text: fit(t(ACCESS_TEXT.denied), 16), color: WIDGET_COLORS.DANGER },
  };
}

function buttons(hub, door, language) {
  const t = (text) => pick(text, language);
  const params = { door: doorIds(hub.gladys, door.id).device };
  const keepLock = door.rule?.type === RULES.KEEP_LOCK;
  const list = [
    {
      type: 'button',
      label: t(TEXT.keepLocked),
      icon: keepLock ? ACTIVE_ICON : 'lock',
      style: 'secondary',
      action: { key: ACTIONS.KEEP_LOCKED, params, confirm: true },
    },
  ];
  const temporary = door.rule && door.rule.type !== RULES.NORMAL;
  if (temporary && (!keepLock || hub.config.allowRemoteUnlock)) {
    list.push({
      type: 'button',
      label: t(TEXT.endRule),
      icon: 'calendar',
      style: 'secondary',
      action: { key: ACTIONS.END_RULE, params, confirm: true },
    });
  }
  return list;
}

/** The widget content for the chosen door (or every door). */
export function doorsContent(hub, { settings = {}, language = 'en' } = {}) {
  const lang = ['en', 'fr', 'de', 'es'].includes(language) ? language : 'en';
  if (!hub.config?.host || !hub.config?.token) {
    return message(CONNECTION_TEXT.noHost, lang);
  }
  if (hub.error && hub.doors.size === 0) {
    return message(ERROR_TEXT[hub.error.kind], lang);
  }
  let doors = [...hub.doors.values()];
  if (settings.door) {
    const door = hub.doorOfDevice(settings.door);
    if (!door) {
      return message(TEXT.unknown, lang);
    }
    doors = [door];
  }
  if (doors.length === 0) {
    return message(TEXT.noDoor, lang);
  }
  const ids = new Set(doors.map((door) => door.id));
  const accesses = hub.history
    .filter((access) => !settings.door || ids.has(access.doorId))
    .slice(0, MAX_ACCESSES);

  const components = [
    {
      type: 'status',
      items: doors.slice(0, MAX_ROWS).map((door) => doorRow(hub, door, lang)),
    },
  ];
  if (doors.length === 1 && doors[0].rule && doors[0].rule.type !== RULES.NORMAL) {
    components.push({
      type: 'text',
      variant: 'caption',
      text: fit(ruleText(doors[0].rule, lang), 80),
    });
  }
  if (accesses.length > 0) {
    components.push({
      type: 'card-list',
      display: 'list',
      items: accesses.map((access) => accessItem(access, doors.length > 1, lang)),
    });
  } else {
    components.push({ type: 'text', variant: 'caption', text: pick(TEXT.noAccess, lang) });
  }
  if (doors.length === 1 && hub.reachable && doors[0].ruleSupported) {
    components.push(...buttons(hub, doors[0], lang));
  }
  return { ttl_seconds: 60, components };
}

export const WIDGETS = {
  [WIDGET_KEY]: {
    get: (hub, request) => doorsContent(hub, request),

    // The toast is multi-language: Gladys shows the user's language.
    async action(hub, { actionKey, params = {}, settings = {} }) {
      const target = params.door || settings.door;
      const toast = (key, door) =>
        Object.fromEntries(
          Object.entries(DONE_TEXT).map(([lang, texts]) => [lang, fit(texts[key](door.name), 200)]),
        );
      if (actionKey === ACTIONS.KEEP_LOCKED) {
        return toast('keepLocked', await hub.keepLocked(target, 'widget'));
      }
      if (actionKey === ACTIONS.END_RULE) {
        return toast('endRule', await hub.endRule(target, 'widget'));
      }
      throw new Error(`Unknown widget action ${actionKey}`);
    },
  },
};
