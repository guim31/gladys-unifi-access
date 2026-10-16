// -----------------------------------------------------------------------------
// An in-memory UniFi Access controller behind the transport seam of the
// client (src/access/transport.js): the REST answers of the developer API
// and the notification WebSocket. Its doors, devices and notifications are
// real captures (test/fixtures/access/, see its README), with the behaviors
// that matter: the API token (401 on REST and on the socket upgrade), the
// self-signed certificate, a console that does not answer, a firmware
// without lock rules, the lock rule and unlock commands.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

export const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/access/${name}.json`, import.meta.url), 'utf8'));

export const TOKEN = 'test-token-0123456789abcdef';

// Door ids of the fixtures (test/fixtures/access/doors.json).
export const DOORS = Object.freeze({
  GARAGE: '00000000-0000-0000-0000-00000000000e', // UA Hub Door Mini, sensor wired, open
  BACK: '00000000-0000-0000-0000-000000000002', // UA Ultra, offline
  FRONT: '00000000-0000-0000-0000-000000000006', // UA Hub + G2 Pro (doorbell), no sensor
});

const PREFIX = '/api/v1/developer';

const json = (status, body) => ({ status, body: JSON.stringify(body) });
const success = (data) => json(200, { code: 'SUCCESS', msg: 'success', data });

/** A WebSocket as the client sees it (the `ws` events it listens to). */
export class FakeSocket extends EventEmitter {
  constructor(server, headers) {
    super();
    this.server = server;
    this.headers = headers;
    this.readyState = 0;
    this.pings = 0;
    // Opened (or refused) asynchronously, like a real handshake.
    setImmediate(() => {
      if (this.readyState !== 0) {
        return;
      }
      const refusal = server.socketRefusal(headers);
      if (refusal) {
        this.readyState = 3;
        this.emit('error', refusal);
        this.emit('close', 1006, '');
        return;
      }
      this.readyState = 1;
      this.emit('open');
      this.emit('message', Buffer.from('Hello'));
    });
  }

  /** The controller sends a packet. */
  deliver(packet) {
    if (this.readyState === 1) {
      this.emit('message', Buffer.from(JSON.stringify(packet)));
    }
  }

  ping() {
    this.pings += 1;
  }

  terminate() {
    this.close();
  }

  close() {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    setImmediate(() => this.emit('close', 1000, ''));
  }
}

export class FakeAccess {
  /**
   * @param {object} [options]
   * @param {string} [options.token] the token the controller accepts
   * @param {boolean} [options.selfSigned] a certificate the system does not trust
   * @param {boolean} [options.lockRules] false: a firmware without lock rules (404)
   */
  constructor({ token = TOKEN, selfSigned = true, lockRules = true } = {}) {
    this.token = token;
    this.selfSigned = selfSigned;
    this.online = true;
    this.socketsAccepted = true;
    this.doors = structuredClone(fixture('doors').data);
    this.devices = structuredClone(fixture('devices').data);
    this.lockRulesSupported = lockRules;
    this.lockRules = new Map(this.doors.map((door) => [door.id, { type: '', ended_time: 0 }]));
    this.requests = [];
    this.sockets = [];
    this.unlocks = [];
    this.transport = {
      request: (options) => this.request(options),
      connect: (options) => this.connect(options),
    };
  }

  authorized(headers) {
    return headers?.Authorization === `Bearer ${this.token}`;
  }

  networkError(insecure) {
    if (!this.online) {
      return Object.assign(new Error('connect ECONNREFUSED 192.0.2.1:12445'), {
        code: 'ECONNREFUSED',
      });
    }
    if (this.selfSigned && !insecure) {
      return Object.assign(new Error('self-signed certificate'), {
        code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      });
    }
    return null;
  }

  async request({ method, path, headers, body, insecure }) {
    const failure = this.networkError(insecure);
    if (failure) {
      throw failure;
    }
    const parsed = body === undefined ? undefined : JSON.parse(body);
    this.requests.push({ method, path: path.replace(PREFIX, ''), headers, body: parsed });
    if (!this.authorized(headers)) {
      return json(401, { code: 'CODE_UNAUTHORIZED', msg: 'Unauthorized' });
    }
    return this.route(method, path.replace(PREFIX, ''), parsed);
  }

  route(method, path, body) {
    if (method === 'GET' && path === '/doors') {
      return success(this.doors);
    }
    if (method === 'GET' && path === '/devices') {
      return success(this.devices);
    }
    const rule = /^\/doors\/([^/]+)\/lock_rule$/.exec(path);
    if (rule) {
      const id = decodeURIComponent(rule[1]);
      if (!this.lockRulesSupported) {
        return json(404, { code: 'CODE_NOT_EXISTS', msg: 'not found' });
      }
      if (!this.lockRules.has(id)) {
        return json(200, { code: 'CODE_NOT_EXISTS', msg: 'door not found' });
      }
      if (method === 'GET') {
        return success(this.lockRules.get(id));
      }
      if (method === 'PUT') {
        const type = body?.type === 'reset' ? '' : body?.type;
        this.lockRules.set(id, { type, ended_time: 0 });
        return success({});
      }
    }
    const unlock = /^\/doors\/([^/]+)\/unlock$/.exec(path);
    if (unlock && method === 'PUT') {
      const id = decodeURIComponent(unlock[1]);
      this.unlocks.push({ id, body });
      const door = this.doors.find((d) => d.id === id);
      if (door) {
        door.door_lock_relay_status = 'unlock';
      }
      return success({});
    }
    return json(404, { code: 'CODE_RESOURCE_NOT_FOUND', msg: 'not found' });
  }

  socketRefusal(headers) {
    if (!this.authorized(headers)) {
      return new Error('Unexpected server response: 401');
    }
    if (!this.socketsAccepted) {
      return Object.assign(new Error('connect ECONNREFUSED 192.0.2.1:12445'), {
        code: 'ECONNREFUSED',
      });
    }
    return null;
  }

  connect({ path, headers, insecure }) {
    const failure = this.networkError(insecure);
    const socket = new FakeSocket(this, headers);
    this.sockets.push(socket);
    if (failure || path !== `${PREFIX}/devices/notifications`) {
      socket.readyState = 3;
      setImmediate(() => {
        socket.emit('error', failure ?? new Error('Unexpected server response: 404'));
        socket.emit('close', 1006, '');
      });
    }
    return socket;
  }

  /** The open notification sockets. */
  get openSockets() {
    return this.sockets.filter((socket) => socket.readyState === 1);
  }

  /** Send a packet to every open socket. */
  emit(packet) {
    for (const socket of this.openSockets) {
      socket.deliver(packet);
    }
  }

  /** Close every socket from the controller side. */
  dropSockets() {
    for (const socket of this.openSockets) {
      socket.close();
    }
  }

  door(id) {
    return this.doors.find((door) => door.id === id);
  }

  device(id) {
    return this.devices.flat().find((device) => device.id === id);
  }
}
