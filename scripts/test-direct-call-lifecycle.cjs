const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../services/DirectCallAudio.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); await new Promise(r => setTimeout(r, 5)); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t, options = {}) {
  const handlers = {}, signals = new Map(), sent = [], pcs = [], stops = [], joins = [], errors = [], tracks = [], events = [];
  let stopGate, mediaGate, releaseGate, readyGate, autoReady = true, autoClose = true;
  const subscribe = key => fn => {
    handlers[key] = fn;
    return { remove() { if (handlers[key] === fn) delete handlers[key]; } };
  };
  const credentials = { token: 'a'.repeat(64), peerP2pAddress: 'aa:bb:cc:dd:ee:ff' };
  function acknowledge(id = 'test', overrides = {}) {
    const signal = { sessionId: id, from: 'peer',
      data: { mediaEngine: 'webrtc-direct-v2', peerP2pAddress: credentials.peerP2pAddress }, ...overrides.signal };
    signals.get('direct-ready')?.({ signal, connectionId: overrides.connectionId || 'endpoint' });
  }
  const wifi = {
    prepareGroup: async () => { events.push('plan'); return { token: credentials.token }; },
    // Each side discovers the OTHER phone's address; it never reads its own.
    getPeerP2pAddress: async () => { events.push('address'); return '66:55:44:33:22:11'; },
    // Ring-time head start; opportunistic and silent — it must not disturb the
    // event-ordering assertions below, which describe the call flow itself.
    warmUpPeerDiscovery: async () => {},
    connectPeer: async (id, address, isCaller, token) => {
      assert.equal(address, '66:55:44:33:22:11'); assert.equal(token, credentials.token);
      events.push('connect:' + (isCaller ? 'caller' : 'callee') + ':' + id); joins.push(id); return true;
    },
    send: async (id, data) => { sent.push(JSON.parse(data)); return true; },
    stop: async id => { events.push('stop:' + id); stops.push(id); if (stopGate) await stopGate.promise; return true; },
    startAudio: async () => true,
    speaker() {},
    onReady: subscribe('ready'), onSignal: subscribe('signal'), onError: subscribe('error'),
  };
  class PC {
    constructor() { this.events = {}; this.signalingState = 'stable'; this.connectionState = 'new'; pcs.push(this); }
    addEventListener(name, handler) { this.events[name] = handler; }
    addTrack() {}
    async createOffer(options) { this.offerOptions = options; return { type: 'offer', sdp: 'v=0\r\n' }; }
    async setLocalDescription(value) { this.localDescription = value; this.signalingState = 'have-local-offer'; }
    async setRemoteDescription(value) { this.remoteDescription = value; this.signalingState = 'stable'; }
    async addIceCandidate() {}
    async getStats() { return new Map(); }
    close() { this.closed = true; }
  }
  const dependencies = {
    'react-native-webrtc': { RTCPeerConnection: PC, mediaDevices: { getUserMedia: async () => {
      const track = { stopped: false, stop() { this.stopped = true; } }; tracks.push(track);
      if (mediaGate) await mediaGate.promise;
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    } } },
    '../modules/DirectWifi': { default: wifi },
    '../modules/Nearby': { default: {
      onConnectionClosed: subscribe('closed'),
      releaseForDirectCall: async id => { events.push('release:' + id); if (releaseGate) await releaseGate.promise; events.push('released:' + id); return true; },
      resumeAfterDirectCall: async id => { events.push('resume:' + id); return true; },
    } },
    './CallSignaling': { signalingManager: {
      getActiveConnection: () => 'endpoint',
      on: (event, fn) => signals.set(event, fn),
      off: (event, fn) => { if (signals.get(event) === fn) signals.delete(event); },
      sendDirectConfig: async (peer, id, direct) => {
        assert.deepEqual(direct, { peerP2pAddress: '66:55:44:33:22:11', token: credentials.token });
        events.push('config:' + id);
        if (autoReady) { acknowledge(id); if (autoClose) handlers.closed?.({ connectionId: 'endpoint' }); }
        return true;
      },
      sendDirectReady: async (peer, id, address) => {
        assert.equal(address, '66:55:44:33:22:11');
        events.push('ack:' + id); if (readyGate) return readyGate.promise; return true;
      },
    } },
    './NearbyDiscoveryService': { nearbyDiscoveryService: { stopDiscovery: async () => {} } },
  };
  const m = { exports: {} };
  new Function('require', 'module', 'exports', 'setTimeout', compiled)(name => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`);
    return dependencies[name];
  }, m, m.exports, (fn, ms) => setTimeout(fn, (ms === 8000 || ms === 25000) && options.ackTimeout ? options.ackTimeout : ms));
  const service = new m.exports.DirectCallAudio();
  t.after(async () => { stopGate?.resolve(); mediaGate?.resolve(); releaseGate?.resolve(); readyGate?.resolve(false); await service.stop(); await flush(); });
  return {
    service, sent, pcs, stops, joins, errors, tracks, events, signals, acknowledge,
    start(id = 'test', role = 'caller') {
      const result = service.start(role, 'peer', id, { onError: e => errors.push(e), onStatus() {} }, credentials);
      result.catch(() => {});
      return result;
    },
    ready(id = 'test') { handlers.ready?.({ sessionId: id, localIp: '192.168.49.2' }); },
    signal(type, data = {}, id = 'test') {
      handlers.signal?.({ sessionId: id, data: JSON.stringify({ sessionId: id, type, ...data }) });
    },
    blockStop() { stopGate = deferred(); return stopGate; },
    blockMedia() { mediaGate = deferred(); return mediaGate; },
    blockRelease() { releaseGate = deferred(); return releaseGate; },
    blockAck() { readyGate = deferred(); return readyGate; },
    manualAck() { autoReady = false; },
    manualClose() { autoClose = false; },
    closeEndpoint(connectionId = 'endpoint') { handlers.closed?.({ connectionId }); },
    hasCloseListener() { return !!handlers.closed; },
  };
}

test('first peer-ready arriving after the initial answer cannot start a second offer', async t => {
  const f = fixture(t); f.start(); await flush(); f.ready(); await flush();
  assert.equal(f.sent.filter(s => s.type === 'offer').length, 1);
  f.signal('answer', { sdp: { type: 'answer', sdp: 'v=0\r\n' } }); await flush();
  assert.equal(f.pcs[0].signalingState, 'stable');
  f.signal('ready'); f.signal('ready'); await flush();
  assert.equal(f.sent.filter(s => s.type === 'offer').length, 1);
});

test('initial-offer deduplication does not block an explicit ICE restart', async t => {
  const f = fixture(t); f.start(); await flush(); f.ready(); await flush();
  f.signal('answer', { sdp: { type: 'answer', sdp: 'v=0\r\n' } }); await flush();
  f.signal('restart'); await flush();
  assert.equal(f.sent.filter(s => s.type === 'offer').length, 2);
  assert.equal(f.pcs[0].offerOptions.iceRestart, true);
});

test('a replacement call waits for the previous native stop before joining', async t => {
  const f = fixture(t); const first = f.start('first'); await flush();
  const cleanup = f.blockStop(); f.service.stop();
  await assert.rejects(first, /Call stopped/);
  f.start('second'); await flush();
  assert.deepEqual(f.joins, ['first']); assert.deepEqual(f.stops, ['first']);
  cleanup.resolve(); await flush();
  assert.deepEqual(f.joins, ['first', 'second']);
  assert.equal(f.service.isStartingOrActive('second'), true);
});

test('a call cancelled while waiting for old cleanup never joins afterward', async t => {
  const f = fixture(t); f.start('first'); await flush();
  const cleanup = f.blockStop(); f.service.stop(); const next = f.start('second');
  await flush(); f.service.stop(); await assert.rejects(next, /Call stopped/);
  cleanup.resolve(); await flush();
  assert.deepEqual(f.joins, ['first']);
  assert.deepEqual(f.stops, ['first', 'second']);
});

test('late microphone failure from a cancelled call cannot fail the replacement call', async t => {
  const f = fixture(t); const media = f.blockMedia(); const first = f.start('first');
  await flush(); f.ready('first'); await flush(); f.service.stop();
  await assert.rejects(first, /Call stopped/);
  f.start('second'); await flush(); media.reject(new Error('Old capture failed')); await flush();
  assert.equal(f.service.isStartingOrActive('second'), true);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.joins, ['first', 'second']);
});

test('callee plans and sends credentials before release; a synchronous valid ack is not lost', async t => {
  const f = fixture(t); f.start('test', 'callee'); await flush();
  assert.deepEqual(f.events, ['address', 'plan', 'config:test', 'release:test', 'released:test', 'connect:callee:test']);
  assert.equal(f.signals.size, 0);
});

test('callee will not release Nearby for an ack from another endpoint, peer, session, or version', async t => {
  const f = fixture(t); f.manualAck(); f.start('test', 'callee'); await flush();
  assert.deepEqual(f.events, ['address', 'plan', 'config:test']);
  f.acknowledge('test', { connectionId: 'intruder' });
  f.acknowledge('test', { signal: { from: 'intruder' } });
  f.acknowledge('old');
  f.acknowledge('test', { signal: { data: { mediaEngine: 'webrtc-direct-v1' } } });
  await flush(); assert.deepEqual(f.events, ['address', 'plan', 'config:test']);
  f.acknowledge(); f.closeEndpoint(); await flush();
  assert.deepEqual(f.events.slice(-3), ['release:test', 'released:test', 'connect:callee:test']);
});

test('an ack with no discovered address fails without releasing Nearby', async t => {
  const f = fixture(t); f.manualAck(); const start = f.start('test', 'callee'); await flush();
  f.acknowledge('test', { signal: { data: { mediaEngine: 'webrtc-direct-v2' } } });
  f.closeEndpoint();
  await assert.rejects(start, /did not confirm direct setup/); await flush();
  assert.equal(f.signals.size, 0);
  assert.deepEqual(f.events, ['address', 'plan', 'config:test', 'stop:test', 'resume:test']);
});

test('an ack carrying the placeholder address 02:00:00:00:00:00 fails without releasing Nearby', async t => {
  const f = fixture(t); f.manualAck(); const start = f.start('test', 'callee'); await flush();
  f.acknowledge('test', { signal: { data: { mediaEngine: 'webrtc-direct-v2', peerP2pAddress: '02:00:00:00:00:00' } } });
  f.closeEndpoint();
  await assert.rejects(start, /did not confirm direct setup/); await flush();
  assert.equal(f.signals.size, 0);
  assert.deepEqual(f.events, ['address', 'plan', 'config:test', 'stop:test', 'resume:test']);
});

test('caller waits for delivery-confirmed ack before releasing Nearby and joining', async t => {
  const f = fixture(t), ack = f.blockAck(); f.start(); await flush();
  assert.deepEqual(f.events, ['address', 'ack:test']);
  ack.resolve(true); await flush();
  assert.deepEqual(f.events, ['address', 'ack:test', 'release:test', 'released:test', 'connect:caller:test']);
});

test('failed ack never releases Nearby or creates a competing direct group', async t => {
  const f = fixture(t), ack = f.blockAck(), start = f.start(); await flush();
  ack.resolve(false); await assert.rejects(start, /Could not confirm/); await flush();
  assert.equal(f.events.some(e => e.startsWith('release:') || e.startsWith('join:')), false);
  assert.deepEqual(f.events, ['address', 'ack:test', 'stop:test', 'resume:test']);
});

test('cancelling while waiting for peer handoff removes the listener and never creates a group', async t => {
  const f = fixture(t); f.manualAck(); const start = f.start('test', 'callee'); await flush();
  await f.service.stop(); await assert.rejects(start, /Call stopped/); f.acknowledge(); await flush();
  assert.equal(f.signals.size, 0);
  assert.deepEqual(f.events, ['address', 'plan', 'config:test', 'stop:test', 'resume:test']);
});

test('missing peer handoff ack times out without releasing Nearby or creating a group', async t => {
  const f = fixture(t, { ackTimeout: 20 }); f.manualAck(); const start = f.start('test', 'callee');
  await assert.rejects(start, /did not confirm direct setup/); await flush();
  assert.equal(f.signals.size, 0);
  assert.deepEqual(f.events, ['address', 'plan', 'config:test', 'stop:test', 'resume:test']);
});

test('callee waits for the acknowledged caller to disconnect before releasing its own Nearby', async t => {
  const f = fixture(t); f.manualClose(); f.start('test', 'callee'); await flush();
  assert.deepEqual(f.events, ['address', 'plan', 'config:test']);
  assert.equal(f.hasCloseListener(), true);
  f.closeEndpoint('unrelated'); await flush();
  assert.deepEqual(f.events, ['address', 'plan', 'config:test']);
  f.closeEndpoint(); await flush();
  assert.deepEqual(f.events, ['address', 'plan', 'config:test', 'release:test', 'released:test', 'connect:callee:test']);
  assert.equal(f.hasCloseListener(), false);
});

test('callee rejects a disconnect before valid handoff acknowledgement', async t => {
  const f = fixture(t); f.manualAck(); const start = f.start('test', 'callee'); await flush();
  f.closeEndpoint(); await assert.rejects(start, /closed before direct setup was confirmed/); await flush();
  assert.deepEqual(f.events, ['address', 'plan', 'config:test', 'stop:test', 'resume:test']);
  assert.equal(f.hasCloseListener(), false); assert.equal(f.signals.size, 0);
});

test('missing caller disconnect times out and does not force release despite a valid ack', async t => {
  const f = fixture(t, { ackTimeout: 20 }); f.manualClose(); const start = f.start('test', 'callee');
  await assert.rejects(start, /did not release its nearby connection/); await flush();
  assert.deepEqual(f.events, ['address', 'plan', 'config:test', 'stop:test', 'resume:test']);
  assert.equal(f.hasCloseListener(), false); assert.equal(f.signals.size, 0);
});

test('cancelling after ack removes the disconnect waiter and cannot create a late group', async t => {
  const f = fixture(t); f.manualClose(); const start = f.start('test', 'callee'); await flush();
  await f.service.stop(); await assert.rejects(start, /Call stopped/);
  f.closeEndpoint(); await flush();
  assert.deepEqual(f.events, ['address', 'plan', 'config:test', 'stop:test', 'resume:test']);
  assert.equal(f.hasCloseListener(), false); assert.equal(f.signals.size, 0);
});

test('cancelling an in-flight Nearby release waits for it, then stops direct Wi-Fi before resuming', async t => {
  const f = fixture(t), release = f.blockRelease(), start = f.start(); await flush();
  const stopped = f.service.stop(); await assert.rejects(start, /Call stopped/); await flush();
  assert.deepEqual(f.events, ['address', 'ack:test', 'release:test']);
  release.resolve(); await stopped;
  assert.deepEqual(f.events, ['address', 'ack:test', 'release:test', 'released:test', 'stop:test', 'resume:test']);
  assert.deepEqual(f.joins, []);
});

test('call reset notifies idle once after clearing the session and preserves subscribers', () => {
  const stateSource = fs.readFileSync(path.join(__dirname, '../services/CallStateManager.ts'), 'utf8');
  const js = ts.transpileModule(stateSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const m = { exports: {} }; new Function('exports', js)(m.exports);
  const manager = new m.exports.CallStateManager(), observed = [];
  manager.subscribe(state => observed.push([state, manager.getSessionId()]));
  manager.initSession('first', 'peer', 'endpoint'); manager.reset(); manager.reset();
  manager.initSession('second', 'peer', 'endpoint'); manager.reset();
  assert.deepEqual(observed, [['discovery', 'first'], ['idle', ''], ['discovery', 'second'], ['idle', '']]);
});

test('call screen does not reset to idle or navigate until native teardown resolves', async t => {
  const hookSource = fs.readFileSync(path.join(__dirname, '../hooks/useNearbyCall.ts'), 'utf8');
  const js = ts.transpileModule(hookSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const cleanup = deferred(), effects = [], events = [];
  let session = '';
  const subscription = () => ({ remove() {} });
  const dependencies = {
    react: {
      useState: value => [typeof value === 'function' ? value() : value, () => {}],
      useRef: value => ({ current: value }), useCallback: fn => fn,
      useEffect: fn => effects.push(fn),
    },
    'react-native': {
      Alert: { alert() {} }, Platform: { OS: 'ios' }, Vibration: { cancel() {} },
      AppState: { currentState: 'active', addEventListener: subscription },
      DeviceEventEmitter: { addListener: subscription }, BackHandler: { addEventListener: subscription },
    },
    '../services/BackgroundAvailability': { callNotifications: {
      dismissIncoming() {}, stopCallService: async () => {}, startCallService: async () => {},
    } },
    'expo-router': { router: { back: () => events.push('navigate') } },
    '../modules/Nearby': { default: { onConnectionClosed: subscription } },
    '../modules/DirectWifi': { default: { warmUpPeerDiscovery: async () => {} } },
    '../services/DirectCallAudio': { default: {
      end: async () => {}, setMuted() {}, stopStreaming: () => cleanup.promise,
    } },
    '../services/CallSignaling': { signalingManager: {
      getActiveConnection: () => undefined,
      setActiveConnection() {}, on() {}, off() {}, sendCallRequest: async () => true, sendCallEnd: async () => true,
    } },
    '../services/CallStateManager': { callStateManager: {
      initSession: id => { session = id; }, getSessionId: () => session,
      reset: () => { session = ''; events.push('idle'); },
    } },
    '../store/appStore': { useAppStore: { getState: () => ({ myDeviceName: 'Me', addCallRecord() {} }) } },
  };
  const m = { exports: {} };
  new Function('require', 'module', 'exports', js)(name => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name];
  }, m, m.exports);
  const call = m.exports.useNearbyCall('caller', 'peer', 'Friend', 'endpoint');
  const dispose = effects.map(effect => effect());
  t.after(() => { cleanup.resolve(); dispose.forEach(fn => fn?.()); });
  await flush(); assert.ok(session);
  await call.hangUp(); await flush();
  assert.deepEqual(events, []); assert.ok(session);
  cleanup.resolve(); await flush();
  assert.deepEqual(events, ['idle', 'navigate']); assert.equal(session, '');
  await call.hangUp(); assert.deepEqual(events, ['idle', 'navigate']);
});

test('answering sends the accept signal without waiting behind the foreground service', async t => {
  const effects = [], events = [];
  let resolveService;
  const subscription = () => ({ remove() {} });
  const dependencies = {
    react: {
      useState: value => [typeof value === 'function' ? value() : value, () => {}],
      useRef: value => ({ current: value }), useCallback: fn => fn,
      useEffect: fn => effects.push(fn),
    },
    'react-native': {
      Alert: { alert() {} }, Platform: { OS: 'ios' }, Vibration: { cancel() {} },
      AppState: { currentState: 'active', addEventListener: subscription },
      DeviceEventEmitter: { addListener: subscription }, BackHandler: { addEventListener: subscription },
    },
    '../services/BackgroundAvailability': { callNotifications: {
      dismissIncoming() {}, consumeCallAction: async () => null,
      stopCallService: async () => {},
      startCallService: () => { events.push('service'); return new Promise(resolve => { resolveService = resolve; }); },
    } },
    'expo-router': { router: { back: () => events.push('navigate') } },
    '../modules/Nearby': { default: { onConnectionClosed: subscription } },
    '../modules/DirectWifi': { default: { warmUpPeerDiscovery: async () => {} } },
    '../services/DirectCallAudio': { default: {
      end: async () => {}, setMuted() {}, stopStreaming: () => Promise.resolve(),
      start: async () => { events.push('audio'); return true; },
      isStartingOrActive: () => false,
    } },
    '../services/CallSignaling': { signalingManager: {
      getActiveConnection: () => undefined,
      setActiveConnection() {}, on() {}, off() {},
      sendCallAccept: async () => { events.push('accept'); return true; },
      sendCallEnd: async () => true,
    } },
    '../services/CallStateManager': { callStateManager: {
      initSession() {}, getSessionId: () => '', reset() {}, setState: () => {},
    } },
    '../store/appStore': { useAppStore: { getState: () => ({ myDeviceName: 'Me', addCallRecord() {}, saveCallSession: async () => {} }) } },
  };
  const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../hooks/useNearbyCall.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const m = { exports: {} };
  new Function('require', 'module', 'exports', js)(name => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name];
  }, m, m.exports);
  const call = m.exports.useNearbyCall('callee', 'peer', 'Friend', 'endpoint', 'incoming-1');
  t.after(async () => { resolveService?.(); try { await call.hangUp(); } catch {} await flush(); });
  effects.forEach(effect => effect());
  await flush();
  const pending = call.acceptCall();
  await flush();
  // The peer's direct setup starts on the accept signal; the local service
  // start runs beside it and must not gate it.
  assert.deepEqual(events, ['service', 'accept']);
  resolveService();
  await pending; await flush();
  assert.ok(events.indexOf('audio') > events.indexOf('accept'));
  await call.hangUp(); await flush();
});
