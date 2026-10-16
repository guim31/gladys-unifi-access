// -----------------------------------------------------------------------------
// Client of the official UniFi Access API ("developer API"), served by the
// console on port 12445 under /api/v1/developer, authenticated by an API
// token created in UniFi Access (Settings > General > Advanced > API Token).
//
// Every answer is an envelope `{ code: "SUCCESS", msg, data }`. A refusal can
// come as an HTTP status (401, 403, 404, 429) or as an HTTP 200 whose `code`
// names the error (`CODE_AUTH_FAILED`…); some firmwares answer with a numeric
// `code` and the name in `codeS`. Both are read.
//
// Only the endpoints the integration needs: doors, devices, lock rules, the
// remote unlock (off by default, see src/hub.js) and the notification socket.
// -----------------------------------------------------------------------------

import { isTlsError } from './transport.js';

export const API_PREFIX = '/api/v1/developer';

export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable', // no answer: address, port, network
  TLS: 'tls', // self-signed certificate not accepted in the configuration
  AUTH: 'auth', // token refused
  FORBIDDEN: 'forbidden', // token valid, permission missing
  NOT_FOUND: 'not_found', // endpoint or door unknown (old firmware)
  RATE_LIMIT: 'rate_limit',
  REFUSED: 'refused', // the controller refused the operation
  PROTOCOL: 'protocol', // not the UniFi Access API (wrong port, another service)
});

const AUTH_CODES = new Set(['CODE_AUTH_FAILED', 'CODE_ACCESS_TOKEN_INVALID', 'CODE_UNAUTHORIZED']);
const NOT_FOUND_CODES = new Set(['CODE_NOT_EXISTS', 'CODE_RESOURCE_NOT_FOUND']);

export class AccessError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message never carries the token
   * @param {{ status?: number, code?: string }} [details]
   */
  constructor(kind, message, { status, code } = {}) {
    super(message);
    this.name = 'AccessError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

const codeName = (envelope) =>
  typeof envelope?.code === 'string'
    ? envelope.code
    : typeof envelope?.codeS === 'string'
      ? envelope.codeS
      : null;

/**
 * Read an answer of the API: its `data`, or the AccessError it describes.
 * @param {number} status HTTP status
 * @param {string} text body
 * @param {string} what "GET /doors", for the messages
 */
export function readEnvelope(status, text, what) {
  let envelope;
  try {
    envelope = text ? JSON.parse(text) : null;
  } catch {
    envelope = null;
  }
  const code = codeName(envelope);
  const msg = typeof envelope?.msg === 'string' && envelope.msg ? `: ${envelope.msg}` : '';
  const fail = (kind, label) =>
    new AccessError(kind, `${what}: ${label}${code ? ` (${code})` : ''}${msg}`, { status, code });

  if (status === 401 || AUTH_CODES.has(code)) {
    throw fail(ERROR_KINDS.AUTH, `token refused (HTTP ${status})`);
  }
  if (status === 403 || code === 'CODE_OPERATION_FORBIDDEN') {
    throw fail(ERROR_KINDS.FORBIDDEN, `permission missing (HTTP ${status})`);
  }
  if (status === 404 || NOT_FOUND_CODES.has(code)) {
    throw fail(ERROR_KINDS.NOT_FOUND, `not found (HTTP ${status})`);
  }
  if (status === 429) {
    throw fail(ERROR_KINDS.RATE_LIMIT, 'too many requests (HTTP 429)');
  }
  if (!envelope || typeof envelope !== 'object' || code === null) {
    throw fail(ERROR_KINDS.PROTOCOL, `not a UniFi Access answer (HTTP ${status})`);
  }
  if (code !== 'SUCCESS' || status < 200 || status >= 300) {
    throw fail(ERROR_KINDS.REFUSED, `refused (HTTP ${status})`);
  }
  return envelope.data;
}

/** Turn a network error into an AccessError (never the token, never the full URL). */
export function networkError(err, what) {
  if (err instanceof AccessError) {
    return err;
  }
  if (isTlsError(err)) {
    return new AccessError(
      ERROR_KINDS.TLS,
      `${what}: certificate not trusted (${err.code ?? 'TLS'})`,
    );
  }
  return new AccessError(
    ERROR_KINDS.UNREACHABLE,
    `${what}: no answer (${err?.code ?? err?.message ?? 'network error'})`,
  );
}

export class AccessClient {
  /**
   * @param {object} options
   * @param {{ hostname: string, port: number }} options.host
   * @param {string} options.token API token
   * @param {boolean} [options.insecure] accept a self-signed certificate
   * @param {object} options.transport src/access/transport.js (or a fake)
   * @param {number} [options.timeoutMs]
   */
  constructor({ host, token, insecure = false, transport, timeoutMs = 10_000 }) {
    this.host = host;
    this.token = token;
    this.insecure = insecure;
    this.transport = transport;
    this.timeoutMs = timeoutMs;
  }

  get headers() {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/json' };
  }

  async call(method, path, body) {
    const what = `${method} ${path}`;
    let answer;
    try {
      answer = await this.transport.request({
        hostname: this.host.hostname,
        port: this.host.port,
        method,
        path: `${API_PREFIX}${path}`,
        headers:
          body === undefined
            ? this.headers
            : { ...this.headers, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        insecure: this.insecure,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      throw networkError(err, what);
    }
    return readEnvelope(answer.status, answer.body, what);
  }

  /** Every door of the site. */
  async getDoors() {
    const data = await this.call('GET', '/doors');
    return Array.isArray(data) ? data : [];
  }

  /** Every device; the API groups them by door, flattened here. */
  async getDevices() {
    const data = await this.call('GET', '/devices');
    return Array.isArray(data)
      ? data.flatMap((group) => (Array.isArray(group) ? group : [group]))
      : [];
  }

  /** The temporary lock rule of a door (`{ type, ended_time }`). */
  getLockRule(doorId) {
    return this.call('GET', `/doors/${encodeURIComponent(doorId)}/lock_rule`);
  }

  /** Set (`keep_lock`) or end (`reset`) the temporary lock rule of a door. */
  async setLockRule(doorId, type) {
    await this.call('PUT', `/doors/${encodeURIComponent(doorId)}/lock_rule`, { type });
  }

  /** Remote unlock, signed "Gladys" in the UniFi Access system log. */
  async unlockDoor(doorId) {
    await this.call('PUT', `/doors/${encodeURIComponent(doorId)}/unlock`, {
      actor_id: 'gladys',
      actor_name: 'Gladys',
    });
  }

  /** Open the notification WebSocket (see src/access/socket.js). */
  openNotifications() {
    return this.transport.connect({
      hostname: this.host.hostname,
      port: this.host.port,
      path: `${API_PREFIX}/devices/notifications`,
      headers: { Authorization: `Bearer ${this.token}` },
      insecure: this.insecure,
      timeoutMs: this.timeoutMs,
    });
  }
}
