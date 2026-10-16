// -----------------------------------------------------------------------------
// The notification WebSocket of UniFi Access (`/devices/notifications`):
// an outgoing connection from the container, kept open for life, reopened
// with a growing delay (1 s, 2 s, 4 s… 1 min) when it drops.
//
// The controller sends "Hello" first, then one JSON packet per event. A ping
// every 30 s detects a socket that died silently (console rebooted, Wi-Fi
// bridge dropped): no pong before the next ping → closed and reopened.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { AccessError, ERROR_KINDS, networkError } from './client.js';

const logger = createLogger({ name: 'unifi-access-socket' });

export const SOCKET_TIMINGS = {
  minDelayMs: 1_000,
  maxDelayMs: 60_000,
  pingMs: 30_000,
};

/** The error a failed WebSocket opening stands for. */
export function socketError(err) {
  const status = Number(/Unexpected server response: (\d+)/.exec(err?.message ?? '')?.[1]);
  const what = 'notification socket';
  if (status === 401) {
    return new AccessError(ERROR_KINDS.AUTH, `${what}: token refused (HTTP 401)`, { status });
  }
  if (status === 403) {
    return new AccessError(ERROR_KINDS.FORBIDDEN, `${what}: permission missing (HTTP 403)`, {
      status,
    });
  }
  if (status) {
    return new AccessError(ERROR_KINDS.PROTOCOL, `${what}: refused (HTTP ${status})`, { status });
  }
  return networkError(err, what);
}

export class NotificationSocket {
  /**
   * @param {object} options
   * @param {() => object} options.open opens a socket (AccessClient.openNotifications)
   * @param {(packet: object) => void} options.onPacket
   * @param {() => void} options.onOpen
   * @param {(error: AccessError|null) => void} options.onClose
   * @param {boolean} [options.timers] reconnection and ping timers (off in tests)
   * @param {object} [options.timings] SOCKET_TIMINGS overrides
   */
  constructor({ open, onPacket, onOpen, onClose, timers = true, timings }) {
    this.open = open;
    this.onPacket = onPacket;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.timersEnabled = timers;
    this.timings = { ...SOCKET_TIMINGS, ...timings };
    this.socket = null;
    this.connected = false;
    this.stopped = true;
    this.delay = this.timings.minDelayMs;
    this.retryTimer = null;
    this.pingTimer = null;
    this.alive = true;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.drop();
  }

  /** Reopen now (tests, or a configuration change). */
  reconnectNow() {
    clearTimeout(this.retryTimer);
    this.drop();
    if (!this.stopped) {
      this.connect();
    }
  }

  drop() {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners?.();
      socket.on?.('error', () => {}); // a late error of a dropped socket
      try {
        socket.close?.();
      } catch {
        // already closed
      }
    }
    this.connected = false;
  }

  connect() {
    let socket;
    try {
      socket = this.open();
    } catch (err) {
      this.closed(socketError(err));
      return;
    }
    this.socket = socket;
    let failure = null;
    socket.on('open', () => {
      if (this.socket !== socket) {
        return;
      }
      this.connected = true;
      this.delay = this.timings.minDelayMs;
      this.startPing(socket);
      this.onOpen();
    });
    socket.on('message', (data) => {
      if (this.socket !== socket) {
        return;
      }
      this.alive = true;
      const text = typeof data === 'string' ? data : data.toString('utf8');
      let packet;
      try {
        packet = JSON.parse(text);
      } catch {
        logger.debug(`Notification ignored (not JSON): ${text.slice(0, 40)}`);
        return;
      }
      try {
        this.onPacket(packet);
      } catch (err) {
        logger.error('Notification handling failed', err);
      }
    });
    socket.on('pong', () => {
      this.alive = true;
    });
    socket.on('error', (err) => {
      failure = socketError(err);
    });
    socket.on('close', () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      this.closed(failure);
    });
  }

  closed(error) {
    clearInterval(this.pingTimer);
    this.connected = false;
    this.onClose(error);
    if (this.stopped || !this.timersEnabled) {
      return;
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (!this.stopped) {
        this.connect();
      }
    }, this.delay);
    this.retryTimer.unref?.();
    // A refused token will not be accepted sooner: wait the longest delay.
    this.delay =
      error?.kind === ERROR_KINDS.AUTH
        ? this.timings.maxDelayMs
        : Math.min(this.delay * 2, this.timings.maxDelayMs);
  }

  startPing(socket) {
    clearInterval(this.pingTimer);
    if (!this.timersEnabled || typeof socket.ping !== 'function') {
      return;
    }
    this.alive = true;
    this.pingTimer = setInterval(() => {
      if (this.socket !== socket) {
        return;
      }
      if (!this.alive) {
        logger.debug('Notification socket silent, reopening');
        socket.terminate?.();
        return;
      }
      this.alive = false;
      try {
        socket.ping();
      } catch {
        // closing: the close event follows
      }
    }, this.timings.pingMs);
    this.pingTimer.unref?.();
  }
}
