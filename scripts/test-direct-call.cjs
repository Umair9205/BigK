const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
function load(file, dependencies) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const m = {exports:{}};
  new Function('require','module','exports',js)(name => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
    return dependencies[name];
  },m,m.exports);
  return m.exports;
}
const flush = async () => { for (let i=0;i<8;i++) await new Promise(setImmediate); };
const credentials = {token:'a'.repeat(64),peerP2pAddress:'aa:bb:cc:dd:ee:ff'};
// What Wi-Fi Direct discovery finds for the OTHER phone. It can never equal
// credentials.peerP2pAddress (which arrives in the signal), so the tests prove
// each side dials its own discovery result rather than the carried value.
const discoveredPeerAddress = '66:55:44:33:22:11';
function fixture(t) {
  const handlers = {}, signals = new Map(), sent = [], errors = [], pcs = [];
  const counts = {prepare:0,connect:0,stop:0,tracksStopped:0,audio:0,release:0,resume:0,media:0,peerAddress:0};
  let mediaGate;
  const stream = {getTracks:()=>[track],getAudioTracks:()=>[track]};
  const track = {enabled:true,stop:()=>counts.tracksStopped++};
  const subscribe = key => fn => {handlers[key]=fn;return {remove:()=>delete handlers[key]};};
  const wifi = {
    prepareGroup:async()=>{counts.prepare++;return {token:credentials.token};},
    getPeerP2pAddress:async(uuid,deviceName)=>{counts.peerAddress++;assert.equal(uuid,'peer');assert.equal(deviceName,'Peer Name');return discoveredPeerAddress;},
    connectPeer:async(id,addr,isCaller,token)=>{
      assert.equal(counts.release,1,'Nearby is released before the framework connect');
      assert.equal(addr,discoveredPeerAddress);assert.equal(token,credentials.token);
      assert.equal(typeof isCaller,'boolean');counts.connect++;return true;},
    send:async(id,data)=>{sent.push(JSON.parse(data));return true;}, stop:async()=>{counts.stop++;return true;},
    startAudio:async()=>{counts.audio++;return true;},speaker(){},
    onReady:subscribe('ready'),onSignal:subscribe('signal'),onError:subscribe('error'),
  };
  class PC {
    constructor(config) {this.config=config;this.events={};this.candidates=[];this.signalingState='stable';this.connectionState='new';pcs.push(this);}
    addEventListener(name,fn){this.events[name]=fn;}
    addTrack(){}
    async createOffer(){return {type:'offer',sdp:'v=0\r\n'};}
    async createAnswer(){return {type:'answer',sdp:'v=0\r\n'};}
    async setLocalDescription(s){this.localDescription=s;this.signalingState=s.type==='offer'?'have-local-offer':'stable';}
    async setRemoteDescription(s){this.remoteDescription=s;this.signalingState=s.type==='offer'?'have-remote-offer':'stable';}
    async addIceCandidate(c){assert.ok(this.remoteDescription);this.candidates.push(c);}
    async getStats(){return new Map();}
    close(){this.closed=true;}
    connect(){this.connectionState='connected';this.events.connectionstatechange();}
  }
  const exports=load('services/DirectCallAudio.ts',{
    'react-native-webrtc':{RTCPeerConnection:PC,mediaDevices:{getUserMedia:async()=>{counts.media++;if(mediaGate)await mediaGate;return stream;}}},
    '../modules/DirectWifi':{default:wifi},
    '../modules/Nearby':{default:{
      releaseForDirectCall:async()=>{counts.release++;return true;},
      resumeAfterDirectCall:async()=>{counts.resume++;return true;},
      onConnectionClosed:subscribe('nearbyClosed'),
    }},
    './CallSignaling':{signalingManager:{
      getActiveConnection:()=> 'endpoint',
      on:(event,fn)=>signals.set(event,fn),
      off:(event,fn)=>{if(signals.get(event)===fn)signals.delete(event);},
      sendDirectConfig:async(peer,id,direct)=>{
        // direct-config carries THIS phone's peer-discovery result as a
        // cross-check plus the control token; the address the peer actually
        // dials is the one it discovers itself.
        assert.deepEqual(direct,{peerP2pAddress:discoveredPeerAddress,token:credentials.token});
        signals.get('direct-ready')?.({connectionId:'endpoint',signal:{from:peer,sessionId:id,data:{mediaEngine:'webrtc-direct-v2',peerP2pAddress:credentials.peerP2pAddress}}});
        setImmediate(()=>handlers.nearbyClosed?.({connectionId:'endpoint',reason:'disconnected'}));
        return true;
      },
      sendDirectReady:async(peer,id,address)=>{assert.equal(address,discoveredPeerAddress);assert.equal(id,'test');return true;},
    }},
    './NearbyDiscoveryService':{nearbyDiscoveryService:{stopDiscovery:async()=>{}}},
  });
  const service=new exports.DirectCallAudio();
  t.after(async()=>{await service.stop();await flush();});
  return {service,counts,pcs,sent,errors,exports,handlers,
    start(role='caller'){const p=service.start(role,'peer','test',{onError:e=>errors.push(e),onStatus(){}},credentials,'Peer Name');p.catch(()=>{});return p;},
    ready(){assert.equal(counts.connect,1,'finish handoff before control-ready');handlers.ready?.({sessionId:'test',localIp:'192.168.49.2'});},
    signal(type,data={},id='test'){handlers.signal?.({sessionId:id,data:JSON.stringify({sessionId:id,type,...data})});},
    blockMedia(){let release;mediaGate=new Promise(r=>release=r);return release;},
  };
}
test('only direct-interface UDP host candidates are signaled',t=>{
  const f=fixture(t),accept=f.exports.directCandidate;
  assert.equal(accept('candidate:1 1 udp 1 192.168.49.2 1234 typ host','192.168.49.2'),true);
  assert.equal(accept('candidate:1 1 udp 1 192.168.1.2 1234 typ host','192.168.49.2'),false);
  assert.equal(accept('candidate:1 1 tcp 1 192.168.49.2 1234 typ host','192.168.49.2'),false);
});
test('Android startup enables the installed WebRTC P2P monitor before React lifecycle startup',()=>{
  const source=fs.readFileSync(path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect/MainApplication.kt'),'utf8');
  const enable=source.indexOf('NetworkMonitorAutoDetect.setIncludeWifiDirect(true)');
  assert.ok(enable>source.indexOf('override fun onCreate()'));
  assert.ok(enable<source.indexOf('ApplicationLifecycleDispatcher.onApplicationCreate(this)'));
});
test('native connect splits GO intent, keeps the group on 2.4 GHz, and addresses the peer directly',()=>{
  const source=fs.readFileSync(path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect/DirectWifiModule.kt'),'utf8');
  const connect=source.slice(source.indexOf('@ReactMethod fun connectCallPeer'),source.indexOf('private fun issueConnect'));
  // Builder (API 29) has no groupOwnerIntent setter; the built config exposes
  // the public intent field the framework negotiates from, so it is set after
  // build(). Band stays Builder-driven — there is no public band field.
  assert.match(connect,/setDeviceAddress\(mac\)/);
  assert.match(connect,/setGroupOperatingBand\(WifiP2pConfig\.GROUP_OWNER_BAND_2GHZ\)/);
  assert.match(connect,/groupOwnerIntent = intent/);
  assert.match(connect,/wps\.setup = WpsInfo\.PBC/);
  assert.match(connect,/MacAddress\.fromString\(peerAddress\)/);
  // Both config paths must set the GO intent and WPS push-button setup.
  assert.equal((connect.match(/groupOwnerIntent = intent/g)||[]).length,2);
  assert.equal((connect.match(/wps\.setup = WpsInfo\.PBC/g)||[]).length,2);
  // The placeholder address must never reach connect(): it would mean
  // "connect to anyone". Fail with the actionable message instead.
  assert.match(connect,/mac\.toString\(\) == MAC_ANY_ADDRESS/);
  // Android 11/12-era build() demands a network name ("network name must be
  // non-empty."); those stacks can never build an address-only config, so the
  // Builder path falls back to the legacy config: same address, same GO intent.
  assert.match(connect,/catch \(e: IllegalStateException\)/);
  assert.match(connect,/WifiP2pConfig\(\)\.apply/);
  assert.match(connect,/deviceAddress = mac\.toString\(\)/);
  assert.match(connect,/groupOwnerIntent = intent/);
  assert.doesNotMatch(connect,/groupOperatingBand/);
  assert.match(source,/CALLER_GO_INTENT = 0/);
  assert.match(source,/CALLEE_GO_INTENT = 15/);
  // The SSID/passphrase join race is gone: no configured-network connect remains.
  assert.doesNotMatch(source,/setNetworkName\(|setPassphrase\(/);
});

test('the call path discovers the peer address and never reads its own',()=>{
  const source=fs.readFileSync(path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect/DirectWifiModule.kt'),'utf8');
  const audio=fs.readFileSync(path.join(root,'services/DirectCallAudio.ts'),'utf8');
  const address=source.slice(source.indexOf('@ReactMethod fun getPeerP2pAddress'),source.indexOf('@ReactMethod fun connectCallPeer'));
  // Every local source of this phone's OWN address is disproven on hardware:
  // requestDeviceInfo answers 02:00:00:00:00:00 forever, p2p0 never becomes
  // readable, and createGroup is refused P2P_UNSUPPORTED at every timing and
  // with discovery already running. requestPeers() returns the PEER's address
  // on both test devices — and that is exactly what connect() dials — so
  // discovery is the only source left on the call path.
  assert.match(audio,/wifi\.getPeerP2pAddress\(/);
  assert.doesNotMatch(audio,/wifi\.getP2pAddress\(/);
  assert.doesNotMatch(source,/@ReactMethod fun getP2pAddress/);
  assert.doesNotMatch(source,/private fun pollP2pAddress\(|private fun firstUsable\(|private fun p2pInterfaceAddress\(|fun escalate\(/);
  assert.doesNotMatch(source,/requestDeviceInfo\(/);
  assert.doesNotMatch(source,/createGroup\(activeChannel/);
  assert.match(address,/main\.postDelayed\(\{ attempt\(triesLeft - 1\) \}, ADDRESS_POLL_MS\)/);
  assert.match(address,/attempt\(ADDRESS_ATTEMPTS\)/);
  // Discovery needs 1.4–4s to surface a peer, so it is warmed up at call
  // placement AND at incoming call — the ring supplies that time for free.
  // The warmup must never open the Wi-Fi panel or reject: it is opportunistic.
  const hook=fs.readFileSync(path.join(root,'hooks/useNearbyCall.ts'),'utf8');
  assert.equal((hook.match(/void wifi\.warmUpPeerDiscovery\(\)/g)||[]).length,2,
    'both the caller placement and the callee incoming path must warm up discovery');
  assert.match(source,/fun warmUpPeerDiscovery\(promise: Promise\)/);
  assert.match(source,/peer discovery warmup failed reason=/);
  assert.match(address,/main\.post \{ pollPeerAddress\(expected, expectedMac, promise\) \}/);
  // MAC-keyed path: a saved address resolves before the cold-scan loop, and
  // the identity tag is published through DNS-SD (no public device-name API).
  assert.match(address,/by=cached/);
  assert.match(address,/WifiP2pDnsSdServiceInfo\.newInstance\(tag, SERVICE_TYPE/);
  assert.match(address,/@ReactMethod fun setDeviceTag/);
  // The read brings Wi-Fi up itself instead of telling the user to toggle it.
  assert.match(address,/ensureWifi \{ enabled ->/);
  assert.doesNotMatch(address,/toggle Wi-Fi/);
  // A cold P2P stack is kicked before the first poll, and a refused kick is
  // logged — it had a null listener for four rounds, so refusals were invisible.
  assert.match(address,/discoverPeers\(activeChannel, object : WifiP2pManager\.ActionListener/);
  assert.match(address,/discovery kick failed reason=/);
  // Every observation is logged: the list is what decides whether identity can
  // be resolved at all, and a miss must show exactly what the stack saw.
  assert.match(address,/peer read start sdk=/);
  assert.match(address,/requestPeers\(activeChannel\)/);
  assert.match(address,/peer read left=/);
  assert.match(address,/peer read exhausted peers=/);
  // The budget is bounded by a wall-clock deadline, not by poll count alone.
  assert.match(address,/main\.postDelayed\(deadline, ADDRESS_WAIT_MS\)/);
  assert.match(address,/main\.removeCallbacks\(deadline\)/);
  // A wrong phone must never be dialled: an exact name match wins, otherwise a
  // single AVAILABLE phone, otherwise the read fails loudly with the list.
  assert.match(address,/dn\.equals\(n, true\)/);
  assert.match(address,/p\.status == WifiP2pDevice\.AVAILABLE/);
  assert.match(address,/available\.size == 1/);
  assert.match(address,/promise\.reject\("P2P_PEER_ADDRESS", "Wi-Fi Direct peer not discovered/);
  // Discovery is stopped once the read settles, so connect() starts clean.
  assert.match(address,/stopPeerDiscovery\(activeChannel, null\)/);
  // A placeholder can never be resolved as an address, and none of the three
  // disproven local sources may creep back in a later round.
  assert.doesNotMatch(address,/firstUsable|requestDeviceInfo|createGroup\(/);
  // The handoff rejects a placeholder before anything is sent, so a bad read
  // can never become "connect to anyone" downstream either.
  assert.match(audio,/peerP2pAddress === '02:00:00:00:00:00'/);
  assert.match(audio,/The other phone was not discovered over Wi-Fi Direct/);
});

test('call setup enables Wi-Fi itself, reopens a dead channel and waits out a closing link',()=>{
  const source=fs.readFileSync(path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect/DirectWifiModule.kt'),'utf8');
  // Silent enable first; Android 10+ blocks it for targetSdk >= 29, so the
  // sanctioned system panel opens and the WIFI_STATE_ENABLED broadcast resumes
  // every queued continuation — the user only ever taps the one OS toggle.
  assert.match(source,/wm\.isWifiEnabled = true/);
  assert.match(source,/Settings\.Panel\.ACTION_WIFI/);
  assert.match(source,/WifiManager\.WIFI_STATE_CHANGED_ACTION/);
  assert.match(source,/WIFI_STATE_ENABLED/);
  // A channel dropped by the service is reopened, not met with "reopen the app".
  assert.match(source,/private fun ensureChannel\(\): WifiP2pManager\.Channel\?/);
  // A link that is still closing is waited out, not bounced back to the user.
  assert.match(source,/attempt < BUSY_WAIT_ATTEMPTS && \(stopping \|\| run != null\)/);
  // No message anywhere in the module sends the user to toggle, retry or restart.
  for (const instruction of [/Reopen the app/, /Try again shortly/, /Turn Wi-Fi on/,
      /toggle Wi-Fi/, /End any other Wi-Fi Direct session/, /retry the call/])
    assert.doesNotMatch(source, instruction);
});
test('JS setup backstops outlast the Wi-Fi-off stack they wrap',()=>{
  const wifi=fs.readFileSync(path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect/DirectWifiModule.kt'),'utf8');
  const audio=fs.readFileSync(path.join(root,'services/DirectCallAudio.ts'),'utf8');
  const hook=fs.readFileSync(path.join(root,'hooks/useNearbyCall.ts'),'utf8');
  // The chain runs sequentially when Wi-Fi starts off: panel wait + address
  // poll + native begin watchdog. An outer timer shorter than that sum fires
  // with a generic message while native is still legitimately working, and
  // hides the specific phase error native would have reported.
  const enable=+wifi.match(/WIFI_ENABLE_WAIT_MS = (\d+)/)[1];
  const poll=+wifi.match(/ADDRESS_WAIT_MS = (\d+)/)[1];
  const watchdog=+wifi.match(/writer == null\) fail\(r, "Direct Wi-Fi setup timed out[^"]*"\)\s*\}, (\d+)\)/)[1];
  const stack=enable+poll+watchdog;
  const backstop=+audio.match(/Audio setup timed out[\s\S]*?\}, (\d+)\)/)[1];
  assert.ok(backstop>stack,`DirectCallAudio backstop ${backstop} must exceed stack ${stack}`);
  for (const armed of hook.matchAll(/'Direct call setup timed out'\); }, (\d+)\)/g))
    assert.ok(+armed[1]>stack,`useNearbyCall backstop ${armed[1]} must exceed stack ${stack}`);
  // Pre-accept bounds a human answering, not the Wi-Fi stack: unchanged.
  assert.equal(hook.match(/'Call setup timed out'\); }, (\d+)\)/)[1],'45000');
});
test('native direct candidates reach signaling while router and TCP candidates are excluded',async t=>{
  const f=fixture(t);f.start();await flush();f.ready();await flush();
  for(const raw of ['candidate:1 1 udp 1 192.168.49.2 1234 typ host',
    'candidate:2 1 udp 1 192.168.100.5 1234 typ host','candidate:3 1 tcp 1 192.168.49.2 1234 typ host']) {
    f.pcs[0].events.icecandidate({candidate:{candidate:raw,toJSON:()=>({candidate:raw,sdpMid:'0',sdpMLineIndex:0})}});
  }
  await flush(); const candidates=f.sent.filter(x=>x.type==='ice');
  assert.equal(candidates.length,1);assert.match(candidates[0].candidate.candidate,/192\.168\.49\.2/);
  const sdp='v=0\r\na=candidate:1 1 udp 1 192.168.49.2 1234 typ host\r\na=candidate:2 1 udp 1 192.168.100.5 1234 typ host\r\n';
  assert.ok(f.exports.directSdp(sdp,'192.168.49.2').includes('192.168.49.2'));
  assert.ok(!f.exports.directSdp(sdp,'192.168.49.2').includes('192.168.100.5'));
});
test('route diagnostics use the selected transport pair, not an arbitrary successful candidate',t=>{
  const f=fixture(t),stats=new Map([
    ['unused',{id:'unused',type:'candidate-pair',state:'succeeded',localCandidateId:'router'}],
    ['transport',{type:'transport',selectedCandidatePairId:'direct'}],
    ['direct',{id:'direct',type:'candidate-pair',state:'succeeded',localCandidateId:'local',remoteCandidateId:'remote'}],
    ['local',{type:'local-candidate',ip:'192.168.49.2',protocol:'udp',candidateType:'host'}],
    ['remote',{type:'remote-candidate',address:'192.168.49.1',candidateType:'host'}],
  ]);
  const route=f.exports.selectedRoute(stats);
  assert.equal(route.localIp,'192.168.49.2');assert.equal(route.remoteIp,'192.168.49.1');assert.equal(route.protocol,'udp');
  assert.equal(f.exports.selectedRoute(new Map([['unused',stats.get('unused')]])),null);
});
test('duplicate start connects once; active waits for actual WebRTC connection',async t=>{
  const f=fixture(t),p=f.start(); assert.equal(f.start(),p);await flush();assert.equal(f.counts.connect,1);
  let active=false;p.then(()=>active=true);f.ready();await flush();assert.equal(active,false);
  f.signal('ready');await flush();assert.equal(f.sent.filter(x=>x.type==='offer').length,1);
  f.pcs[0].connect();await p;assert.equal(active,true);assert.deepEqual(f.pcs[0].config.iceServers,[]);
});
test('caller offers without waiting for peer-ready; late ready does not duplicate offer',async t=>{
  const f=fixture(t);f.start();await flush();f.ready();await flush();
  assert.equal(f.sent.filter(x=>x.type==='offer').length,1);
  f.signal('ready');await flush();assert.equal(f.sent.filter(x=>x.type==='offer').length,1);
});
test('microphone capture overlaps direct-link setup and is requested exactly once',async t=>{
  const f=fixture(t);f.start();await flush();
  assert.equal(f.counts.media,1,'capture begins while the handoff/group is still forming');
  f.ready();await flush();
  assert.equal(f.counts.media,1,'media is not requested a second time at control-ready');
});
test('direct-link formation polls fast and control retries are tight',()=>{
  const source=fs.readFileSync(path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect/DirectWifiModule.kt'),'utf8');
  assert.match(source,/private fun pollGroup\(r: Run, delay: Long = 150\)/);
  const wait=source.slice(source.indexOf('private fun waitForBootstrapRelease'),source.indexOf('@ReactMethod fun prepareCallGroup'));
  assert.match(wait,/waitForBootstrapRelease\(r, attempt \+ 1, action\) \}, 100L\)/);
  const socket=fs.readFileSync(path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect/DirectControlSocket.java'),'utf8');
  assert.match(socket,/Thread\.sleep\(60\)/);
  assert.match(socket,/socket\.setTcpNoDelay\(true\)/);
});

test('native transient radio failures are retried broadly and cannot restart a canceled session',()=>{
  const source=fs.readFileSync(path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect/DirectWifiModule.kt'),'utf8');
  assert.match(source,/reason != WifiP2pManager.P2P_UNSUPPORTED && attempt < 8/);
  assert.match(source,/minOf\(250L \* \(attempt \+ 1\), 1500L\)/);
  assert.match(source,/private fun retryBusy[\s\S]*?if \(!current\(r\)\) return/);
});

test('an unformed peer group is refreshed by re-issuing connect instead of stalling',()=>{
  const source=fs.readFileSync(path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect/DirectWifiModule.kt'),'utf8');
  assert.match(source,/CONNECT_REFRESH_MS = 3000L/);
  assert.match(source,/MAX_CONNECT_REFRESHES = 8/);
  const query=source.slice(source.indexOf('private fun queryGroup'),source.indexOf('private fun stage'));
  assert.match(query,/peer group not formed; refreshing connect/);
  assert.match(query,/issueConnect\(r\)/);
  assert.match(query,/SystemClock\.elapsedRealtime\(\) - r\.lastConnectAt >= CONNECT_REFRESH_MS/);
  // The watchdog remains the outer bound; the loop never outlives it.
  assert.match(source,/Direct Wi-Fi setup timed out at \$\{r\.phase\}/);
});

test('group role comes from the framework readback and the client verifies the owner device',()=>{
  const source=fs.readFileSync(path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect/DirectWifiModule.kt'),'utf8');
  const query=source.slice(source.indexOf('private fun queryGroup'),source.indexOf('private fun stage'));
  assert.match(query,/r\.owner = info\.isGroupOwner/);
  assert.doesNotMatch(query,/Unexpected Wi-Fi Direct group role/);
  assert.match(query,/!r\.owner && group\.owner\?\.deviceAddress\?\.lowercase\(\) != r\.peerAddress/);
  // Round-19 P0: XOS reports a placeholder owner address that can never equal
  // the real peer; the token handshake authenticates, so only a genuine
  // mismatch may fail the session.
  assert.match(query,/ownerAddress != "02:00:00:00:00:00"/);
  assert.match(query,/owner address \$ownerAddress is a placeholder/);
});

test('host and client control deadlines allow a slow peer inside the 30s watchdog',()=>{
  const source=fs.readFileSync(path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect/DirectWifiModule.kt'),'utf8');
  assert.match(source,/DirectControlSocket\.now\(\) \+ 25000/);
  assert.match(source,/DirectControlSocket\.now\(\) \+ 20000/);
  assert.ok(source.indexOf('now() + 25000') < source.indexOf('now() + 20000'));
});
test('ICE arriving before the remote description is retained and then applied',async t=>{
  const f=fixture(t);f.start();await flush();f.ready();await flush();
  f.signal('ice',{candidate:{candidate:'candidate:1 1 udp 1 192.168.49.1 1234 typ host'}});
  f.signal('ready');await flush();assert.equal(f.pcs[0].candidates.length,0);
  f.signal('answer',{sdp:{type:'answer',sdp:'v=0\r\n'}});await flush();
  assert.equal(f.pcs[0].candidates.length,1);
  f.signal('ready');await flush();assert.equal(f.sent.filter(x=>x.type==='offer').length,1);
});
test('cancellation during microphone startup stops late tracks and never creates a PC',async t=>{
  const f=fixture(t),release=f.blockMedia(),p=f.start();await flush();f.ready();await flush();
  f.service.stop();release();await assert.rejects(p,/stopped/);await flush();
  assert.equal(f.pcs.length,0);assert.equal(f.counts.tracksStopped,1);assert.equal(f.counts.stop,1);
});
test('control messages arriving before microphone readiness are not lost',async t=>{
  const f=fixture(t),release=f.blockMedia();f.start();await flush();f.ready();f.signal('ready');await flush();
  assert.equal(f.sent.length,0);release();await flush();assert.equal(f.sent.filter(x=>x.type==='offer').length,1);
});
test('old-session events do not affect a new call',async t=>{
  const f=fixture(t);f.start();await flush();f.signal('end',{},'old-session');
  assert.equal(f.service.isStartingOrActive('test'),true);assert.equal(f.errors.length,0);
});
test('callee connects and answers without initiating a competing offer',async t=>{
  const f=fixture(t);f.start('callee');await flush();assert.equal(f.counts.connect,1);
  f.ready();await flush();f.signal('ready');f.signal('offer',{sdp:{type:'offer',sdp:'v=0\r\n'}});await flush();
  assert.equal(f.sent.filter(x=>x.type==='offer').length,0);assert.equal(f.sent.filter(x=>x.type==='answer').length,1);
});
test('hangup is sent before closing direct control; no per-frame audio messages',async t=>{
  const f=fixture(t);f.start();await flush();f.ready();await flush();await f.service.end();
  assert.equal(f.sent.at(-1).type,'end');assert.equal(f.counts.stop,0);
  assert.ok(f.sent.every(x=>x.type!=='audio-frame'));f.service.stop();await flush();assert.equal(f.counts.stop,1);
});
