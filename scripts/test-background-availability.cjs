const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const flush = async () => { for(let i=0;i<10;i++) await new Promise(setImmediate); };
function fixture(options = {}) {
  const events={},counts={start:0,scan:0,stop:0,advertise:0};
  let callState='idle',onCall,storeListener,gate,fail=false;
  const native={running:false,paused:false,notifications:true};
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
    './NearbyDiscoveryService':{nearbyDiscoveryService:{startContinuousDiscovery:async()=>counts.scan++,stopDiscovery:async()=>counts.stop++}},
    './CallStateManager':{callStateManager:{getState:()=>callState,subscribe:fn=>{onCall=fn;return ()=>{};}}},
    '../store/appStore':{useAppStore:{getState:()=>store,subscribe:fn=>{storeListener=fn;return ()=>{};}}},
  };
  if (options.missingModule) dependencies['react-native'].NativeModules.CallForegroundServiceModule = null;
  if (options.missingMethod) delete dependencies['react-native'].NativeModules.CallForegroundServiceModule[options.missingMethod];
  const js=ts.transpileModule(fs.readFileSync(path.join(root,'services/BackgroundAvailability.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  const m={exports:{}};new Function('require','module','exports',js)(name=>{assert.ok(name in dependencies,name);return dependencies[name];},m,m.exports);
  return {...m.exports,native,events,counts,store,setCall:s=>{callState=s;onCall?.(s);},setGate:p=>gate=p,setFail:()=>fail=true};
}
test('automatic availability is one-shot while starting and starts discovery',async()=>{
  const f=fixture();const a=f.resumeAvailability();const b=f.resumeAvailability();assert.equal(a,b);await a;
  assert.equal(f.counts.start,1);assert.equal(f.counts.scan,1);assert.equal(f.useAvailability.getState().enabled,true);
});
test('native foreground package is registered exactly once and exports the expected module',()=>{
  const dir=path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect');
  const app=fs.readFileSync(path.join(dir,'MainApplication.kt'),'utf8');
  assert.equal((app.match(/packages\.add\(CallForegroundServicePackage\(\)\)/g)||[]).length,1);
  assert.match(fs.readFileSync(path.join(dir,'CallForegroundServicePackage.kt'),'utf8'),/CallForegroundServiceModule\(reactContext\)/);
  const module=fs.readFileSync(path.join(dir,'CallForegroundServiceModule.kt'),'utf8');
  assert.match(module,/getName\(\).*"CallForegroundServiceModule"/);
  assert.match(module,/import androidx\.core\.content\.ContextCompat/);
  assert.match(module,/fun openBatterySettings\(promise: Promise\)/);
  assert.match(module,/promise.reject\("BATTERY_SETTINGS"/);
});
test('one-time battery exemption ask guards background receive against OEM freezers',()=>{
  const dir=path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect');
  const module=fs.readFileSync(path.join(dir,'CallForegroundServiceModule.kt'),'utf8');
  assert.match(module,/fun isBatteryUnrestricted\(promise: Promise\)/);
  assert.match(module,/fun requestBatteryExemption\(promise: Promise\)/);
  assert.match(module,/isIgnoringBatteryOptimizations/);
  // Round 18: Transsion froze the running foreground service 5 s after Home.
  // The bridge must offer the direct system dialog, with the settings page only
  // as the fallback when an OEM refuses it.
  const req=module.indexOf('fun requestBatteryExemption');
  assert.ok(req>0);
  const direct=module.indexOf('ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',req);
  const fallback=module.indexOf('ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS',req);
  assert.ok(direct>0 && fallback>direct);
  const manifest=fs.readFileSync(path.join(root,'android/app/src/main/AndroidManifest.xml'),'utf8');
  assert.match(manifest,/android\.permission\.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS/);
  // Asked once per install, never mid-call, and only from the identity-ready path.
  const helper=fs.readFileSync(path.join(root,'services/BatteryExemption.ts'),'utf8');
  assert.match(helper,/export async function ensureBatteryExemption/);
  assert.match(helper,/AsyncStorage\.setItem\(ASKED_KEY/);
  assert.match(helper,/callStateManager\.getState\(\) !== 'idle'/);
  const layout=fs.readFileSync(path.join(root,'app/_layout.tsx'),'utf8');
  assert.match(layout,/ensureBatteryExemption\(\)/);
});
test('missing module reports useful status without starting discovery or rejecting',async()=>{
  const f=fixture({missingModule:true});
  await f.resumeAvailability();
  assert.equal(f.useAvailability.getState().enabled,false);
  assert.equal(f.useAvailability.getState().busy,false);
  assert.match(f.useAvailability.getState().status,/Local calling support is missing/);
  assert.equal(f.counts.advertise,0);assert.equal(f.counts.scan,0);
  await f.pauseAvailability();
  assert.equal(f.useAvailability.getState().busy,false);
  assert.match(f.useAvailability.getState().status,/Local calling support is missing/);
  assert.throws(()=>f.requireCallNotifications('openBatterySettings'),/Install the updated BigK APK/);
  assert.throws(()=>f.requireCallNotifications('getRingtoneSettings'),/Install the updated BigK APK/);
});
test('incomplete native module cannot report available or start radio discovery',async()=>{
  const f=fixture({missingMethod:'startAvailability'});
  await f.resumeAvailability();
  assert.equal(f.useAvailability.getState().enabled,false);
  assert.equal(f.counts.advertise,0);assert.equal(f.counts.scan,0);
  assert.match(f.useAvailability.getState().status,/Local calling support is missing/);
});
test('call activity stops discovery; idle resumes it',async()=>{
  const f=fixture();f.startAvailabilityLifecycle();await f.resumeAvailability();f.setCall('streaming');await flush();
  assert.ok(f.counts.stop>0);const scans=f.counts.scan;await f.resumeAvailability(false);assert.equal(f.counts.scan,scans);
  f.setCall('idle');await flush();assert.equal(f.counts.scan,scans+1);
});
test('native pause is respected after app reopen until explicit user resume',async()=>{
  const f=fixture();f.native.paused=true;await f.resumeAvailability();assert.equal(f.counts.start,0);assert.equal(f.store.settings.scanningEnabled,false);
  await f.resumeAvailability(true,true);assert.equal(f.useAvailability.getState().enabled,true);
});
test('pause during permission startup cannot resurrect advertising service',async()=>{
  const f=fixture();let release;f.setGate(new Promise(r=>release=r));const start=f.resumeAvailability();await flush();
  const stop=f.pauseAvailability();release();await Promise.all([start,stop]);
  assert.equal(f.counts.start,0);assert.equal(f.native.running,false);assert.equal(f.useAvailability.getState().enabled,false);
});
test('foreground startup failure reports unavailable and stops radio work',async()=>{
  const f=fixture();f.setFail();await f.resumeAvailability();assert.equal(f.useAvailability.getState().enabled,false);assert.match(f.useAvailability.getState().status,/blocked/);assert.ok(f.counts.stop>=2);
});
test('blocked notifications are visible to user rather than reported as ready',async()=>{
  const f=fixture();f.native.notifications=false;await f.resumeAvailability();assert.match(f.useAvailability.getState().status,/Notifications blocked/);
});
test('notification pause prevents call-end from re-enabling discovery',async()=>{
  const f=fixture();f.startAvailabilityLifecycle();await f.resumeAvailability();f.events.onAvailabilityPaused();await flush();
  const scans=f.counts.scan;f.setCall('idle');await flush();assert.equal(f.counts.scan,scans);assert.equal(f.store.settings.scanningEnabled,false);
});
test('incoming notification actions are session and secret-token bound',()=>{
  const module=fs.readFileSync(path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect/CallForegroundServiceModule.kt'),'utf8');
  assert.match(module,/IncomingCallNotification\.permits\(id, intent.getStringExtra\("localCallToken"\)\)/);
  const source=fs.readFileSync(path.join(root,'hooks/useNearbyCall.ts'),'utf8');
  assert.doesNotMatch(source,/getFriendByUUID\(peer\)\?\.autoAccept/);
});

test('native availability owns restart and task-removal recovery without React',()=>{
  const dir=path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect');
  const service=fs.readFileSync(path.join(dir,'AvailabilityService.kt'),'utf8');
  assert.match(service,/return if \(running\) START_STICKY else START_NOT_STICKY/);
  assert.match(service,/onTaskRemoved[\s\S]*NearbyTransport.get\(this\).restore\(\)/);
  assert.doesNotMatch(service,/ReactApplicationContext/);
  const bridge=fs.readFileSync(path.join(dir,'NearbyModule.kt'),'utf8');
  assert.match(bridge,/if \(!AvailabilityService.running\) transport.pause\(\)/);
  const core=fs.readFileSync(path.join(dir,'NearbyTransport.kt'),'utf8');
  assert.match(core,/context.applicationContext/);
  assert.match(core,/IncomingCallNotification.show\(context/);
  assert.match(core,/signal.optString\("from"\) != peerIdentities\[endpoint\]/);
  assert.match(core,/if \(sessionEndpoint == id && session != expectedSession\) return@post/);
  assert.match(core,/setLowPower\(true\).setConnectionType\(ConnectionType.NON_DISRUPTIVE\)/);
});

test('the native receive gate admits the v2 direct pair and never drops signals silently',()=>{
  const core=fs.readFileSync(path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect/NearbyTransport.kt'),'utf8');
  // Regression lock: a v1-only gate swallowed direct-config/direct-ready (the
  // only version-2 signals) before the JS emit — no log, no event, and every
  // call died at the callee's 8s "did not confirm direct setup" timeout.
  assert.doesNotMatch(core,/optInt\("version"\) != 1/);
  assert.match(core,/version == 2 && \(type == "direct-config" \|\| type == "direct-ready"\)/);
  assert.match(core,/dropped signal type=\$type version=\$version by receive gate/);
  // Version 2 exists on the wire for exactly these two signals.
  const signaling=fs.readFileSync(path.join(root,'services/CallSignaling.ts'),'utf8');
  assert.equal((signaling.match(/version: 2/g)||[]).length,2);
});

test('an unsaved phone cannot open a connection at all',()=>{
  const dir=path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect');
  const core=fs.readFileSync(path.join(dir,'NearbyTransport.kt'),'utf8');
  // The one-way add: a scanned code is saved locally and nothing is sent to
  // the other phone, so the accept gate refuses every endpoint that is not
  // already in `contacts`. Anchored on the shared `lifecycle` object —
  // guardedLifecycle() above it has its own onConnectionInitiated that only
  // forwards, not the accept gate.
  const lifecycle=core.indexOf('private val lifecycle = object : ConnectionLifecycleCallback()');
  assert.ok(lifecycle > 0);
  const initiate=core.slice(lifecycle, core.indexOf('override fun onConnectionResult', lifecycle));
  assert.match(initiate,/contactName\(peer\) == null/);
  assert.match(initiate,/if \(directSession != null \|\| prefs.getBoolean\("paused", true\) \|\| contactName\(peer\) == null/);
  assert.match(initiate,/\(sessionEndpoint != null && sessionEndpoint != id\)/);
  // Round-19 P0: the gate rejected silently — name the reason in logcat.
  assert.match(initiate,/accept gate rejected endpoint=\$id/);
  // No side channel either: no friend-request signal, no pending queue, no bridge.
  assert.doesNotMatch(core,/friend-request|pendingFriendRequests|resolveFriendRequest|savePendingRequest/);
  // And even a contact still needs a live session for anything past the invitation.
  assert.match(core,/val name = contactName\(signal\.optString\("from"\)\) \?: return false/);
  assert.match(core,/signal\.optString\("from"\) != peerIdentities\[endpoint\]/);
  const store=fs.readFileSync(path.join(root,'store/appStore.ts'),'utf8');
  assert.doesNotMatch(store,/incomingRequests|setIncomingRequests/);
  const scanner=fs.readFileSync(path.join(root,'app/qr-scanner.tsx'),'utf8');
  // The scanner adds on the spot; it never sends a request on the user's behalf.
  assert.match(scanner,/await addFriend\(\{uuid,name,currentMac:''\}\)/);
  assert.match(scanner,/Alert\.alert\('Contact added'/);
  assert.doesNotMatch(scanner,/sendFriendRequestTo|services\/FriendRequests/);
  const home=fs.readFileSync(path.join(root,'components/CallingHome.tsx'),'utf8');
  assert.doesNotMatch(home,/answerFriendRequest|incomingRequests/);
});

test('incoming UI restores only a live native invitation when foregrounded',()=>{
  const layout=fs.readFileSync(path.join(root,'app/_layout.tsx'),'utf8');
  assert.match(layout,/AppState.currentState !== 'active'/);
  assert.match(layout,/await Nearby.pendingIncoming\(\)/);
  assert.match(layout,/if \(!live \|\| !pending\) return/);
  assert.match(layout,/seenCalls.current.has\(signal.sessionId\)/);
});

test('direct teardown stops audio, waits for group release and cancels queued starts',()=>{
  const source=fs.readFileSync(path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect/DirectWifiModule.kt'),'utf8');
  assert.match(source,/check\(epoch == lifecycleEpoch\)/);
  assert.match(source,/if \(r == null \|\| r.id == id\) lifecycleEpoch\+\+/);
  const stop=source.slice(source.indexOf('private fun stop(r: Run'));
  assert.ok(stop.indexOf('context.stopService') < stop.indexOf('releaseOwnedGroup(r, promise)'));
  // Only this run's observed group may be removed; a differently named group
  // is a foreign link and must survive teardown.
  assert.match(stop,/r\.networkName != null && group\.networkName != r\.networkName/);
  assert.doesNotMatch(source,/expectedSsid/);
  assert.match(stop,/awaitGroupReleased/);
  assert.doesNotMatch(source,/warmGroup|warmExpiry/);
});

test('handoff closes Nearby before P2P and preserves foreign groups',()=>{
  const dir=path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect');
  const transport=fs.readFileSync(path.join(dir,'NearbyTransport.kt'),'utf8');
  const direct=fs.readFileSync(path.join(dir,'DirectWifiModule.kt'),'utf8');
  assert.match(transport,/private const val SERVICE_ID = "com.kelakonnect.nearby.control.v2"/);
  assert.match(transport,/handoffReadySession != id/);
  const release=transport.slice(transport.indexOf('fun releaseForDirectCall'),transport.indexOf('fun resumeAfterDirectCall'));
  assert.match(release,/client.stopAllEndpoints\(\)/);
  assert.ok(release.indexOf('directSession = id')<release.indexOf('client.stopAllEndpoints'));
  assert.match(transport,/PayloadTransferUpdate.Status.SUCCESS\) promise.resolve\(true\)/);
  assert.match(transport,/epoch != discoveryEpoch \|\| directSession != null/);
  assert.match(transport,/if \(!DirectWifiModule.radioReleased\)/);
  const resume=transport.slice(transport.indexOf('fun resumeAfterDirectCall'),transport.indexOf('private fun advertisingOptions'));
  assert.match(resume,/directSession == null && session == id/);
  assert.match(resume,/session = null; sessionEndpoint = null; incoming = null/);
  const wait=direct.slice(direct.indexOf('private fun waitForBootstrapRelease'),direct.indexOf('@ReactMethod fun prepareCallGroup'));
  assert.match(wait,/attempt < 20/);
  // Hardware proof (log_bigk_SM_10 + round 7): a group reported here is a
  // leftover of OUR OWN earlier createGroup() that nothing ever deletes, so
  // "never call removeGroup" dead-ended every call for 7s and then failed.
  // A link carrying another app's traffic always has a connected client, so
  // only an IDLE group is cleared, and only after Nearby's async grace.
  assert.match(wait,/attempt == 3 \|\| attempt == 10/);
  assert.match(wait,/clearing the idle leftover P2P group/);
  // Round 9: `clients == 0` ALONE is always true for a phone that is a CLIENT
  // (requestGroupInfo cannot see the owner's member list from there), and the
  // group a client sees is usually the one the current call just formed. The
  // caller deleted the callee's live group that way; the callee's listener died
  // SocketException -> BindException. Only an OWNED group may be removed.
  assert.match(wait,/group\.isGroupOwner && clients == 0/);
  assert.match(wait,/leaving the previous P2P link alone \(role=/);
  assert.doesNotMatch(wait,/did not close/);
  assert.match(wait,/previous P2P link never released; starting app-owned link anyway/);
  assert.match(direct,/r\.networkName != null && group\.networkName != r\.networkName/);
  assert.match(direct,/r\.operationPending \|\| !r\.cancelSettled/);
  assert.match(direct,/now - r\.absentSince >= 1500/);
});
