// Always-on availability watchdogs. Receiving calls must not depend on the UI
// process being alive (native service) or on a user noticing a silent failure
// (JS health check). JS tests use real transpiled BackgroundAvailability.ts with
// an injected dependency map; native tests are source-structure assertions.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const flush = async () => { for(let i=0;i<10;i++) await new Promise(setImmediate); };
function fixture() {
  const events={},counts={start:0,scan:0,stop:0,advertise:0};
  let callState='idle',onCall,gate,fail=false;
  const native={running:false,paused:false,notifications:true,scanning:true,advertising:true};
  const store={friends:[],settings:{scanningEnabled:true},updateSettings:async value=>Object.assign(store.settings,value)};
  const subscribe=(event,fn)=>{events[event]=fn;return {remove:()=>delete events[event]};};
  const dependencies={
    'react-native':{AppState:{currentState:'active',addEventListener:subscribe},DeviceEventEmitter:{addListener:subscribe},Platform:{OS:'android',Version:34},PermissionsAndroid:{request:async()=> 'granted'},NativeModules:{CallForegroundServiceModule:{
      availabilityStatus:async()=>({...native}),
      startAvailability:async reset=>{if(reset)native.paused=false;if(fail)throw new Error('service blocked');native.running=true;counts.start++;},
      stopAvailability:async()=>{native.running=false;native.paused=true;},
    }}},
    zustand:{create:init=>{let value=init();return {getState:()=>value,setState:patch=>Object.assign(value,patch)};}},
    '../modules/Nearby':{default:{configureAvailability:async()=>{},stopAdvertising:async()=>counts.stop++}},
    './NearbyAvailability':{ensureNearbyAvailable:async()=>{counts.advertise++;if(gate)await gate;}},
    './NearbyDiscoveryService':{nearbyDiscoveryService:{startContinuousDiscovery:async()=>{native.scanning=true;counts.scan++;},stopDiscovery:async()=>{native.scanning=false;counts.stop++;}}},
    './CallStateManager':{callStateManager:{getState:()=>callState,subscribe:fn=>{onCall=fn;return ()=>{};}}},
    '../store/appStore':{useAppStore:{getState:()=>store,subscribe:()=>()=>{}}},
  };
  const js=ts.transpileModule(fs.readFileSync(path.join(root,'services/BackgroundAvailability.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  const m={exports:{}};new Function('require','module','exports',js)(name=>{assert.ok(name in dependencies,name);return dependencies[name];},m,m.exports);
  return {...m.exports,native,events,counts,store,setCall:s=>{callState=s;onCall?.(s);},setGate:p=>gate=p,setFail:()=>fail=true};
}

test('healthy state: one status call, no radio churn',async()=>{
  const f=fixture();await f.resumeAvailability();
  const start=f.counts.start,scan=f.counts.scan;
  assert.equal(await f.availabilityHealthCheck(),true);
  assert.equal(f.counts.start,start);assert.equal(f.counts.scan,scan);
});
test('dead foreground service self-heals without user interaction',async()=>{
  const f=fixture();await f.resumeAvailability();assert.equal(f.counts.start,1);
  f.native.running=false;               // OEM killed the service; process survives
  assert.equal(await f.availabilityHealthCheck(),false);
  assert.equal(f.counts.start,2);assert.equal(f.native.running,true);
  assert.equal(f.useAvailability.getState().enabled,true);
});
test('silently stopped scan self-heals',async()=>{
  const f=fixture();await f.resumeAvailability();
  const scans=f.counts.scan;f.native.scanning=false;
  assert.equal(await f.availabilityHealthCheck(),false);
  assert.equal(f.counts.scan,scans+1);assert.equal(f.native.scanning,true);
});
test('native pause is honored as user intent, not fought',async()=>{
  const f=fixture();await f.resumeAvailability();
  f.native.paused=true;f.native.running=false;
  assert.equal(await f.availabilityHealthCheck(),true);   // intentional state, not an error
  assert.equal(f.counts.start,1);                          // no restart attempt
  assert.equal(f.store.settings.scanningEnabled,false);
  assert.equal(f.useAvailability.getState().enabled,false);
});
test('health check is inert before first enable',async()=>{
  const f=fixture();
  assert.equal(await f.availabilityHealthCheck(),true);
  assert.equal(f.counts.start,0);assert.equal(f.counts.scan,0);
});
test('health check never interrupts an active call',async()=>{
  const f=fixture();await f.resumeAvailability();f.setCall('streaming');
  f.native.scanning=false;                               // expected during a call
  assert.equal(await f.availabilityHealthCheck(),true);
  assert.equal(f.counts.scan,1);
});
test('health check defers to an in-flight resume',async()=>{
  const f=fixture();let release;f.setGate(new Promise(r=>release=r));
  const start=f.resumeAvailability();await flush();
  assert.equal(await f.availabilityHealthCheck(),true);
  release();await start;assert.equal(f.counts.start,1);
});
test('lifecycle wires the health interval and clears it on dispose',async()=>{
  const source=fs.readFileSync(path.join(root,'services/BackgroundAvailability.ts'),'utf8');
  assert.match(source,/setInterval\(\(\) => \{ void availabilityHealthCheck\(\); \}, AVAILABILITY_HEALTH_INTERVAL_MS\)/);
  assert.match(source,/clearInterval\(health\)/);
  const f=fixture();await f.resumeAvailability();f.startAvailabilityLifecycle();
  assert.equal(typeof f.availabilityHealthCheck,'function');
  f.native.running=false;                                 // interval would recover on its 60s tick
  assert.equal(await f.availabilityHealthCheck(),false);
});

test('native service runs the watchdog without React and cancels it on pause and destroy',()=>{
  const dir=path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect');
  const service=fs.readFileSync(path.join(dir,'AvailabilityService.kt'),'utf8');
  assert.match(service,/NearbyTransport.get\(this@AvailabilityService\).healthWatchdog\(\)/);
  assert.match(service,/mainHandler.postDelayed\(watchdog, WATCHDOG_INTERVAL_MS\)/);
  assert.equal((service.match(/mainHandler.removeCallbacks\(watchdog\)/g)||[]).length,3); // PAUSE action, restart dedupe, onDestroy
  // Pinned so a refactor can't silently change the cadence. 5s: brackets a
  // walk-away death point to 5-7m of walking (20s was 20-28m — wider than the
  // range being measured) and keeps mPeers warm between calls. Skipped entirely
  // mid-call (probePeerRadio gates on radioReleased), so no call-path interference.
  assert.match(service,/const val WATCHDOG_INTERVAL_MS = 5_000L/);
  assert.doesNotMatch(service,/ReactApplicationContext/);
});
test('a 1 Hz Wi-Fi keep-alive feeds the Transsion freezer non-zero traffic',()=>{
  const dir=path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect');
  const ka=fs.readFileSync(path.join(dir,'TrafficKeepAlive.kt'),'utf8');
  // Round 19: the exemption was granted (unrestricted=true) and the app was
  // frozen 13 s after Home anyway, right after the freezer logged
  // `isTrafficActive uid:<us> speed :0`. Traffic — not the exemption — is the
  // lever; the ticker must beat the ~5 s decision window.
  assert.match(ka,/INTERVAL_MS = 1_000L/);
  // Metered transports keep the freezer's rules; only Wi-Fi carries the junk.
  assert.match(ka,/TRANSPORT_WIFI/);
  // Loopback would never reach the radio the freezer is watching.
  assert.match(ka,/isLoopbackAddress/);
  assert.match(ka,/DatagramPacket/);
  // Round 20 verdict: v1 sent (first send 02:12:31, Home 02:12:32) and the
  // freezer still read `speed :0` at the decision (02:12:37). The metric only
  // ever logs 0 or 1 for any uid — quantised, threshold 1 — and a 5 s ramp of
  // 1 KiB/s did not reach it. v2: burst volume for the first decision, RX
  // probes in case the counter is receive-only, and counters in logcat so the
  // next round discriminates instead of guessing.
  assert.match(ka,/BURST_PADS = 16/);          // 16 KiB + 16 pkt/s beats any window ≤ ~80 s at t+5s
  assert.match(ka,/SUSTAIN_PADS = 2/);          // holds ≥1 for later passes (screen-off, bump-end)
  assert.match(ka,/BURST_TLS = 5/);             // ~10-12 KB/s RX from resolver first-flights
  assert.match(ka,/startHandshake/);            // TLS handshake = KBs of RX per attempt
  assert.match(ka,/TrafficStats\.getUidTxBytes/); // uid byte totals printed for correlation
  assert.match(ka,/phase=/);                    // counter line carries burst|sustain
  assert.match(ka,/COUNTER_LOG_EVERY/);         // periodic counter log exists
  assert.match(ka,/8\.8\.8\.8/);                // public resolvers invited for RX
  assert.match(ka,/wifi=/);                     // counter line says when no interface existed
  const service=fs.readFileSync(path.join(dir,'AvailabilityService.kt'),'utf8');
  assert.match(service,/TrafficKeepAlive\.start\(this\)/);
  assert.equal((service.match(/TrafficKeepAlive\.stop\(\)/g)||[]).length,2); // PAUSE action, onDestroy
});
test('native watchdog clears the stuck states that permanently kill scanning',()=>{
  const core=fs.readFileSync(path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect/NearbyTransport.kt'),'utf8');
  const watchdog=core.slice(core.indexOf('fun healthWatchdog'),core.indexOf('private fun reply'));
  // Paused radios are never revived behind the user's back.
  assert.match(watchdog,/if \(prefs.getBoolean\("paused", true\)\) return@post/);
  // Stuck direct handoff recovers only after the Wi-Fi radio released.
  assert.match(watchdog,/DirectWifiModule.radioReleased/);
  assert.match(watchdog,/recoverAfterRadioReset\(\)/);
  // A call session whose endpoint closed blocks startDiscovery forever; clear it.
  assert.match(watchdog,/endpoint == null \|\| !connected.contains\(endpoint\)/);
  assert.match(watchdog,/IncomingCallNotification.dismiss\(context, stuck\)/);
  assert.match(watchdog,/session = null; sessionEndpoint = null; incoming = null; handoffReadySession = null/);
  // A silently dropped advertisement is restored.
  assert.match(watchdog,/if \(!advertising && !restoring\)/);
  assert.match(watchdog,/restore\(\)/);
  // Health is readable from JS.
  assert.match(core,/@Volatile private var advertising/);
  assert.match(core,/@Volatile private var discovering/);
  assert.match(core,/val isAdvertising: Boolean get\(\) = advertising/);
  assert.match(core,/val isDiscovering: Boolean get\(\) = discovering/);
});
test('availabilityStatus reports radio health to the JS watchdog',()=>{
  const module=fs.readFileSync(path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect/CallForegroundServiceModule.kt'),'utf8');
  assert.match(module,/putBoolean\("scanning", NearbyTransport.get\(reactContext\).isDiscovering\)/);
  assert.match(module,/putBoolean\("advertising", NearbyTransport.get\(reactContext\).isAdvertising\)/);
});
