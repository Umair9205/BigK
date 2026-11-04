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
test('availability requests Bluetooth/Wi-Fi permissions and advertises without discovery', async () => {
  let advertised=0, requested=[];
  const {ensureNearbyAvailable} = load('services/NearbyAvailability.ts', {
    'react-native':{Platform:{OS:'android',Version:34},PermissionsAndroid:{PERMISSIONS:{ACCESS_FINE_LOCATION:'location'},RESULTS:{GRANTED:'granted'},
      requestMultiple:async p => {requested=p; return Object.fromEntries(p.map(x=>[x,'granted']));}}},
    '../modules/Nearby':{default:{isLocationEnabled:async()=>true,startAdvertising:async()=>advertised++}},
    '../store/appStore':{useAppStore:{getState:()=>({myUUID:'me',myDeviceName:'Phone'})}},
  });
  const first=ensureNearbyAvailable(); assert.equal(first,ensureNearbyAvailable()); await first;
  assert.equal(advertised,1); assert.ok(requested.includes('android.permission.BLUETOOTH_ADVERTISE'));
  assert.ok(requested.includes('android.permission.NEARBY_WIFI_DEVICES'));
});
test('Location switch off blocks advertising even with granted permissions and offers settings', async () => {
  let advertised=0, opened=0; const alerts=[];
  let enabled=false;
  const f=load('services/NearbyAvailability.ts', {
    'react-native':{Platform:{OS:'android',Version:34},AppState:{currentState:'active'},Alert:{alert:(...args)=>alerts.push(args)},PermissionsAndroid:{PERMISSIONS:{ACCESS_FINE_LOCATION:'location'},RESULTS:{GRANTED:'granted'},requestMultiple:async p=>Object.fromEntries(p.map(x=>[x,'granted']))}},
    '../modules/Nearby':{default:{isLocationEnabled:async()=>enabled,openLocationSettings:async()=>opened++,startAdvertising:async()=>advertised++}},
    '../store/appStore':{useAppStore:{getState:()=>({myUUID:'me',myDeviceName:'Phone'})}},
  });
  await assert.rejects(f.ensureNearbyAvailable(),/Location is off/);
  await assert.rejects(f.ensureNearbyAvailable(),/Location is off/);
  assert.equal(advertised,0);assert.equal(alerts.length,1);
  alerts[0][2][1].onPress();assert.equal(opened,1);
  enabled=true;await f.ensureNearbyAvailable();assert.equal(advertised,1);
});

test('Location off while backgrounded does not open a dialog',async()=>{
  let alerts=0;
  const f=load('services/NearbyAvailability.ts',{
    'react-native':{Platform:{OS:'android'},AppState:{currentState:'background'},Alert:{alert:()=>alerts++}},
    '../modules/Nearby':{default:{isLocationEnabled:async()=>false}},
    '../store/appStore':{},
  });
  await assert.rejects(f.ensureLocationEnabled(),/Location is off/);assert.equal(alerts,0);
});
function outgoing(connected) {
  const calls=[]; const services={started:0,stopped:0};
  const exports=load('services/OutgoingCall.ts', {
    'react-native':{Alert:{alert(){}}},'expo-router':{router:{push(){}}},
    '../modules/Nearby':{default:{isConnected:async()=>connected,connect:async id=>{calls.push(id);return true;}}},
    './NearbyAvailability':{ensureNearbyAvailable:async()=>{}},
    './BackgroundAvailability':{callNotifications:{
      startCallService:async()=>{services.started++;},stopCallService:async()=>{services.stopped++;}}},
    './NearbyDiscoveryService':{nearbyDiscoveryService:{getConnectionId:()=> 'discovered',stopDiscovery:async()=>{},forget(){}}},
    './CallSignaling':{signalingManager:{getActiveConnection:()=> 'cached',clearActiveConnection(){},setActiveConnection:(uuid,id)=>calls.push('mapped:'+id)}},
    './CallStateManager':{callStateManager:{getState:()=> 'idle'}},
    '../store/appStore':{useAppStore:{getState:()=>({friends:[]})}},
  });
  return {calls,services,...exports};
}
test('a discovered endpoint must finish native connect before it is registered',async()=>{
  const f=outgoing(false); assert.equal(await f.connectPeer('friend'),'discovered');
  assert.deepEqual(f.calls,['discovered','mapped:discovered']);
});
test('an existing connection is reused only after native verification',async()=>{
  const f=outgoing(true); assert.equal(await f.connectPeer('friend'),'cached'); assert.deepEqual(f.calls,[]);
});
test('disconnection invalidates cached discovery even after scanning stops',async()=>{
  const handlers={}; const sub=name=>fn=>{handlers[name]=fn;return {remove(){delete handlers[name];}};};
  const {NearbyDiscoveryService}=load('services/NearbyDiscoveryService.ts', {
    '../modules/Nearby':{default:{startDiscovery:async()=>{},stopDiscovery:async()=>{},
      onPeerDiscovered:sub('found'),onPeerLost:sub('lost'),onConnectionEstablished:sub('connected'),
      onConnectionClosed:sub('closed'),onDiscoveryError:sub('error')}},
  });
  const service=new NearbyDiscoveryService(); await service.startContinuousDiscovery([{uuid:'friend'}]);
  handlers.found({peerUUID:'friend',peerName:'Friend',connectionId:'endpoint'});
  const events=[];service.onFriendDiscovered(f=>events.push(f.discovered));
  assert.deepEqual(events,[true]); await service.stopDiscovery();
  handlers.closed({connectionId:'endpoint'});
  assert.equal(service.getConnectionId('friend'),null);assert.deepEqual(events,[true,false]);
});

function recoveryFixture(options={}) {
  const events=[], alerts=[], routed=[], statuses=[]; const services={started:0,stopped:0};
  let state='idle', cached='old-endpoint', listener, active, connectCount=0, closeCount=0;
  const errors=options.errors || [Object.assign(new Error('8007: STATUS_RADIO_ERROR'),{code:'CONNECT_FAILED'})];
  const f=load('services/OutgoingCall.ts', {
    'react-native':{Alert:{alert:(...args)=>alerts.push(args)}},
    'expo-router':{router:{push:p=>routed.push(p)}},
    '../modules/Nearby':{default:{
      isConnected:async()=>false,
      connect:async id=>{events.push('connect:'+id);const error=errors[connectCount++];if(options.onConnect)state=options.onConnect(state);if(error)throw error;return true;},
      closeConnection:async id=>{closeCount++;events.push('close:'+id);if(options.closeGate)await options.closeGate;events.push('closed:'+id);if(options.closeError)throw options.closeError;return true;},
    }},
    './NearbyAvailability':{ensureNearbyAvailable:async()=>{}},
    './BackgroundAvailability':{callNotifications:{
      startCallService:async()=>{services.started++;},stopCallService:async()=>{services.stopped++;}}},
    './NearbyDiscoveryService':{nearbyDiscoveryService:{
      getConnectionId:()=>cached,
      forget:(uuid,endpoint)=>{events.push('forget:'+endpoint);if(!endpoint||cached===endpoint)cached=null;},
      stopDiscovery:async()=>events.push('stop-scan'),
      onFriendDiscovered:fn=>{listener=fn;return()=>{listener=null;};},
      startContinuousDiscovery:async()=>{events.push('fresh-scan');cached='fresh-endpoint';listener?.({uuid:'friend',connectionId:cached,discovered:true});},
    }},
    './CallSignaling':{signalingManager:{getActiveConnection:()=>active,
      clearActiveConnection:(uuid,endpoint)=>{events.push('clear:'+endpoint);if(active===endpoint)active=null;},
      setActiveConnection:(uuid,id)=>{active=id;events.push('mapped:'+id);}}},
    './CallStateManager':{callStateManager:{getState:()=>state}},
    '../store/appStore':{useAppStore:{getState:()=>({friends:[{uuid:'friend'}]})}},
  });
  return {...f,events,alerts,routed,statuses,services,onStatus:status=>statuses.push(status),
    setState:value=>{state=value;},setCached:value=>{cached=value;},connectCount:()=>connectCount,closeCount:()=>closeCount};
}

test('radio failure is retried once using fresh discovery after scoped close finishes',async()=>{
  let release;const closeGate=new Promise(resolve=>{release=resolve;});
  const f=recoveryFixture({closeGate});const pending=f.connectPeer('friend',f.onStatus);
  await new Promise(setImmediate);
  assert.ok(f.events.includes('close:old-endpoint'));
  assert.equal(f.events.includes('fresh-scan'),false);
  f.setCached('old-endpoint'); // Late discovery notification during native teardown.
  release();assert.equal(await pending,'fresh-endpoint');
  assert.equal(f.connectCount(),2);assert.equal(f.closeCount(),1);
  assert.ok(f.events.indexOf('closed:old-endpoint')<f.events.indexOf('fresh-scan'));
  assert.ok(f.events.includes('clear:old-endpoint'));
  assert.ok(f.statuses.includes('Retrying connection once…'));
});

test('endpoint IO error retries once but repeated failure is not an endless loop',async()=>{
  const error=new Error('8012: STATUS_ENDPOINT_IO_ERROR');
  const f=recoveryFixture({errors:[error,error,error]});
  await assert.rejects(f.connectPeer('friend'),/8012/);
  assert.equal(f.connectCount(),2);assert.equal(f.closeCount(),2);
  assert.deepEqual(f.events.filter(e=>e.startsWith('connect:')),['connect:old-endpoint','connect:fresh-endpoint']);
});

test('non-transient connection failures are cleaned up without automatic retry',async()=>{
  const error=Object.assign(new Error('Connection rejected'),{code:'REJECTED'});
  const f=recoveryFixture({errors:[error]});
  await assert.rejects(f.connectPeer('friend'),/Connection rejected/);
  assert.equal(f.connectCount(),1);assert.equal(f.closeCount(),1);
  assert.equal(f.events.includes('fresh-scan'),false);
});

test('Nearby generic ERROR is retried once only when it is a connection failure',async()=>{
  const error=Object.assign(new Error('Status{statusCode=ERROR, resolution=null}'),{code:'CONNECT_FAILED'});
  const f=recoveryFixture({errors:[error]});
  assert.equal(await f.connectPeer('friend'),'fresh-endpoint');
  assert.equal(f.connectCount(),2);
  const permissions=recoveryFixture({errors:[Object.assign(new Error('13: permission denied'),{code:'PERMISSION_DENIED'})]});
  await assert.rejects(permissions.connectPeer('friend'),/permission denied/);
  assert.equal(permissions.connectCount(),1);
});

test('native refusal to scan does not leave a false scanning flag or cached peer',async()=>{
  const handlers={};const sub=name=>fn=>{handlers[name]=fn;return {remove(){}};};
  let allowed=true;
  const {NearbyDiscoveryService}=load('services/NearbyDiscoveryService.ts',{
    '../modules/Nearby':{default:{startDiscovery:async()=>allowed,stopDiscovery:async()=>{},
      onPeerDiscovered:sub('found'),onPeerLost:sub('lost'),onConnectionEstablished:sub('connected'),
      onConnectionClosed:sub('closed'),onDiscoveryError:sub('error')}},
  });
  const service=new NearbyDiscoveryService();await service.startContinuousDiscovery([{uuid:'friend'}]);
  handlers.found({peerUUID:'friend',connectionId:'endpoint'});
  allowed=false;await service.startContinuousDiscovery([{uuid:'friend'}]);
  assert.equal(service.isScanning(),false);assert.equal(service.getConnectionId('friend'),null);
  allowed=true;await service.startContinuousDiscovery([{uuid:'friend'}]);
  assert.equal(service.isScanning(),true);
});

test('a stale discovery rejection cannot stop a newer scan',async()=>{
  const handlers={};const sub=name=>fn=>{handlers[name]=fn;return {remove(){}};};
  let rejectOld,first=true,stops=0;
  const {NearbyDiscoveryService}=load('services/NearbyDiscoveryService.ts',{
    '../modules/Nearby':{default:{startDiscovery:()=>{if(first){first=false;return new Promise((_,reject)=>{rejectOld=reject;});}return Promise.resolve(true);},stopDiscovery:async()=>{stops++;},
      onPeerDiscovered:sub('found'),onPeerLost:sub('lost'),onConnectionEstablished:sub('connected'),
      onConnectionClosed:sub('closed'),onDiscoveryError:sub('error')}},
  });
  const service=new NearbyDiscoveryService();const old=service.startContinuousDiscovery([{uuid:'friend'}]);
  const rejected=assert.rejects(old,/cancelled/);
  await service.stopDiscovery();await service.startContinuousDiscovery([{uuid:'friend'}]);
  rejectOld(new Error('cancelled'));await rejected;
  assert.equal(service.isScanning(),true);assert.equal(stops,1);
});

test('a stalled scan refreshes once within the existing call deadline',async()=>{
  let scans=0,stops=0,listener,connected;
  const {connectPeer}=load('services/OutgoingCall.ts',{
    'react-native':{Alert:{alert(){}}},'expo-router':{router:{push(){}}},
    '../modules/Nearby':{default:{connect:async id=>{connected=id;return true;}}},
    './NearbyAvailability':{ensureNearbyAvailable:async()=>{}},
    './BackgroundAvailability':{callNotifications:{startCallService:async()=>{},stopCallService:async()=>{}}},
    './NearbyDiscoveryService':{nearbyDiscoveryService:{getConnectionId:()=>null,
      stopDiscovery:async()=>{stops++;},onFriendDiscovered:fn=>{listener=fn;return()=>{listener=null;};},
      startContinuousDiscovery:async()=>{if(++scans===2)listener({uuid:'friend',connectionId:'recovered',discovered:true});}}},
    './CallSignaling':{signalingManager:{getActiveConnection:()=>null,setActiveConnection(){}}},
    './CallStateManager':{callStateManager:{getState:()=> 'idle'}},
    '../store/appStore':{useAppStore:{getState:()=>({friends:[{uuid:'friend'}]})}},
  },{setTimeout:(fn,ms)=>setTimeout(fn,ms===6000?20:ms===15000?500:ms),clearTimeout});
  assert.equal(await connectPeer('friend'),'recovered');
  assert.equal(scans,2);assert.equal(stops,2);assert.equal(connected,'recovered');assert.equal(listener,null);
});

test('cleanup failure prevents a fresh scan or second connection attempt',async()=>{
  const f=recoveryFixture({closeError:new Error('cleanup unavailable')});
  await assert.rejects(f.connectPeer('friend'),/8007/);
  assert.equal(f.connectCount(),1);assert.equal(f.events.includes('fresh-scan'),false);
});

test('an incoming call taking over prevents retry, disconnect, and error popup',async()=>{
  const f=recoveryFixture({onConnect:()=> 'discovery'});
  await f.placeCall('friend','Friend');
  assert.equal(f.connectCount(),1);assert.equal(f.closeCount(),0);
  assert.deepEqual(f.alerts,[]);assert.deepEqual(f.routed,[]);
  // The primed call service now belongs to the incoming call; a failed
  // outgoing dial must never stop it out from under that call.
  assert.equal(f.services.started,1);assert.equal(f.services.stopped,0);
});

test('dialing primes the call service beside the radio connect and stops it on failure',async()=>{
  const success=outgoing(true);
  await success.placeCall('friend','Friend');
  assert.equal(success.services.started,1);assert.equal(success.services.stopped,0);
  const failure=recoveryFixture({errors:[Object.assign(new Error('Connection rejected'),{code:'REJECTED'})]});
  await failure.placeCall('friend','Friend');
  assert.equal(failure.services.started,1);assert.equal(failure.services.stopped,1);
  assert.equal(failure.alerts.length,1);
});

test('another call starting during cleanup cancels retry',async()=>{
  let release;const closeGate=new Promise(resolve=>{release=resolve;});
  const f=recoveryFixture({closeGate});const pending=f.connectPeer('friend');
  await new Promise(setImmediate);f.setState('streaming');release();
  await assert.rejects(pending,/Another call/);
  assert.equal(f.connectCount(),1);assert.equal(f.events.includes('fresh-scan'),false);
});

test('friendly error text replaces raw radio/endpoint error while unknown useful text remains',()=>{
  const f=recoveryFixture();
  for(const message of ['8007: STATUS_RADIO_ERROR','8012: STATUS_ENDPOINT_IO_ERROR']) {
    const friendly=f.connectionErrorMessage(new Error(message));
    assert.match(friendly,/wireless connection/);assert.doesNotMatch(friendly,/STATUS_/);
  }
  assert.match(f.connectionErrorMessage({code:'CONNECT_TIMEOUT',message:'timeout'}),/did not respond/);
  assert.equal(f.connectionErrorMessage(new Error('Location is off')),'Location is off');
});

test('forgetting a failed discovered endpoint notifies UI but preserves a newer endpoint',async()=>{
  const handlers={};const sub=name=>fn=>{handlers[name]=fn;return {remove(){}};};
  const {NearbyDiscoveryService}=load('services/NearbyDiscoveryService.ts',{
    '../modules/Nearby':{default:{startDiscovery:async()=>{},stopDiscovery:async()=>{},
      onPeerDiscovered:sub('found'),onPeerLost:sub('lost'),onConnectionEstablished:sub('connected'),
      onConnectionClosed:sub('closed'),onDiscoveryError:sub('error')}},
  });
  const service=new NearbyDiscoveryService();await service.startContinuousDiscovery([{uuid:'friend'}]);
  handlers.found({peerUUID:'friend',connectionId:'new'});
  const events=[];service.onFriendDiscovered(friend=>events.push(friend.discovered));
  service.forget('friend','old');assert.equal(service.getConnectionId('friend'),'new');
  service.forget('friend','new');assert.equal(service.getConnectionId('friend'),null);
  assert.deepEqual(events,[true,false]);
  await service.stopDiscovery();handlers.found({peerUUID:'friend',connectionId:'late'});
  assert.equal(service.getConnectionId('friend'),null);
});

test('clearing stale signaling leaves a replacement mapping intact',()=>{
  const {signalingManager:signals}=load('services/CallSignaling.ts',{
    '../modules/Nearby':{default:{onConnectionClosed:()=>({remove(){}}),onBandwidthChanged:()=>({remove(){}}),onDataReceived:()=>({remove(){}})}},
  });
  signals.setActiveConnection('friend','new');signals.clearActiveConnection('friend','old');
  assert.equal(signals.getActiveConnection('friend'),'new');
  signals.clearActiveConnection('friend','new');assert.equal(signals.getActiveConnection('friend'),undefined);
});

test('direct handoff readiness waits for confirmed payload transfer and uses the v2 protocol',async()=>{
  let confirm;const gate=new Promise(resolve=>{confirm=resolve;});const sent=[];
  const {signalingManager:signals}=load('services/CallSignaling.ts',{
    '../modules/Nearby':{default:{onConnectionClosed:()=>({remove(){}}),onBandwidthChanged:()=>({remove(){}}),onDataReceived:()=>({remove(){}}),
      sendData:async(id,json)=>{sent.push(['normal',id,JSON.parse(json)]);return true;},
      sendDataConfirmed:async(id,json)=>{sent.push(['confirmed',id,JSON.parse(json)]);return gate;}}},
  });
  signals.setMyUUID('me');signals.setActiveConnection('friend','endpoint');
  assert.equal(await signals.sendCallRequest('friend','call','My phone'),true);
  assert.equal(sent[0][0],'normal');assert.equal(sent[0][2].data.mediaEngine,'webrtc-direct-v2');
  let ready=false;const result=signals.sendDirectReady('friend','call','11:22:33:44:55:66').then(value=>{ready=true;return value;});
  await new Promise(setImmediate);assert.equal(ready,false);
  assert.equal(sent[1][0],'confirmed');assert.equal(sent[1][2].type,'direct-ready');
  assert.equal(sent[1][2].version,2);
  assert.equal(sent[1][2].data.mediaEngine,'webrtc-direct-v2');
  assert.equal(sent[1][2].data.peerP2pAddress,'11:22:33:44:55:66');
  confirm(true);assert.equal(await result,true);
});

test('a failed handoff transfer is not reported as successful',async()=>{
  const {signalingManager:signals}=load('services/CallSignaling.ts',{
    '../modules/Nearby':{default:{onConnectionClosed:()=>({remove(){}}),onBandwidthChanged:()=>({remove(){}}),onDataReceived:()=>({remove(){}}),
      sendDataConfirmed:async()=>false}},
  });
  signals.setActiveConnection('friend','endpoint');
  assert.equal(await signals.sendDirectReady('friend','call','11:22:33:44:55:66'),false);
});
