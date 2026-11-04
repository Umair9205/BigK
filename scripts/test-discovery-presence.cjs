const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const {test} = require('node:test');

function load(file, dependencies, timers = {setTimeout, clearTimeout}) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  const m = {exports:{}};
  new Function('require','module','exports','setTimeout','clearTimeout',js)(name => {
    if (!(name in dependencies)) throw new Error(name);
    return dependencies[name];
  }, m, m.exports, timers.setTimeout, timers.clearTimeout);
  return m.exports;
}

// Deterministic timers: run(ms) executes every not-yet-cleared timer scheduled
// for that exact duration (one-shot, like the real thing).
function manualTimers() {
  const pending = [];
  return {
    pending,
    setTimeout: (fn, ms) => { const h = {fn, ms, cleared: false}; pending.push(h); return h; },
    clearTimeout: h => { if (h) h.cleared = true; },
    run: ms => { pending.filter(h => h.ms === ms && !h.cleared).forEach(h => { h.cleared = true; h.fn(); }); },
    live: ms => pending.filter(h => h.ms === ms && !h.cleared).length,
  };
}

function discoveryFixture() {
  const handlers = {};
  const sub = name => fn => { handlers[name] = fn; return {remove(){ delete handlers[name]; }}; };
  const timers = manualTimers();
  const {NearbyDiscoveryService} = load('services/NearbyDiscoveryService.ts', {
    '../modules/Nearby':{default:{startDiscovery:async()=>true,stopDiscovery:async()=>{},
      onPeerDiscovered:sub('found'),onPeerLost:sub('lost'),onConnectionEstablished:sub('connected'),
      onConnectionClosed:sub('closed'),onDiscoveryError:sub('error')}},
  }, timers);
  return {handlers, timers, service:new NearbyDiscoveryService()};
}

function outgoingFixture(timers, discovery) {
  let listener = null;
  const statuses = [];
  const api = load('services/OutgoingCall.ts', {
    'react-native':{Alert:{alert(){}}},
    'expo-router':{router:{push(){}}},
    '../modules/Nearby':{default:{isConnected:async()=>false,connect:async()=>true,closeConnection:async()=>true}},
    './NearbyAvailability':{ensureNearbyAvailable:async()=>{}},
    './BackgroundAvailability':{callNotifications:{startCallService:async()=>{},stopCallService:async()=>{}}},
    './NearbyDiscoveryService':{nearbyDiscoveryService:Object.assign({
      getConnectionId:()=>null,
      forget(){},
      stopDiscovery:async()=>{},
      onFriendDiscovered:fn=>{listener=fn;return()=>{listener=null;};},
      startContinuousDiscovery:async()=>{},
    }, discovery || {})},
    './CallSignaling':{signalingManager:{getActiveConnection:()=>null,clearActiveConnection(){},setActiveConnection(){}}},
    './CallStateManager':{callStateManager:{getState:()=> 'idle'}},
    '../store/appStore':{useAppStore:{getState:()=>({friends:[{uuid:'friend',name:'Farid'}]})}},
  }, timers);
  return {...api, statuses, onStatus:s=>statuses.push(s), fire:peer=>listener && listener(peer)};
}

test('a lost endpoint drops the dialable address but keeps presence for the grace window', async () => {
  const {handlers, timers, service} = discoveryFixture();
  await service.startContinuousDiscovery([{uuid:'friend'}]);
  handlers.found({peerUUID:'friend',peerName:'Farid',connectionId:'e1'});
  assert.equal(service.getConnectionId('friend'),'e1');
  const events = [];
  service.onFriendDiscovered(f => events.push(f.discovered));
  handlers.lost({connectionId:'e1'});
  assert.equal(service.getConnectionId('friend'),null);   // a dead endpoint is never handed to a dialer
  assert.equal(service.getDiscoveredFriends().length,1);  // presence lingers instead of vanishing
  assert.equal(service.isDiscovered('friend'),false);
  timers.run(45000);
  assert.equal(service.getDiscoveredFriends().length,0);  // grace expiry finally removes it
  assert.deepEqual(events,[true,false,false]);
});

test('re-discovery during grace restores the endpoint and cancels expiry', async () => {
  const {handlers, timers, service} = discoveryFixture();
  await service.startContinuousDiscovery([{uuid:'friend'}]);
  handlers.found({peerUUID:'friend',peerName:'Farid',connectionId:'e1'});
  handlers.lost({connectionId:'e1'});
  handlers.found({peerUUID:'friend',peerName:'Farid',connectionId:'e2'});
  timers.run(45000);
  assert.equal(service.getDiscoveredFriends().length,1);  // expiry was cancelled
  assert.equal(service.getConnectionId('friend'),'e2');   // the fresh endpoint is live
  assert.equal(service.isDiscovered('friend'),true);
});

test('warm cache survives the stop/start cycle that wraps every dial', async () => {
  const {handlers, timers, service} = discoveryFixture();
  await service.startContinuousDiscovery([{uuid:'friend'}]);
  handlers.found({peerUUID:'friend',peerName:'Farid',connectionId:'e1'});
  await service.stopDiscovery();                          // dial begins: scanning pauses
  assert.equal(service.isScanning(),false);
  assert.equal(service.getConnectionId('friend'),'e1');   // endpoint retained for the next dial
  assert.equal(service.isDiscovered('friend'),false);     // but not advertised as live
  await service.startContinuousDiscovery([{uuid:'friend'}]); // availability resumes
  assert.equal(service.getConnectionId('friend'),'e1');   // NO cold-cache wipe (old behaviour)
  handlers.found({peerUUID:'friend',peerName:'Farid',connectionId:'e1'}); // native replay
  assert.equal(service.isDiscovered('friend'),true);
  timers.run(45000);
  assert.equal(service.getConnectionId('friend'),'e1');   // no stray grace expiry
});

test('connection close drops the endpoint but a still-scanned contact stays visible', async () => {
  const {handlers, timers, service} = discoveryFixture();
  await service.startContinuousDiscovery([{uuid:'friend'}]);
  handlers.found({peerUUID:'friend',peerName:'Farid',connectionId:'e1'});
  handlers.closed({connectionId:'e1'});
  assert.equal(service.getConnectionId('friend'),null);
  assert.equal(service.getDiscoveredFriends().length,1);  // scanner still sees them (no lost event)
  assert.equal(service.isDiscovered('friend'),true);
  timers.run(45000);
  assert.equal(service.getDiscoveredFriends().length,1);  // still discovered → no expiry scheduled
});

test('entries older than the grace window are swept on a fresh start', async () => {
  const {handlers, service} = discoveryFixture();
  await service.startContinuousDiscovery([{uuid:'friend'}]);
  handlers.found({peerUUID:'friend',peerName:'Farid',connectionId:'e1'});
  await service.stopDiscovery();
  service.getDiscoveredFriends()[0].lastSeen = new Date(Date.now() - 60000);
  await service.startContinuousDiscovery([{uuid:'friend'}]);
  assert.equal(service.getDiscoveredFriends().length,0);
  assert.equal(service.getConnectionId('friend'),null);
});

test('a dial with a warm cached endpoint connects with no scan stages at all', async () => {
  const timers = manualTimers();
  const f = outgoingFixture(timers, {getConnectionId:()=>'warm-endpoint'});
  assert.equal(await f.connectPeer('friend', f.onStatus),'warm-endpoint');
  assert.deepEqual(f.statuses,['Finding contact…','Connecting…']);
  assert.equal(timers.live(3000),0);
  assert.equal(timers.live(8000),0);
});

test('a dial without a cached endpoint reports staged, actionable progress', async () => {
  const timers = manualTimers();
  const f = outgoingFixture(timers);
  const pending = f.connectPeer('friend', f.onStatus);
  await new Promise(setImmediate);
  assert.ok(f.statuses.some(s => s.includes('Finding Farid…')), JSON.stringify(f.statuses));
  timers.run(3000);
  assert.ok(f.statuses.some(s => s.includes('Scanning for Farid nearby…')), JSON.stringify(f.statuses));
  timers.run(8000);
  assert.ok(f.statuses.some(s => s.includes('Farid may be out of range')), JSON.stringify(f.statuses));
  assert.ok(f.statuses.some(s => s.includes('keep BigK open on their phone')));
  timers.run(6000);                                       // one bounded refresh, same deadline
  await new Promise(setImmediate);
  f.fire({uuid:'friend',connectionId:'found-endpoint',discovered:true});
  assert.equal(await pending,'found-endpoint');
  assert.equal(timers.live(15000),0);                     // deadline cleared on success
});

test('a dial that never finds the contact fails with actionable guidance', async () => {
  const timers = manualTimers();
  const f = outgoingFixture(timers);
  const pending = f.connectPeer('friend', f.onStatus);
  await new Promise(setImmediate);
  timers.run(3000);
  timers.run(8000);
  assert.ok(f.statuses.some(s => s.includes('keep BigK open on their phone')));
  timers.run(15000);
  await assert.rejects(pending, /Phone not found/);
});

test('touchLastSeen persists presence per contact at most once a minute', async () => {
  const written = [];
  const storage = {default:{
    getItem:async()=>null,
    setItem:async(k,v)=>{written.push([k,v]);},
    removeItem:async()=>{},
  }};
  const {useAppStore} = load('store/appStore.ts', {
    '@react-native-async-storage/async-storage': storage,
    'zustand': require('zustand'),
  });
  await useAppStore.getState().addFriend({uuid:'friend',name:'Farid',currentMac:''});
  await useAppStore.getState().addFriend({uuid:'other',name:'Sana',currentMac:''});
  written.length = 0;
  useAppStore.getState().touchLastSeen('friend');
  assert.ok(written.some(([k]) => k === '@kela_last_seen'), JSON.stringify(written.map(([k]) => k)));
  const firstWrite = written.length;
  useAppStore.getState().touchLastSeen('friend');         // inside the throttle window
  assert.equal(written.length, firstWrite);
  assert.equal(typeof useAppStore.getState().lastSeen.friend, 'number');
  useAppStore.getState().touchLastSeen('other');          // a different contact still records
  assert.ok(written.length > firstWrite);
  useAppStore.getState().touchLastSeen('nobody');         // unknown contacts are not persisted
  assert.ok(!('nobody' in useAppStore.getState().lastSeen));
});
