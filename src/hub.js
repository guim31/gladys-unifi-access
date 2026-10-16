// -----------------------------------------------------------------------------
// The UniFi Access hub: the doors of one console, kept up to date by the
// notification WebSocket (real time) and by a timer of the container (a
// complete read every 5 minutes, every minute while the socket is down). Its
// states are published to Gladys when they change, its scene events fired on
// transitions, and the commands of the scene actions and the widget run here.
//
// Gladys never polls these devices (should_poll: false): the core does not
// poll external devices reliably (GladysAssistant/Gladys#3198), and the
// events must fire even for a door whose device was not added.
//
// Safety: nothing here unlocks a door unless the user enabled the remote
// unlock in the configuration, and even then only through the scene action
// "Unlock a door" (src/scenes.js). Ending an "always locked" rule may unlock a
// door too: it is held to the same switch.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { AccessClient, AccessError, ERROR_KINDS } from './access/client.js';
import {
  ALARMS,
  LOCK,
  RULES,
  accessMethod,
  alarmKind,
  parseDevice,
  parseDoor,
  parseLockRule,
  parseNotification,
  sameName,
} from './access/model.js';
import { NotificationSocket } from './access/socket.js';
import { createNodeTransport } from './access/transport.js';
import { describeHost } from './config.js';
import { DEVICE_TYPE, buildDevice, doorIds, doorStates } from './devices.js';
import {
  ACTION_TEXT,
  ALARM_TEXT,
  CONNECTION_TEXT,
  ERROR_TEXT,
  METHOD_TEXT,
  REPORT_TEXT,
  pick,
} from './texts.js';

const logger = createLogger({ name: 'unifi-access-hub' });

export const WIDGET_KEY = 'doors';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  DOORBELL: 'doorbell_rang',
  GRANTED: 'access_granted',
  DENIED: 'access_denied',
  ALARM: 'door_alarm',
  OFFLINE: 'door_offline',
  ONLINE: 'door_online',
});

export const HUB_TIMINGS = {
  // Complete read while the socket brings the changes: catches a lost event,
  // an expired lock rule, and keeps the states recent.
  pollMs: 5 * 60_000,
  // Complete read while the socket is down.
  fallbackPollMs: 60_000,
  // An unchanged state is sent again this often (the dashboard shows "no
  // recent value" past 48 h).
  heartbeatMs: 6 * 60 * 60_000,
  // Length of the doorbell pulse (1, then 0).
  doorbellPulseMs: 5_000,
  // The same access arrives twice (insights, then logs) a few ms apart.
  accessDedupMs: 2 * 60_000,
  // One ring may arrive as an intercom call and as a hardware doorbell.
  doorbellDedupMs: 20_000,
  // A state without lock rule while a rule is shown: read the rule again.
  ruleCheckDelayMs: 2_000,
  // Doors or devices changed: read the site again, once.
  topologyDelayMs: 3_000,
  historySize: 20,
};

const MAX_STATES_PER_REQUEST = 100;

export class AccessHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {object} [options.transport] network seam (src/access/transport.js)
   * @param {boolean} [options.timers] periodic timers (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {object} [options.socketTimings] SOCKET_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, store, transport, timers = true, timings, socketTimings, now }) {
    this.gladys = gladys;
    this.store = store;
    this.transport = transport ?? createNodeTransport();
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.socketTimings = socketTimings;
    this.now = now ?? (() => Date.now());
    this.config = null;
    this.client = null;
    this.socket = null;
    /** @type {Map<string, object>} doors by UniFi id */
    this.doors = new Map();
    /** @type {Map<string, object>} devices by UniFi id */
    this.devices = new Map();
    /** device id → door id, from the device list and the notifications */
    this.deviceDoor = new Map();
    this.reachable = null; // null: never read; true/false: last read
    this.error = null;
    this.socketError = null;
    this.socketEverOpened = false;
    this.refreshing = null;
    this.history = [];
    this.doorbellDoors = new Set();
    this.seenAccess = new Map();
    this.seenRings = new Map();
    this.devicesSignature = null;
    this.transports = new Map();
    this.connection = null;
    this.pollTimer = null;
    this.topologyTimer = null;
    this.ruleTimers = new Map();
    this.pulseTimers = new Map();
    this.stopped = false;
    /** Problems already logged, by key: repeats go to debug. */
    this.warned = new Set();
  }

  // --- Logs ------------------------------------------------------------------
  // Info keeps the lifecycle only (console connected, lost, back; doors
  // offline and back; user commands). A problem that repeats is logged once
  // at its own level, then at debug until it clears. LOG_LEVEL=debug shows
  // every event.

  problem(key, message, err, level = 'warn') {
    const args = err === undefined ? [message] : [message, err];
    if (this.warned.has(key)) {
      logger.debug(...args);
      return;
    }
    this.warned.add(key);
    logger[level](...args);
  }

  resolved(key, message) {
    if (this.warned.delete(key) && message) {
      logger.info(message);
    }
  }

  get language() {
    return this.config?.language ?? 'fr';
  }

  get label() {
    return this.config?.host ? `UniFi Access ${describeHost(this.config.host)}` : 'UniFi Access';
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    const saved = await this.store.load();
    this.history = Array.isArray(saved.history)
      ? saved.history.filter((entry) => entry && typeof entry === 'object').slice(0, 50)
      : [];
    this.doorbellDoors = new Set(
      Array.isArray(saved.doorbellDoors) ? saved.doorbellDoors.map(String) : [],
    );
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.transports.clear();
    this.connection = null;
    this.devicesSignature = null;
    this.gladys.forgetPublishedStates();
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const previous = this.config;
    this.config = config;
    const sameConsole =
      previous &&
      this.client &&
      JSON.stringify([previous.host, previous.token, previous.allowSelfSigned]) ===
        JSON.stringify([config.host, config.token, config.allowSelfSigned]);
    if (!sameConsole) {
      this.closeConsole();
      if (config.host && config.token) {
        this.client = new AccessClient({
          host: config.host,
          token: config.token,
          insecure: config.allowSelfSigned,
          transport: this.transport,
        });
      }
    }
    if (this.client) {
      await this.refresh();
      if (!sameConsole) {
        this.openSocket();
      }
    }
    // The language changes the feature names: publish the devices again.
    await this.publishDevices({ force: previous?.language !== config.language });
    await this.publishAllStates();
    await this.afterChanges(true);
    this.schedulePoll();
  }

  /** Forget the console: a new address or token is another site. */
  closeConsole() {
    this.socket?.stop();
    this.socket = null;
    this.client = null;
    this.doors.clear();
    this.devices.clear();
    this.deviceDoor.clear();
    this.reachable = null;
    this.error = null;
    this.socketError = null;
    this.socketEverOpened = false;
    this.clearDoorTimers();
  }

  clearDoorTimers() {
    for (const timer of [...this.ruleTimers.values(), ...this.pulseTimers.values()]) {
      clearTimeout(timer);
    }
    this.ruleTimers.clear();
    this.pulseTimers.clear();
    clearTimeout(this.topologyTimer);
    this.topologyTimer = null;
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    this.clearDoorTimers();
    this.socket?.stop();
    await this.store.flush();
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (!this.timersEnabled || this.stopped || !this.client) {
      return;
    }
    const delay = this.socket?.connected ? this.timings.pollMs : this.timings.fallbackPollMs;
    this.pollTimer = setTimeout(async () => {
      try {
        await this.refreshAndPublish();
        this.resolved('poll');
      } catch (err) {
        this.problem('poll', 'Refresh failed', err, 'error');
      }
      this.schedulePoll();
    }, delay);
    this.pollTimer.unref?.();
  }

  // --- Notification socket -----------------------------------------------------

  openSocket() {
    this.socket = new NotificationSocket({
      open: () => this.client.openNotifications(),
      onPacket: (packet) => {
        this.handlePacket(packet).catch((err) =>
          this.problem('packet', 'Notification handling failed', err, 'error'),
        );
      },
      onOpen: () => {
        const back = this.socketError !== null;
        this.socketError = null;
        this.resolved('socket');
        if (back) {
          logger.info(`${this.label}: real-time notifications back`);
        } else if (!this.socketEverOpened) {
          logger.info(`${this.label}: real-time notifications connected`);
        }
        this.socketEverOpened = true;
        // Events may have been missed while it was closed: read everything.
        this.refreshAndPublish()
          .then(() => this.schedulePoll())
          .catch((err) => this.problem('poll', 'Refresh failed', err, 'error'));
      },
      onClose: (error) => {
        const reason = error ?? new AccessError(ERROR_KINDS.UNREACHABLE, 'closed by the console');
        this.socketError = reason;
        this.problem(
          'socket',
          `${this.label}: real-time notifications lost (${reason.message}), reading every minute`,
        );
        this.afterChanges(true).catch(() => {});
        this.schedulePoll();
      },
      timers: this.timersEnabled,
      timings: this.socketTimings,
    });
    this.socket.start();
  }

  // --- Reading the console -------------------------------------------------------

  /** Read the doors, devices and lock rules. Concurrent calls share the read. */
  refresh() {
    if (!this.client) {
      return Promise.resolve(false);
    }
    this.refreshing ??= this.read().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** "Search" in the Discovery tab, onPoll, the timer: read, then publish. */
  async refreshAndPublish() {
    const changed = await this.refresh();
    await this.publishDevices();
    await this.publishAllStates();
    await this.afterChanges(changed);
  }

  async read() {
    const client = this.client;
    let doors;
    let devices;
    try {
      [doors, devices] = await Promise.all([client.getDoors(), client.getDevices()]);
    } catch (err) {
      if (!(err instanceof AccessError)) {
        throw err;
      }
      return this.applyFailure(err);
    }
    if (client !== this.client) {
      return false; // reconfigured while reading
    }
    const rules = await Promise.all(
      doors.map(async (raw) => {
        const door = this.doors.get(raw?.id);
        if (door && !door.ruleSupported) {
          return undefined;
        }
        try {
          return parseLockRule(await client.getLockRule(raw.id));
        } catch (err) {
          if (err instanceof AccessError && err.kind === ERROR_KINDS.NOT_FOUND) {
            return null; // this firmware has no lock rules
          }
          logger.debug(`Lock rule of door ${raw?.id} not read: ${err.message}`);
          return undefined;
        }
      }),
    );
    return this.applySuccess(doors, devices, rules);
  }

  async applySuccess(rawDoors, rawDevices, rules) {
    let changed = this.reachable !== true;
    if (this.error) {
      logger.info(`${this.label}: connection restored`);
    } else if (this.reachable === null) {
      logger.info(`${this.label}: connected, ${rawDoors.length} door(s)`);
    }
    this.resolved('read');
    this.reachable = true;
    this.error = null;

    this.devices = new Map(
      rawDevices
        .map(parseDevice)
        .filter(Boolean)
        .map((device) => [device.id, device]),
    );
    for (const device of this.devices.values()) {
      if (device.doorId) {
        this.deviceDoor.set(device.id, device.doorId);
      }
    }

    const seen = new Set();
    rawDoors.forEach((raw, index) => {
      const parsed = parseDoor(raw);
      if (!parsed) {
        return;
      }
      seen.add(parsed.id);
      const door = this.doors.get(parsed.id) ?? this.newDoor(parsed.id);
      const before = this.widgetView(door);
      door.name = parsed.name;
      door.fullName = parsed.fullName;
      door.lock = parsed.lock ?? door.lock;
      door.hasPositionSensor = parsed.hasPositionSensor;
      door.position = parsed.position;
      const rule = rules[index];
      if (rule === null) {
        door.ruleSupported = false;
        door.rule = null;
      } else if (rule) {
        door.rule = rule;
      }
      this.doors.set(door.id, door);
      changed ||= before !== this.widgetView(door);
    });
    for (const id of [...this.doors.keys()]) {
      if (!seen.has(id)) {
        this.doors.delete(id);
        changed = true;
      }
    }
    for (const door of this.doors.values()) {
      // A doorbell input on the hub, an intercom, or a door that already rang.
      door.doorbell =
        this.doorbellDoors.has(door.id) ||
        [...this.devices.values()].some((device) => device.doorId === door.id && device.doorbell);
    }
    await this.updateOnline();
    return changed;
  }

  newDoor(id) {
    return {
      id,
      name: id,
      fullName: '',
      lock: null,
      position: null,
      hasPositionSensor: false,
      alarms: [],
      unavailable: false,
      online: undefined,
      offlineSince: null,
      rule: null,
      ruleSupported: true,
      doorbell: this.doorbellDoors.has(id),
      ringing: false,
      lastAccess: this.history.find((entry) => entry.doorId === id) ?? null,
    };
  }

  /** What the widget shows of a door: a change asks for a refresh. */
  widgetView(door) {
    return JSON.stringify([
      door.name,
      door.lock,
      door.position,
      door.alarms,
      door.online,
      door.rule?.type,
    ]);
  }

  async applyFailure(err) {
    const wasError = this.error?.kind;
    this.error = { kind: err.kind, message: err.message };
    this.reachable = false;
    // One warning when the problem starts (or changes), not one per reading.
    if (wasError !== err.kind) {
      logger.warn(`${this.label}: ${err.message}`);
    } else {
      logger.debug(`${this.label}: ${err.message} (again)`);
    }
    return wasError !== err.kind;
  }

  /** A door is online when its hub is (any of its devices without a hub). */
  doorOnline(door) {
    if (door.unavailable) {
      return false;
    }
    const devices = [...this.devices.values()].filter((device) => device.doorId === door.id);
    const hubs = devices.filter((device) => device.hub);
    const relevant = hubs.length ? hubs : devices;
    if (relevant.length === 0) {
      return true;
    }
    return relevant.some((device) => device.online !== false);
  }

  /** Recompute the online state of every door; fire the transitions. */
  async updateOnline() {
    const events = [];
    for (const door of this.doors.values()) {
      const online = this.doorOnline(door);
      if (door.online === online) {
        continue;
      }
      const previous = door.online;
      door.online = online;
      if (previous === undefined) {
        if (!online) {
          door.offlineSince = this.now();
        }
        continue;
      }
      if (!online) {
        door.offlineSince = this.now();
        logger.info(`Door "${door.name}" is offline`);
        events.push([TRIGGERS.OFFLINE, door, {}]);
      } else {
        const downMinutes = door.offlineSince
          ? Math.round((this.now() - door.offlineSince) / 60_000)
          : 0;
        door.offlineSince = null;
        logger.info(`Door "${door.name}" is back online after ${downMinutes} min`);
        events.push([TRIGGERS.ONLINE, door, { down_minutes: downMinutes }]);
      }
    }
    for (const [key, door, data] of events) {
      await this.fire(key, door, data);
    }
    return events.length > 0;
  }

  // --- Notifications -------------------------------------------------------------

  async handlePacket(packet) {
    const changedDoors = new Set();
    let widgetChanged = false;
    for (const update of parseNotification(packet)) {
      logger.debug(`Notification ${packet.event}: ${update.kind}`);
      const result = await this.applyUpdate(update);
      for (const door of result?.doors ?? []) {
        changedDoors.add(door);
      }
      widgetChanged ||= Boolean(result?.widget);
    }
    if (changedDoors.size > 0) {
      await this.publishStates([...changedDoors]);
    }
    if (changedDoors.size > 0 || widgetChanged) {
      await this.afterChanges(widgetChanged);
    }
  }

  async applyUpdate(update) {
    switch (update.kind) {
      case 'door_devices':
        for (const deviceId of update.deviceIds) {
          this.deviceDoor.set(deviceId, update.doorId);
        }
        return null;
      case 'device':
        return this.applyDevice(update);
      case 'door_state':
        return this.applyDoorState(update);
      case 'door_name': {
        const door = this.doors.get(update.doorId);
        if (door && update.name && update.name !== door.name) {
          this.scheduleTopology();
        }
        return null;
      }
      case 'topology':
        this.scheduleTopology();
        return null;
      case 'doorbell':
        return this.applyDoorbell(update);
      case 'access':
        return this.applyAccess(update);
      default:
        return null;
    }
  }

  async applyDevice(update) {
    if (update.doorId) {
      this.deviceDoor.set(update.deviceId, update.doorId);
    }
    const device = this.devices.get(update.deviceId);
    if (!device) {
      return null; // a camera or a device not in the list yet
    }
    if (update.doorId) {
      device.doorId = update.doorId;
    }
    if (update.online !== null) {
      device.online = update.online;
    }
    const before = [...this.doors.values()].map((door) => door.online);
    const transitions = await this.updateOnline();
    const after = [...this.doors.values()].map((door) => door.online);
    return { doors: [], widget: transitions || JSON.stringify(before) !== JSON.stringify(after) };
  }

  async applyDoorState({ doorId, state }) {
    const door = this.doors.get(doorId);
    if (!door) {
      this.scheduleTopology(); // a door added since the last read
      return null;
    }
    const before = this.widgetView(door);
    if (state.lock) {
      door.lock = state.lock;
    }
    if (state.hasPositionSensor !== undefined) {
      // The feature list of a door follows the REST read (a sensor that
      // appears adds a feature: the user then updates the device).
      door.position = state.position;
    }
    let newAlarms = [];
    if (state.alarms) {
      newAlarms = state.alarms.filter((type) => !door.alarms.includes(type));
      door.alarms = state.alarms;
    }
    if (state.unavailable !== undefined) {
      door.unavailable = state.unavailable;
    }
    if (state.rule) {
      door.rule = door.ruleSupported ? state.rule : null;
    } else if (door.rule && door.rule.type !== RULES.NORMAL) {
      // The state did not mention the rule shown: it may have ended.
      this.scheduleRuleCheck(door);
    }
    await this.updateOnline();
    for (const type of newAlarms) {
      const kind = alarmKind(type);
      logger.info(`Door "${door.name}": alarm ${type}`);
      await this.fire(TRIGGERS.ALARM, door, {
        alarm: kind,
        alarm_type: type,
        alarm_label: pick(ALARM_TEXT[kind] ?? ALARM_TEXT[ALARMS.OTHER], this.language),
      });
    }
    return { doors: [door], widget: before !== this.widgetView(door) };
  }

  /** Find the door an event names: by id, by name, then by device. */
  resolveDoor({ doorId, doorRefs = [], deviceIds = [], doorName = '' }) {
    if (doorId && this.doors.has(doorId)) {
      return this.doors.get(doorId);
    }
    for (const ref of doorRefs) {
      if (this.doors.has(ref.id)) {
        return this.doors.get(ref.id);
      }
    }
    // The door entry of an access often carries the hub id: its name is safer.
    for (const name of [doorName, ...doorRefs.map((ref) => ref.name)]) {
      const matches = [...this.doors.values()].filter((door) => sameName(door.name, name));
      if (matches.length === 1) {
        return matches[0];
      }
    }
    for (const id of [doorId, ...doorRefs.map((ref) => ref.id), ...deviceIds]) {
      const mapped = id ? this.deviceDoor.get(id) : null;
      if (mapped && this.doors.has(mapped)) {
        return this.doors.get(mapped);
      }
    }
    return null;
  }

  /** Remember a key for `ttl` ms; false when it was already seen. */
  firstTime(map, key, ttl) {
    const now = this.now();
    for (const [seenKey, expiry] of map) {
      if (expiry <= now) {
        map.delete(seenKey);
      }
    }
    if (map.has(key)) {
      return false;
    }
    map.set(key, now + ttl);
    return true;
  }

  async applyDoorbell(update) {
    const door = this.resolveDoor({
      doorId: update.doorId,
      deviceIds: update.deviceIds,
      doorName: update.doorName,
    });
    const key = update.requestId || `door:${door?.id ?? update.doorName}`;
    if (!this.firstTime(this.seenRings, key, this.timings.doorbellDedupMs)) {
      return null;
    }
    if (door && !this.firstTime(this.seenRings, `door:${door.id}`, this.timings.doorbellDedupMs)) {
      return null; // the same ring, reported by the other event
    }
    logger.debug(`Doorbell at ${door ? `"${door.name}"` : 'an unknown door'}`);
    await this.fireRaw(TRIGGERS.DOORBELL, {
      door: door ? doorIds(this.gladys, door.id).device : null,
      door_name: door?.name ?? update.doorName,
      device_name: update.deviceName,
    });
    if (!door) {
      return null;
    }
    if (!door.doorbell) {
      // A door that rings has a doorbell: the feature appears at the next
      // publication (the user updates the device in the Discovery tab).
      door.doorbell = true;
      this.doorbellDoors.add(door.id);
      this.save();
      await this.publishDevices();
    }
    door.ringing = true;
    clearTimeout(this.pulseTimers.get(door.id));
    const timer = setTimeout(() => {
      this.pulseTimers.delete(door.id);
      door.ringing = false;
      this.publishStates([door]).catch(() => {});
    }, this.timings.doorbellPulseMs);
    timer.unref?.();
    this.pulseTimers.set(door.id, timer);
    return { doors: [door], widget: false };
  }

  async applyAccess(update) {
    const door = this.resolveDoor({
      doorRefs: update.doors,
      deviceIds: [...update.devices.map((ref) => ref.id), update.hubId],
    });
    const granted = update.result === 'ACCESS';
    const at = update.published ?? this.now();
    const doorKey = door?.id ?? update.doors[0]?.name ?? update.hubId;
    const key = `${doorKey}|${granted}|${update.published ?? `${update.user}|${update.message}`}`;
    if (!this.firstTime(this.seenAccess, key, this.timings.accessDedupMs)) {
      return null;
    }
    const method = accessMethod(update.provider);
    const access = {
      doorId: door?.id ?? null,
      doorName: door?.name ?? update.doors[0]?.name ?? '',
      granted,
      user: update.user,
      method,
      direction: update.direction,
      at,
    };
    logger.debug(
      `Access ${granted ? 'granted' : 'denied'} at "${access.doorName}" (${method}, ${update.provider})`,
    );
    this.history = [access, ...this.history].slice(0, this.timings.historySize);
    this.save();
    await this.fireRaw(granted ? TRIGGERS.GRANTED : TRIGGERS.DENIED, {
      door: door ? doorIds(this.gladys, door.id).device : null,
      door_name: access.doorName,
      user: access.user,
      method,
      method_label: pick(METHOD_TEXT[method], this.language),
      direction: access.direction,
    });
    if (!door) {
      return { doors: [], widget: true };
    }
    door.lastAccess = access;
    return { doors: [door], widget: true };
  }

  save() {
    this.store.save({ history: this.history, doorbellDoors: [...this.doorbellDoors] });
  }

  scheduleRuleCheck(door) {
    if (this.ruleTimers.has(door.id) || !this.client) {
      return;
    }
    const timer = setTimeout(async () => {
      this.ruleTimers.delete(door.id);
      try {
        const rule = parseLockRule(await this.client.getLockRule(door.id));
        if (JSON.stringify(rule) !== JSON.stringify(door.rule)) {
          door.rule = rule;
          await this.publishStates([door]);
          await this.afterChanges(true);
        }
      } catch (err) {
        logger.debug(`Lock rule of "${door.name}" not read: ${err.message}`);
      }
    }, this.timings.ruleCheckDelayMs);
    timer.unref?.();
    this.ruleTimers.set(door.id, timer);
  }

  scheduleTopology() {
    if (this.topologyTimer || !this.client) {
      return;
    }
    this.topologyTimer = setTimeout(() => {
      this.topologyTimer = null;
      this.refreshAndPublish().catch((err) => this.problem('poll', 'Refresh failed', err, 'error'));
    }, this.timings.topologyDelayMs);
    this.topologyTimer.unref?.();
  }

  // --- Publishing to Gladys ----------------------------------------------------------

  /** Publish the discovered doors when they changed (or `force`). */
  async publishDevices({ force = false } = {}) {
    const devices = [...this.doors.values()].map((door) =>
      buildDevice(this.gladys, door, this.language),
    );
    const signature = JSON.stringify(devices);
    if (!force && signature === this.devicesSignature) {
      return;
    }
    try {
      // Even an empty list: the Discovery tab then shows no stale door.
      await this.gladys.publishDiscoveredDevices(devices);
      this.devicesSignature = signature;
      this.resolved('devices');
    } catch (err) {
      this.problem('devices', `Devices refused by Gladys: ${err.message}`);
    }
  }

  async publishAllStates() {
    await this.publishStates([...this.doors.values()]);
  }

  /** Publish the states that changed (the SDK remembers the last ones). */
  async publishStates(doors) {
    const states = doors
      .filter((door) => this.doors.get(door.id) === door)
      .flatMap((door) => doorStates(this.gladys, door, this.language));
    for (let at = 0; at < states.length; at += MAX_STATES_PER_REQUEST) {
      try {
        await this.gladys.publishChangedStates(states.slice(at, at + MAX_STATES_PER_REQUEST), {
          heartbeat: this.timings.heartbeatMs,
        });
        this.resolved('states');
      } catch (err) {
        this.problem('states', `States refused by Gladys: ${err.message}`);
      }
    }
  }

  /** The user added a door: its states sent before were dropped by Gladys. */
  async onDeviceCreated(device) {
    const door = this.doorOfDevice(device.external_id);
    if (!door) {
      return;
    }
    this.gladys.forgetPublishedStates(device.external_id);
    await this.publishStates([door]);
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  async afterChanges(widgetChanged) {
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (widgetChanged) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  /** The transport badge of each door: local, unreachable, degraded without socket. */
  async publishTransports() {
    if (this.reachable === null) {
      return;
    }
    const degraded = this.socketError !== null;
    const entries = [];
    for (const door of this.doors.values()) {
      const entry = {
        external_id: doorIds(this.gladys, door.id).device,
        transport:
          this.reachable && door.online !== false
            ? DEVICE_TRANSPORTS.LOCAL
            : DEVICE_TRANSPORTS.UNREACHABLE,
      };
      if (degraded && entry.transport === DEVICE_TRANSPORTS.LOCAL) {
        entry.degraded = true;
        entry.message = CONNECTION_TEXT.noSocket;
      }
      if (this.transports.get(entry.external_id) !== JSON.stringify(entry)) {
        entries.push(entry);
      }
    }
    if (entries.length === 0) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      for (const entry of entries) {
        this.transports.set(entry.external_id, JSON.stringify(entry));
      }
      this.resolved('transports');
    } catch (err) {
      this.problem('transports', `Transports refused by Gladys: ${err.message}`);
    }
  }

  /** The status under the integration name. */
  connectionStatus() {
    const { host, hostTyped, token } = this.config;
    if (!host) {
      return {
        connected: false,
        message: hostTyped ? CONNECTION_TEXT.invalidHost : CONNECTION_TEXT.noHost,
      };
    }
    if (!token) {
      return { connected: false, message: CONNECTION_TEXT.noToken };
    }
    if (this.error) {
      return { connected: false, message: ERROR_TEXT[this.error.kind] };
    }
    if (this.socketError && this.socketError.kind !== ERROR_KINDS.UNREACHABLE) {
      // The REST answers but the socket is refused (permission, proxy).
      return { connected: true, message: CONNECTION_TEXT.noSocket };
    }
    return { connected: this.reachable !== false };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      this.resolved('connection-status');
    } catch (err) {
      this.problem('connection-status', `Connection status refused: ${err.message}`);
    }
  }

  /** Fire a scene trigger about a door. */
  fire(key, door, data) {
    return this.fireRaw(key, {
      door: doorIds(this.gladys, door.id).device,
      door_name: door.name,
      ...data,
    });
  }

  async fireRaw(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
      this.resolved('scene-event');
    } catch (err) {
      this.problem('scene-event', `Scene event ${key} refused: ${err.message}`);
    }
  }

  // --- Commands --------------------------------------------------------------------------

  /** The door of one of our device external ids, or null. */
  doorOfDevice(externalId) {
    if (typeof externalId !== 'string') {
      return null;
    }
    for (const door of this.doors.values()) {
      if (doorIds(this.gladys, door.id).device === externalId) {
        return door;
      }
    }
    return null;
  }

  /** The door a command targets; throws a message the user can read. */
  target(deviceExternalId) {
    if (!this.client || this.reachable === null) {
      throw new Error(pick(ACTION_TEXT.noConsole, this.language));
    }
    const door = this.doorOfDevice(deviceExternalId);
    if (!door) {
      throw new Error(pick(ACTION_TEXT.unknownDoor, this.language));
    }
    return door;
  }

  async command(door, run) {
    try {
      await run();
    } catch (err) {
      if (!(err instanceof AccessError)) {
        throw err;
      }
      logger.warn(`Door "${door.name}": command failed: ${err.message}`);
      if (err.kind === ERROR_KINDS.UNREACHABLE || err.kind === ERROR_KINDS.TLS) {
        await this.applyFailure(err);
        await this.afterChanges(true);
      }
      throw new Error(
        pick(
          err.kind === ERROR_KINDS.REFUSED ? ACTION_TEXT.failed : ERROR_TEXT[err.kind],
          this.language,
        ),
        { cause: err },
      );
    }
  }

  /** "Always locked" (keep_lock): safe, allowed without the remote unlock switch. */
  async keepLocked(deviceExternalId, origin) {
    const door = this.target(deviceExternalId);
    await this.command(door, () => this.client.setLockRule(door.id, RULES.KEEP_LOCK));
    logger.info(`Door "${door.name}": always locked (${origin})`);
    door.rule = door.ruleSupported ? { type: RULES.KEEP_LOCK, until: null } : null;
    door.lock = LOCK.LOCKED;
    await this.publishStates([door]);
    await this.afterChanges(true);
    return door;
  }

  /**
   * End the temporary rule (back to the normal schedule). Ending "always
   * locked" may unlock the door: allowed only with the remote unlock enabled.
   */
  async endRule(deviceExternalId, origin) {
    const door = this.target(deviceExternalId);
    const mayUnlock = !door.rule || door.rule.type === RULES.KEEP_LOCK;
    if (mayUnlock && !this.config.allowRemoteUnlock) {
      throw new Error(pick(ACTION_TEXT.resetBlocked, this.language));
    }
    await this.command(door, () => this.client.setLockRule(door.id, 'reset'));
    logger.info(`Door "${door.name}": temporary lock rule ended (${origin})`);
    door.rule = door.ruleSupported ? { type: RULES.NORMAL, until: null } : null;
    await this.publishStates([door]);
    this.scheduleRuleCheck(door);
    await this.afterChanges(true);
    return door;
  }

  /** Remote unlock: only when enabled in the configuration, scene action only. */
  async unlock(deviceExternalId, origin) {
    if (!this.config?.allowRemoteUnlock) {
      throw new Error(pick(ACTION_TEXT.unlockDisabled, this.language));
    }
    const door = this.target(deviceExternalId);
    await this.command(door, () => this.client.unlockDoor(door.id));
    logger.info(`Door "${door.name}": unlocked remotely (${origin})`);
    return door;
  }

  // --- Reports -------------------------------------------------------------------------------

  /** "Test the connection": read the console now. */
  async testConnection() {
    if (this.client) {
      await this.refreshAndPublish();
    }
    const status = this.connectionStatus();
    const message = {};
    for (const [language, text] of Object.entries(REPORT_TEXT)) {
      if (!this.client || this.error) {
        message[language] = pick(status.message, language);
        continue;
      }
      message[language] = [
        text.ok(this.doors.size, this.devices.size),
        this.socket?.connected ? text.socketOn : text.socketOff,
        this.config.allowRemoteUnlock ? text.unlockOn : text.unlockOff,
      ].join('\n');
    }
    return message;
  }
}

export { DEVICE_TYPE };
