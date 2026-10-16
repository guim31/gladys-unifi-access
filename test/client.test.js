// -----------------------------------------------------------------------------
// The API client: how the answers of the developer API are read (success,
// refusals as HTTP statuses or as envelope codes), the requests it sends,
// and the real Node transport on the loopback interface (HTTP + WebSocket),
// so the headers and the socket upgrade are exercised for real.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import {
  AccessClient,
  AccessError,
  ERROR_KINDS,
  networkError,
  readEnvelope,
} from '../src/access/client.js';
import { NotificationSocket, socketError } from '../src/access/socket.js';
import { createNodeTransport } from '../src/access/transport.js';
import { FakeAccess, TOKEN, fixture } from './helpers/fakeAccess.js';

const kindOf = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AccessError);
    return err.kind;
  }
  return 'no error';
};

test('a SUCCESS envelope gives its data', () => {
  const doors = fixture('doors');
  assert.deepEqual(readEnvelope(200, JSON.stringify(doors), 'GET /doors'), doors.data);
});

test('the refusals are classified, as HTTP statuses or envelope codes', () => {
  const read = (status, body) => () =>
    readEnvelope(status, typeof body === 'string' ? body : JSON.stringify(body), 'GET /doors');
  assert.equal(kindOf(read(401, '')), ERROR_KINDS.AUTH);
  assert.equal(kindOf(read(200, { code: 'CODE_AUTH_FAILED', msg: 'bad' })), ERROR_KINDS.AUTH);
  // The native dialect: numeric code, its name in codeS.
  assert.equal(
    kindOf(read(200, { code: 1, codeS: 'CODE_ACCESS_TOKEN_INVALID' })),
    ERROR_KINDS.AUTH,
  );
  assert.equal(kindOf(read(403, { code: 'CODE_OPERATION_FORBIDDEN' })), ERROR_KINDS.FORBIDDEN);
  assert.equal(kindOf(read(404, '')), ERROR_KINDS.NOT_FOUND);
  assert.equal(kindOf(read(200, { code: 'CODE_NOT_EXISTS' })), ERROR_KINDS.NOT_FOUND);
  assert.equal(kindOf(read(429, '')), ERROR_KINDS.RATE_LIMIT);
  assert.equal(kindOf(read(200, '<html>UniFi OS</html>')), ERROR_KINDS.PROTOCOL);
  assert.equal(kindOf(read(200, { hello: 'world' })), ERROR_KINDS.PROTOCOL);
  // The refusal captured by hjdhjd/unifi-access on 2026-09-16.
  const refusal = {
    cloud_code: '',
    code: -3,
    codeS: 'CODE_SYSTEM_ERROR',
    error: 'CODE[-3];Mesg:;CauseBy:',
    msg: 'Server system error. ',
  };
  assert.equal(kindOf(read(200, refusal)), ERROR_KINDS.REFUSED);
  assert.equal(kindOf(read(500, { code: 'SUCCESS' })), ERROR_KINDS.REFUSED);
});

test('network errors: a refused certificate is told apart from silence', () => {
  const tls = networkError(
    Object.assign(new Error('x'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
    'GET /doors',
  );
  assert.equal(tls.kind, ERROR_KINDS.TLS);
  const down = networkError(Object.assign(new Error('x'), { code: 'EHOSTUNREACH' }), 'GET /doors');
  assert.equal(down.kind, ERROR_KINDS.UNREACHABLE);
  assert.equal(socketError(new Error('Unexpected server response: 401')).kind, ERROR_KINDS.AUTH);
  assert.equal(
    socketError(new Error('Unexpected server response: 403')).kind,
    ERROR_KINDS.FORBIDDEN,
  );
  assert.equal(
    socketError(new Error('Unexpected server response: 502')).kind,
    ERROR_KINDS.PROTOCOL,
  );
});

test('the client sends the token, the developer API paths and the commands', async () => {
  const controller = new FakeAccess();
  const client = new AccessClient({
    host: { hostname: '192.0.2.1', port: 12445 },
    token: TOKEN,
    insecure: true,
    transport: controller.transport,
  });
  assert.equal((await client.getDoors()).length, 3);
  const devices = await client.getDevices();
  assert.equal(devices.length, 5, 'the groups by door are flattened');
  const doorId = '00000000-0000-0000-0000-000000000006';
  assert.deepEqual(await client.getLockRule(doorId), { type: '', ended_time: 0 });
  await client.setLockRule(doorId, 'keep_lock');
  await client.unlockDoor(doorId);
  assert.deepEqual(
    controller.requests.map((r) => `${r.method} ${r.path}`),
    [
      'GET /doors',
      'GET /devices',
      `GET /doors/${doorId}/lock_rule`,
      `PUT /doors/${doorId}/lock_rule`,
      `PUT /doors/${doorId}/unlock`,
    ],
  );
  assert.deepEqual(controller.requests[3].body, { type: 'keep_lock' });
  assert.deepEqual(controller.requests[4].body, { actor_id: 'gladys', actor_name: 'Gladys' });
  assert.equal(controller.requests[0].headers.Authorization, `Bearer ${TOKEN}`);
});

test('the errors never carry the token', async () => {
  const controller = new FakeAccess();
  const wrong = 'wrong-token-that-must-not-leak';
  const client = new AccessClient({
    host: { hostname: '192.0.2.1', port: 12445 },
    token: wrong,
    insecure: true,
    transport: controller.transport,
  });
  await assert.rejects(client.getDoors(), (err) => {
    assert.equal(err.kind, ERROR_KINDS.AUTH);
    assert.ok(!err.message.includes(wrong));
    return true;
  });
  const strict = new AccessClient({
    host: { hostname: '192.0.2.1', port: 12445 },
    token: TOKEN,
    transport: controller.transport,
  });
  await assert.rejects(strict.getDoors(), { kind: ERROR_KINDS.TLS });
});

// --- The real Node transport, on the loopback interface ------------------------

async function loopbackController() {
  const doors = fixture('doors');
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'CODE_UNAUTHORIZED', msg: 'Unauthorized' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(req.url === '/api/v1/developer/doors' ? doors : { code: 'SUCCESS', data: [] }),
    );
  });
  const sockets = new WebSocketServer({
    server,
    path: '/api/v1/developer/devices/notifications',
    verifyClient: ({ req }) => req.headers.authorization === `Bearer ${TOKEN}`,
  });
  sockets.on('connection', (socket) => {
    socket.send('Hello');
    socket.send(JSON.stringify({ event: 'access.base.info', data: { top_log_count: 0 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const client of sockets.clients) {
          client.terminate();
        }
        sockets.close();
        server.close(resolve);
      }),
  };
}

test('the Node transport sends the token over HTTP and the WebSocket upgrade', async (t) => {
  const controller = await loopbackController();
  t.after(() => controller.close());
  const host = { hostname: '127.0.0.1', port: controller.port };
  const transport = createNodeTransport({ secure: false });

  const client = new AccessClient({ host, token: TOKEN, transport });
  assert.equal((await client.getDoors()).length, 3);
  const refused = new AccessClient({ host, token: 'nope', transport });
  await assert.rejects(refused.getDoors(), { kind: ERROR_KINDS.AUTH });

  const packets = [];
  const opened = new Promise((resolve) => {
    const socket = new NotificationSocket({
      open: () => client.openNotifications(),
      onPacket: (packet) => {
        packets.push(packet);
        socket.stop();
        resolve();
      },
      onOpen: () => {},
      onClose: () => {},
      timers: false,
    });
    socket.start();
  });
  await opened;
  assert.deepEqual(packets, [{ event: 'access.base.info', data: { top_log_count: 0 } }]);

  const closed = await new Promise((resolve) => {
    const socket = new NotificationSocket({
      open: () => refused.openNotifications(),
      onPacket: () => {},
      onOpen: () => {},
      onClose: resolve,
      timers: false,
    });
    socket.start();
  });
  assert.equal(closed.kind, ERROR_KINDS.AUTH, 'a refused token on the upgrade');
});

test('the Node transport reports a console that does not answer', async () => {
  const client = new AccessClient({
    host: { hostname: '127.0.0.1', port: 1 },
    token: TOKEN,
    transport: createNodeTransport({ secure: false }),
    timeoutMs: 2000,
  });
  await assert.rejects(client.getDoors(), { kind: ERROR_KINDS.UNREACHABLE });
});
