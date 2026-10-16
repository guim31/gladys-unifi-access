// -----------------------------------------------------------------------------
// Network seam of the UniFi Access client: one HTTPS request, one WebSocket.
// The client (src/access/client.js) and the notification socket only talk to
// this object, so the tests replace it with an in-memory fake controller
// (test/helpers/fakeAccess.js) and never touch the network.
//
// `ws` is used for the notification socket because the WebSocket built into
// Node can neither send an `Authorization` header nor accept the self-signed
// certificate every UniFi console serves.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import WebSocket from 'ws';

// Node error codes of a certificate the system does not trust.
const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Whether a Node network error is a refused certificate. */
export const isTlsError = (err) =>
  TLS_CODES.has(err?.code) || /certificate|self[- ]signed/i.test(err?.message ?? '');

/**
 * @param {object} [options]
 * @param {boolean} [options.secure] HTTPS/WSS (default); plain HTTP only for
 *   the loopback test of this module
 */
export function createNodeTransport({ secure = true } = {}) {
  const lib = secure ? https : http;
  return {
    /**
     * @returns {Promise<{ status: number, body: string }>}
     */
    request({ hostname, port, method, path, headers, body, insecure, timeoutMs }) {
      return new Promise((resolve, reject) => {
        const req = lib.request(
          {
            hostname,
            port,
            method,
            path,
            headers,
            rejectUnauthorized: !insecure,
            timeout: timeoutMs,
          },
          (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () =>
              resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
            );
            res.on('error', reject);
          },
        );
        req.on('timeout', () => {
          const err = new Error(`No answer within ${timeoutMs} ms`);
          err.code = 'ETIMEDOUT';
          req.destroy(err);
        });
        req.on('error', reject);
        if (body !== undefined) {
          req.write(body);
        }
        req.end();
      });
    },

    /**
     * Open a WebSocket; the returned object emits `open`, `message` (text),
     * `close` and `error`, and has `close()`.
     */
    connect({ hostname, port, path, headers, insecure, timeoutMs }) {
      const host = hostname.includes(':') ? `[${hostname}]` : hostname;
      return new WebSocket(`${secure ? 'wss' : 'ws'}://${host}:${port}${path}`, {
        headers,
        rejectUnauthorized: !insecure,
        handshakeTimeout: timeoutMs,
      });
    },
  };
}
