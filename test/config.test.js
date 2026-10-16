import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, describeHost, normalizeConfig, parseHost } from '../src/config.js';

test('the console address accepts an IP, a name, a port or a URL from the browser', () => {
  assert.deepEqual(parseHost('192.0.2.1'), { hostname: '192.0.2.1', port: 12445 });
  assert.deepEqual(parseHost(' 192.0.2.1:8443 '), { hostname: '192.0.2.1', port: 8443 });
  assert.deepEqual(parseHost('unifi.local'), { hostname: 'unifi.local', port: 12445 });
  // The web interface URL (443) does not serve the developer API: its port.
  assert.deepEqual(parseHost('https://192.0.2.1/access/dashboard'), {
    hostname: '192.0.2.1',
    port: 12445,
  });
  assert.deepEqual(parseHost('https://192.0.2.1:12445'), { hostname: '192.0.2.1', port: 12445 });
  assert.deepEqual(parseHost('[2001:db8::1]'), { hostname: '2001:db8::1', port: 12445 });
});

test('an unusable address is refused, and so are credentials in it', () => {
  for (const raw of [
    '',
    '   ',
    null,
    42,
    'ftp://192.0.2.1',
    'http://',
    'https://admin:pw@192.0.2.1',
  ]) {
    assert.equal(parseHost(raw), null, String(raw));
  }
});

test('describeHost shows host:port', () => {
  assert.equal(describeHost({ hostname: '192.0.2.1', port: 12445 }), '192.0.2.1:12445');
  assert.equal(describeHost(parseHost('[2001:db8::1]:8443')), '[2001:db8::1]:8443');
});

test('the defaults are safe: no self-signed certificate, no remote unlock, French names', () => {
  const config = normalizeConfig(DEFAULT_CONFIG);
  assert.equal(config.host, null);
  assert.equal(config.hostTyped, false);
  assert.equal(config.token, '');
  assert.equal(config.allowSelfSigned, false);
  assert.equal(config.allowRemoteUnlock, false);
  assert.equal(config.language, 'fr');
  assert.deepEqual(normalizeConfig(undefined), config);
});

test('the configuration is normalized', () => {
  const config = normalizeConfig({
    host: 'nope://',
    api_token: '  token  ',
    allow_self_signed: 'true',
    allow_remote_unlock: true,
    language: 'de',
  });
  assert.equal(config.host, null);
  assert.equal(config.hostTyped, true);
  assert.equal(config.token, 'token');
  assert.equal(config.allowSelfSigned, true);
  assert.equal(config.allowRemoteUnlock, true);
  assert.equal(config.language, 'de');
  assert.equal(normalizeConfig({ language: 'it' }).language, 'fr');
  assert.equal(normalizeConfig({ allow_remote_unlock: 'yes' }).allowRemoteUnlock, false);
});
