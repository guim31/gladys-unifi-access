// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, action messages, the text states (lock rule,
// last access) and the scene event labels. Four languages, the four of the
// Gladys interface; German says "du", Spanish "usted". test/i18n.test.js
// checks every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './access/client.js';
import { ALARMS, DIRECTIONS, METHODS, RULES } from './access/model.js';

/** The text of a multi-language object in `language`, English as fallback. */
export const pick = (text, language) => text?.[language] ?? text?.en ?? '';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  noHost: {
    en: 'Enter the address of your UniFi console and an API token in the configuration.',
    fr: "Saisissez l'adresse de votre console UniFi et un jeton d'API dans la configuration.",
    de: 'Gib die Adresse deiner UniFi-Konsole und ein API-Token in der Konfiguration ein.',
    es: 'Introduzca la dirección de su consola UniFi y un token de API en la configuración.',
  },
  invalidHost: {
    en: 'Console address not understood, e.g. 192.168.1.1',
    fr: 'Adresse de console incomprise, ex. 192.168.1.1',
    de: 'Adresse der Konsole nicht verstanden, z. B. 192.168.1.1',
    es: 'Dirección de la consola no válida, p. ej. 192.168.1.1',
  },
  noToken: {
    en: 'Paste the API token created in UniFi Access (Settings, General, Advanced).',
    fr: "Collez le jeton d'API créé dans UniFi Access (Settings, General, Advanced).",
    de: 'Füge das in UniFi Access erstellte API-Token ein (Settings, General, Advanced).',
    es: 'Pegue el token de API creado en UniFi Access (Settings, General, Advanced).',
  },
  noSocket: {
    en: 'Real-time notifications unavailable: the doors are read every minute.',
    fr: 'Notifications en temps réel indisponibles : les portes sont relues chaque minute.',
    de: 'Echtzeit-Benachrichtigungen nicht verfügbar: Die Türen werden jede Minute gelesen.',
    es: 'Notificaciones en tiempo real no disponibles: las puertas se leen cada minuto.',
  },
};

// One short explanation per error kind (src/access/client.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'The console does not answer on this address and port (12445 by default).',
    fr: 'La console ne répond pas à cette adresse et ce port (12445 par défaut).',
    de: 'Die Konsole antwortet nicht unter dieser Adresse und diesem Port (Standard 12445).',
    es: 'La consola no responde en esta dirección y puerto (12445 por defecto).',
  },
  [ERROR_KINDS.TLS]: {
    en: 'Certificate not trusted: tick "Accept the self-signed certificate".',
    fr: 'Certificat non reconnu : cochez « Accepter le certificat auto-signé ».',
    de: 'Zertifikat nicht vertrauenswürdig: Aktiviere „Selbstsigniertes Zertifikat akzeptieren“.',
    es: 'Certificado no reconocido: marque «Aceptar el certificado autofirmado».',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'API token refused: create a new one in UniFi Access.',
    fr: "Jeton d'API refusé : créez-en un nouveau dans UniFi Access.",
    de: 'API-Token abgelehnt: Erstelle ein neues in UniFi Access.',
    es: 'Token de API rechazado: cree uno nuevo en UniFi Access.',
  },
  [ERROR_KINDS.FORBIDDEN]: {
    en: 'The API token lacks a permission: give it every Space and Device permission.',
    fr: "Il manque une permission au jeton d'API : donnez-lui toutes celles de Space et Device.",
    de: 'Dem API-Token fehlt eine Berechtigung: Gib ihm alle Space- und Device-Rechte.',
    es: 'Al token de API le falta un permiso: dele todos los permisos de Space y Device.',
  },
  [ERROR_KINDS.NOT_FOUND]: {
    en: 'This UniFi Access version lacks the developer API: update UniFi Access.',
    fr: "Cette version d'UniFi Access n'a pas l'API développeur : mettez UniFi Access à jour.",
    de: 'Dieser UniFi-Access-Version fehlt die Entwickler-API: Aktualisiere UniFi Access.',
    es: 'Esta versión de UniFi Access no tiene la API de desarrollador: actualice UniFi Access.',
  },
  [ERROR_KINDS.RATE_LIMIT]: {
    en: 'The console refuses too many requests: retrying later.',
    fr: 'La console refuse trop de requêtes : nouvel essai plus tard.',
    de: 'Die Konsole lehnt zu viele Anfragen ab: neuer Versuch später.',
    es: 'La consola rechaza demasiadas solicitudes: nuevo intento más tarde.',
  },
  [ERROR_KINDS.REFUSED]: {
    en: 'UniFi Access refused the request: see the integration logs.',
    fr: "UniFi Access a refusé la requête : voir les logs de l'intégration.",
    de: 'UniFi Access hat die Anfrage abgelehnt: Sieh dir die Protokolle der Integration an.',
    es: 'UniFi Access rechazó la solicitud: consulte los registros de la integración.',
  },
  [ERROR_KINDS.PROTOCOL]: {
    en: 'This port does not answer like UniFi Access: check the port (12445).',
    fr: 'Ce port ne répond pas comme UniFi Access : vérifiez le port (12445).',
    de: 'Dieser Port antwortet nicht wie UniFi Access: Prüfe den Port (12445).',
    es: 'Este puerto no responde como UniFi Access: compruebe el puerto (12445).',
  },
};

export const ACTION_TEXT = {
  noConsole: {
    en: 'The UniFi console is not configured or does not answer.',
    fr: "La console UniFi n'est pas configurée ou ne répond pas.",
    de: 'Die UniFi-Konsole ist nicht konfiguriert oder antwortet nicht.',
    es: 'La consola UniFi no está configurada o no responde.',
  },
  unknownDoor: {
    en: 'Unknown door: choose a door of this integration.',
    fr: 'Porte inconnue : choisissez une porte de cette intégration.',
    de: 'Unbekannte Tür: Wähle eine Tür dieser Integration.',
    es: 'Puerta desconocida: elija una puerta de esta integración.',
  },
  unlockDisabled: {
    en: 'Remote unlock is disabled in the configuration of the integration.',
    fr: "Le déverrouillage à distance est désactivé dans la configuration de l'intégration.",
    de: 'Die Fernentriegelung ist in der Konfiguration der Integration deaktiviert.',
    es: 'El desbloqueo remoto está desactivado en la configuración de la integración.',
  },
  resetBlocked: {
    en: 'Ending "always locked" may unlock the door: allowed only with remote unlock enabled.',
    fr: 'Quitter « toujours verrouillée » peut déverrouiller la porte : permis seulement avec le déverrouillage à distance activé.',
    de: '„Immer verriegelt“ zu beenden kann die Tür entriegeln: nur mit aktivierter Fernentriegelung erlaubt.',
    es: 'Salir de «siempre bloqueada» puede desbloquear la puerta: solo con el desbloqueo remoto activado.',
  },
  failed: {
    en: 'UniFi Access did not apply the command.',
    fr: "UniFi Access n'a pas appliqué la commande.",
    de: 'UniFi Access hat den Befehl nicht ausgeführt.',
    es: 'UniFi Access no aplicó la orden.',
  },
};

// The "Test the connection" report (≤ 200 characters per line).
export const REPORT_TEXT = {
  en: {
    ok: (doors, devices) => `Connected: ${doors} door(s), ${devices} device(s).`,
    socketOn: 'Real-time notifications: connected.',
    socketOff: 'Real-time notifications: not connected, the doors are read every minute.',
    unlockOn: 'Remote unlock: enabled (scene action only).',
    unlockOff: 'Remote unlock: disabled.',
  },
  fr: {
    ok: (doors, devices) => `Connecté : ${doors} porte(s), ${devices} appareil(s).`,
    socketOn: 'Notifications en temps réel : connectées.',
    socketOff:
      'Notifications en temps réel : non connectées, les portes sont relues chaque minute.',
    unlockOn: 'Déverrouillage à distance : activé (action de scène seulement).',
    unlockOff: 'Déverrouillage à distance : désactivé.',
  },
  de: {
    ok: (doors, devices) => `Verbunden: ${doors} Tür(en), ${devices} Gerät(e).`,
    socketOn: 'Echtzeit-Benachrichtigungen: verbunden.',
    socketOff:
      'Echtzeit-Benachrichtigungen: nicht verbunden, die Türen werden jede Minute gelesen.',
    unlockOn: 'Fernentriegelung: aktiviert (nur als Szenen-Aktion).',
    unlockOff: 'Fernentriegelung: deaktiviert.',
  },
  es: {
    ok: (doors, devices) => `Conectado: ${doors} puerta(s), ${devices} dispositivo(s).`,
    socketOn: 'Notificaciones en tiempo real: conectadas.',
    socketOff: 'Notificaciones en tiempo real: no conectadas, las puertas se leen cada minuto.',
    unlockOn: 'Desbloqueo remoto: activado (solo como acción de escena).',
    unlockOff: 'Desbloqueo remoto: desactivado.',
  },
};

// The lock rule text state (text/text feature, ≤ 40 characters).
export const RULE_TEXT = {
  [RULES.NORMAL]: { en: 'Normal', fr: 'Normal', de: 'Normal', es: 'Normal' },
  [RULES.KEEP_LOCK]: {
    en: 'Always locked',
    fr: 'Toujours verrouillée',
    de: 'Immer verriegelt',
    es: 'Siempre bloqueada',
  },
  [RULES.KEEP_UNLOCK]: {
    en: 'Always unlocked',
    fr: 'Toujours déverrouillée',
    de: 'Immer entriegelt',
    es: 'Siempre desbloqueada',
  },
  [RULES.CUSTOM]: {
    en: 'Unlocked for a while',
    fr: 'Déverrouillée un moment',
    de: 'Eine Weile entriegelt',
    es: 'Desbloqueada un tiempo',
  },
  [RULES.SCHEDULE]: {
    en: 'Unlock schedule',
    fr: 'Déverrouillage planifié',
    de: 'Entriegelungsplan',
    es: 'Desbloqueo programado',
  },
  [RULES.LOCK_EARLY]: {
    en: 'Schedule ended early',
    fr: 'Planning arrêté plus tôt',
    de: 'Plan vorzeitig beendet',
    es: 'Horario terminado antes',
  },
  [RULES.LOCK_NOW]: {
    en: 'Locked now',
    fr: 'Verrouillée maintenant',
    de: 'Jetzt verriegelt',
    es: 'Bloqueada ahora',
  },
  [RULES.OTHER]: { en: 'Other rule', fr: 'Autre règle', de: 'Andere Regel', es: 'Otra regla' },
};

export const UNTIL_TEXT = {
  en: (rule, time) => `${rule} until ${time}`,
  fr: (rule, time) => `${rule} jusqu'à ${time}`,
  de: (rule, time) => `${rule} bis ${time}`,
  es: (rule, time) => `${rule} hasta las ${time}`,
};

export const METHOD_TEXT = {
  [METHODS.NFC]: { en: 'NFC card', fr: 'Badge NFC', de: 'NFC-Karte', es: 'Tarjeta NFC' },
  [METHODS.PIN]: { en: 'PIN code', fr: 'Code PIN', de: 'PIN-Code', es: 'Código PIN' },
  [METHODS.FACE]: {
    en: 'Face',
    fr: 'Visage',
    de: 'Gesicht',
    es: 'Rostro',
  },
  [METHODS.HAND_WAVE]: {
    en: 'Hand wave',
    fr: 'Geste de la main',
    de: 'Handbewegung',
    es: 'Gesto de la mano',
  },
  [METHODS.MOBILE]: { en: 'Mobile app', fr: 'Appli mobile', de: 'Mobile App', es: 'App móvil' },
  [METHODS.REMOTE]: { en: 'Remote', fr: 'À distance', de: 'Aus der Ferne', es: 'A distancia' },
  [METHODS.QR]: { en: 'QR code', fr: 'QR code', de: 'QR-Code', es: 'Código QR' },
  [METHODS.WALLET]: {
    en: 'Phone wallet',
    fr: 'Portefeuille du téléphone',
    de: 'Wallet im Handy',
    es: 'Cartera del móvil',
  },
  [METHODS.PLATE]: {
    en: 'License plate',
    fr: "Plaque d'immatriculation",
    de: 'Nummernschild',
    es: 'Matrícula',
  },
  [METHODS.INTERCOM]: {
    en: 'Intercom',
    fr: 'Interphone',
    de: 'Gegensprechanlage',
    es: 'Interfono',
  },
  [METHODS.OTHER]: { en: 'Other', fr: 'Autre', de: 'Andere', es: 'Otro' },
};

export const DIRECTION_TEXT = {
  [DIRECTIONS.ENTRY]: { en: 'Entry', fr: 'Entrée', de: 'Eintritt', es: 'Entrada' },
  [DIRECTIONS.EXIT]: { en: 'Exit', fr: 'Sortie', de: 'Austritt', es: 'Salida' },
};

export const ALARM_TEXT = {
  [ALARMS.FORCED]: {
    en: 'Door forced open',
    fr: 'Porte forcée',
    de: 'Tür aufgebrochen',
    es: 'Puerta forzada',
  },
  [ALARMS.HELD]: {
    en: 'Door held open',
    fr: 'Porte restée ouverte',
    de: 'Tür zu lange offen',
    es: 'Puerta abierta demasiado tiempo',
  },
  [ALARMS.OTHER]: {
    en: 'Door alarm',
    fr: 'Alarme de porte',
    de: 'Türalarm',
    es: 'Alarma de puerta',
  },
};

// The last access text state and the access history.
export const ACCESS_TEXT = {
  granted: { en: 'Granted', fr: 'Autorisé', de: 'Erlaubt', es: 'Permitido' },
  denied: { en: 'Denied', fr: 'Refusé', de: 'Verweigert', es: 'Denegado' },
  unknownUser: { en: 'Unknown', fr: 'Inconnu', de: 'Unbekannt', es: 'Desconocido' },
  none: {
    en: 'No access yet',
    fr: 'Aucun accès pour le moment',
    de: 'Noch kein Zutritt',
    es: 'Ningún acceso todavía',
  },
};

/** Clock time in the time zone of Gladys (TZ, set by the supervisor). */
export function clockTime(ms, language) {
  return new Date(ms).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
}

/** The lock rule text: "Always locked", "Unlocked for a while until 18:30"… */
export function ruleText(rule, language) {
  const label = pick(RULE_TEXT[rule?.type] ?? RULE_TEXT[RULES.NORMAL], language);
  if (rule?.until) {
    return pick(UNTIL_TEXT, language)(label, clockTime(rule.until, language)).slice(0, 40);
  }
  return label;
}

/** "Alice Martin · NFC card · Entry", "Denied · Unknown · PIN code". */
export function accessText(access, language) {
  const parts = [];
  if (!access.granted) {
    parts.push(pick(ACCESS_TEXT.denied, language));
  }
  parts.push(access.user || pick(ACCESS_TEXT.unknownUser, language));
  parts.push(pick(METHOD_TEXT[access.method] ?? METHOD_TEXT[METHODS.OTHER], language));
  if (DIRECTION_TEXT[access.direction]) {
    parts.push(pick(DIRECTION_TEXT[access.direction], language));
  }
  return parts.join(' · ').slice(0, 100);
}
