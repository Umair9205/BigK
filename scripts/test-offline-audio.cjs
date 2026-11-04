// Dependency-free test runner using the project's installed TypeScript compiler.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
function load(relative, dependencies = {}) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)(name => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw new Error('Unexpected dependency: ' + name);
  }, module, module.exports);
  return module.exports;
}
const { AudioJitterBuffer } = load('services/AudioJitterBuffer.ts');
const frame = n => ({ frameNumber: n, sessionId: 'test', codec: 'opus', data: 'AA==' });

test('waits 60ms then plays sequence order despite reordered delivery', () => {
  const q = new AudioJitterBuffer();
  q.push(frame(0), 0); q.push(frame(2), 10); q.push(frame(1), 20);
  assert.equal(q.pop(59), undefined);
  assert.equal(q.pop(60).frameNumber, 0);
  assert.equal(q.pop(80).frameNumber, 1);
  assert.equal(q.pop(100).frameNumber, 2);
});
test('duplicate and late packets are discarded', () => {
  const q = new AudioJitterBuffer();
  q.push(frame(0), 0); q.push(frame(0), 1); q.push(frame(1), 2);
  q.pop(60); q.push(frame(0), 61);
  assert.equal(q.stats.duplicate, 1); assert.equal(q.stats.late, 1);
});
test('missing frame requests concealment without blocking later audio', () => {
  const q = new AudioJitterBuffer();
  q.push(frame(0), 0); q.push(frame(2), 10);
  assert.equal(q.pop(60).frameNumber, 0);
  assert.equal(q.pop(80), null);
  assert.equal(q.pop(100).frameNumber, 2);
});
test('burst and stale queues are bounded', () => {
  const q = new AudioJitterBuffer();
  for (let n = 0; n < 500; n++) q.push(frame(n), 0);
  assert.ok(q.queueMs <= 120);
  assert.ok(q.stats.dropped > 400);
  assert.equal(q.pop(1000), undefined);
  assert.equal(q.queueMs, 0);
});
function fixture() {
  const events = new Map(), signals = new Map();
  const counts = { starts: 0, stops: 0, encodes: 0, plays: 0, sent: 0 };
  let startError = false, gate;
  const subscribe = (name, fn) => {
    events.set(name, fn);
    return { remove: () => events.delete(name) };
  };
  const native = {
    startCapture: async () => { counts.starts++; if (startError) throw new Error('Mic failed'); },
    stopCapture: () => counts.stops++,
    playback: async () => { counts.plays++; return true; }, logStats() {},
  };
  const codec = { initialize: async () => {}, reset() {} };
  const signalingManager = {
    getActiveConnection: () => 'endpoint',
    on: (name, fn) => signals.set(name, fn),
    off: name => signals.delete(name),
    sendAudioFrame: async () => { counts.sent++; if (gate) await gate; return true; },
  };
  const service = load('services/AudioStreamingService.ts', {
    'react-native': {
      NativeModules: { AudioStreamModule: native, OpusModule: {
        encodeBase64: async () => { counts.encodes++; return 'AA=='; },
        decodeBase64: async () => 'pcm',
      } },
      NativeEventEmitter: class { addListener(name, fn) { return subscribe(name, fn); } },
      Platform: { OS: 'test' }, PermissionsAndroid: {},
    },
    './CallSignaling': { signalingManager },
    '../modules/Nearby': { default: { onConnectionClosed: fn => subscribe('closed', fn) } },
    '../modules/OpusCodec': { default: codec },
    './AudioJitterBuffer': { AudioJitterBuffer },
  }).default;
  return { service, events, signals, counts, codec,
    failStart() { startError = true; },
    holdSends(promise) { gate = promise; },
    start: id => service.startStreaming('peer', id || 'test', { onError() {} }),
  };
}
test('duplicate start initializes native audio once and stop removes listeners', async () => {
  const f = fixture();
  await Promise.all([f.start(), f.start()]);
  assert.equal(f.counts.starts, 1);
  await assert.rejects(f.start('other'), /Another call/);
  f.service.stopStreaming();
  assert.equal(f.events.size, 0); assert.equal(f.signals.size, 0);
});
test('native startup failure rejects instead of reporting active', async () => {
  const f = fixture(); f.failStart();
  await assert.rejects(f.start(), /Mic failed/);
  assert.equal(f.events.size, 0);
  assert.equal(f.service.run, null);
});
test('cancel during codec initialization cannot resurrect capture', async () => {
  const f = fixture();
  let release;
  f.codec.initialize = () => new Promise(resolve => { release = resolve; });
  const start = f.start();
  f.service.stopStreaming(); release();
  await assert.rejects(start, /cancelled/);
  assert.equal(f.counts.starts, 0);
});
test('send backpressure keeps only newest pending frame; stopped events are ignored', async () => {
  const f = fixture();
  await f.start();
  let release;
  f.holdSends(new Promise(resolve => { release = resolve; }));
  const capture = f.events.get('onAudioCaptured');
  capture({ sessionId: 'test', frameNumber: 0, data: 'pcm' });
  await Promise.resolve();
  for (let n = 1; n < 100; n++) capture({ sessionId: 'test', frameNumber: n, data: 'pcm' });
  assert.equal(f.service.run.pending.frameNumber, 99);
  assert.ok(f.service.run.stats.sendDropped >= 98);
  f.service.stopStreaming(); release();
  capture({ sessionId: 'test', frameNumber: 101, data: 'pcm' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.counts.encodes, 1);
});
test('incoming audio must match both session and Nearby endpoint', async () => {
  const f = fixture(); await f.start();
  const receive = f.signals.get('audio-frame');
  receive({ signal: frame(0), connectionId: 'wrong' });
  receive({ signal: { ...frame(0), sessionId: 'other' }, connectionId: 'endpoint' });
  assert.equal(f.service.run.jitter.stats.received, 0);
  receive({ signal: frame(0), connectionId: 'endpoint' });
  assert.equal(f.service.run.jitter.stats.received, 1);
  f.service.stopStreaming();
});
