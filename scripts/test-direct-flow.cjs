// Nearby-free call bootstrap: discovery by MAC, token derivation, and the
// authenticated direct-socket call signals. The legacy Nearby transport is
// intentionally not imported here; these tests prove the live path never uses it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');

function transpile(file) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
}

function loadModule(file, dependencies) {
  const m = { exports: {} };
  new Function('require', 'module', 'exports', transpile(file))(
    name => {
      assert.ok(name in dependencies, `unexpected dependency: ${name}`);
      return dependencies[name];
    },
    m, m.exports,
  );
  return m.exports;
}

const identity = loadModule('services/P2pIdentity.ts', {});

function fixture(overrides = {}) {
  let state = overrides.state || 'idle';
  let readyHandler;
  const dials = [], sends = [], pushes = [], alerts = [], services = { started: 0, stopped: 0 };
  const wifi = {
    getPeerP2pAddress: overrides.getPeerP2pAddress || (async () => 'F6:7D:EF:97:DA:68'),
    dialCall: overrides.dialCall || (async (id, mac, uuid) => {
      dials.push({ id, mac, uuid });
      // The native socket reports ready after the group forms.
      setImmediate(() => readyHandler?.({ sessionId: id, localIp: '192.168.49.2' }));
      return true;
    }),
    send: async (id, data) => { sends.push({ id, message: JSON.parse(data) }); return true; },
    stop: async () => true,
    onReady: fn => { readyHandler = fn; return { remove() { readyHandler = null; } }; },
    ...(overrides.wifi || {}),
  };
  const store = {
    myUUID: overrides.myUUID === undefined ? 'me-uuid' : overrides.myUUID,
    myDeviceName: 'My Phone', friends: [], settings: { ringtoneEnabled: true },
    getFriendByUUID: () => null, addCallRecord() {}, saveCallSession: async () => {},
  };
  const flow = loadModule('services/DirectCallFlow.ts', {
    'react-native': { Alert: { alert: (...args) => alerts.push(args) } },
    'expo-router': { router: { push: params => pushes.push(params) } },
    '../modules/DirectWifi': { default: wifi },
    './P2pIdentity': identity,
    './CallStateManager': { callStateManager: { getState: () => state } },
    './BackgroundAvailability': { callNotifications: {
      startCallService: async () => { services.started++; },
      stopCallService: async () => { services.stopped++; },
    } },
    '../store/appStore': { useAppStore: { getState: () => store } },
  });
  return {
    ...flow, dials, sends, pushes, alerts, services, wifi, store,
    setState: value => { state = value; },
  };
}

test('dial resolves the friend MAC, forms the group and announces over the socket', async () => {
  const f = fixture();
  const result = await f.dial('friend-uuid', 'Friend');
  assert.match(result.sessionId, /^[a-z0-9]+-[a-z0-9]+$/);
  assert.equal(result.localIp, '192.168.49.2');
  assert.equal(f.dials.length, 1);
  assert.equal(f.dials[0].mac, 'F6:7D:EF:97:DA:68');
  assert.equal(f.dials[0].uuid, 'friend-uuid');
  assert.equal(f.sends.length, 1);
  const request = f.sends[0].message;
  assert.equal(request.type, 'call-request');
  assert.equal(request.from, 'me-uuid');
  assert.equal(request.to, 'friend-uuid');
  assert.equal(request.data.mediaEngine, 'webrtc-direct-v2');
  assert.equal(request.data.callerName, 'My Phone');
  // The token is derived locally, never exchanged.
  assert.equal(request.data.token, identity.pairToken('me-uuid', 'friend-uuid', request.sessionId));
});

test('dial refuses the framework placeholder MAC and never opens the socket', async () => {
  const f = fixture({ getPeerP2pAddress: async () => '02:00:00:00:00:00' });
  await assert.rejects(f.dial('friend-uuid', 'Friend'), /not found over Wi-Fi Direct/);
  assert.equal(f.dials.length, 0);
  assert.equal(f.sends.length, 0);
});

test('dial needs a loaded identity before dialing', async () => {
  const f = fixture({ myUUID: null });
  await assert.rejects(f.dial('friend-uuid', 'Friend'), /identity is not ready/);
  assert.equal(f.dials.length, 0);
});

test('a failed call-request announcement is surfaced, not silently ignored', async () => {
  const f = fixture({ wifi: { send: async () => false } });
  await assert.rejects(f.dial('friend-uuid', 'Friend'), /Could not announce/);
});

test('accept, reject and end are distinct signals on the same socket', async () => {
  const f = fixture();
  await f.accept('session-1', 'caller-uuid');
  await f.reject('session-2', 'caller-uuid');
  await f.end('session-3', 'peer-uuid');
  assert.deepEqual(f.sends.map(s => [s.id, s.message.type]), [
    ['session-1', 'call-accept'],
    ['session-2', 'call-reject'],
    ['session-3', 'call-end'],
  ]);
  assert.equal(f.sends[0].message.data.token, undefined);
  assert.equal(f.sends[0].message.data.mediaEngine, 'webrtc-direct-v2');
});

test('placeDirectCall primes the call service, dials and routes with the direct params', async () => {
  const f = fixture();
  await f.placeDirectCall('friend-uuid', 'Friend');
  assert.equal(f.services.started, 1);
  assert.equal(f.pushes.length, 1);
  assert.equal(f.pushes[0].pathname, '/call');
  assert.equal(f.pushes[0].params.friendUUID, 'friend-uuid');
  assert.equal(f.pushes[0].params.localIp, '192.168.49.2');
  assert.ok(f.pushes[0].params.sessionId);
  assert.deepEqual(f.alerts, []);
});

test('placeDirectCall stops the primed service and shows one actionable alert on failure', async () => {
  const f = fixture({ getPeerP2pAddress: async () => null });
  await f.placeDirectCall('friend-uuid', 'Friend');
  assert.equal(f.services.started, 1);
  assert.equal(f.services.stopped, 1);
  assert.equal(f.pushes.length, 0);
  assert.equal(f.alerts.length, 1);
  assert.match(f.alerts[0][1], /not found over Wi-Fi Direct/);
});

test('placeDirectCall does nothing while another call is active', async () => {
  const f = fixture({ state: 'streaming' });
  await f.placeDirectCall('friend-uuid', 'Friend');
  assert.equal(f.services.started, 0);
  assert.equal(f.dials.length, 0);
  assert.equal(f.pushes.length, 0);
});

test('pending incoming state is single-slot and cleared by session', () => {
  const f = fixture();
  f.setPendingIncoming({ sessionId: 'one', from: 'a', callerName: 'A', localIp: '192.168.49.1' });
  assert.equal(f.peekPendingIncoming().sessionId, 'one');
  f.clearPendingIncoming('other');
  assert.equal(f.peekPendingIncoming().sessionId, 'one');
  f.clearPendingIncoming('one');
  assert.equal(f.peekPendingIncoming(), null);
});
