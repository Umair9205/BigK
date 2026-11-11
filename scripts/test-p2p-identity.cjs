const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');

function load(file) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const m = { exports: {} };
  new Function('module', 'exports', js)(m, m.exports);
  return m.exports;
}

const identity = load('services/P2pIdentity.ts');

test('SHA-256 matches the standard vectors without a crypto dependency', () => {
  assert.equal(identity.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(identity.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(identity.sha256Hex('The quick brown fox jumps over the lazy dog'),
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
});

test('the P2P tag is a stable, hash-derived identity and not the raw UUID', () => {
  const uuid = 'abcd1234-5678-4abc-9def-0123456789ab';
  const tag = identity.p2pTag(uuid);
  assert.match(tag, /^BK-[0-9a-f]{12}$/);
  assert.equal(tag, identity.p2pTag(uuid));
  assert.equal(tag, identity.p2pTag(`  ${uuid.toUpperCase()}  `));
  assert.notEqual(tag, identity.p2pTag('abcd1234-5678-4abc-9def-0123456789ac'));
  // The tag must not leak the UUID text it was derived from.
  assert.ok(!tag.includes('abcd1234'));
  assert.equal(identity.p2pTag(''), '');
});

test('discovery candidates are tag-first with a display-name fallback', () => {
  const uuid = 'abcd1234-5678-4abc-9def-0123456789ab';
  const tag = identity.p2pTag(uuid);
  assert.deepEqual(identity.expectedPeerNames(uuid, 'Farid'), [tag, 'Farid']);
  assert.deepEqual(identity.expectedPeerNames(uuid, ''), [tag]);
  assert.deepEqual(identity.expectedPeerNames(uuid, null), [tag]);
  // A display name equal to the tag must not duplicate it.
  assert.deepEqual(identity.expectedPeerNames(uuid, tag), [tag]);
});

test('placeholder and malformed MACs are rejected, real ones normalised', () => {
  assert.equal(identity.validP2pMac('02:00:00:00:00:00'), null);
  assert.equal(identity.validP2pMac('00:00:00:00:00:00'), null);
  assert.equal(identity.validP2pMac(''), null);
  assert.equal(identity.validP2pMac(null), null);
  assert.equal(identity.validP2pMac('not-a-mac'), null);
  assert.equal(identity.validP2pMac('F6:7D:EF:97:DA:68'), 'f6:7d:ef:97:da:68');
});

test('the session token is symmetric, deterministic and session-bound', () => {
  const a = 'abcd1234-5678-4abc-9def-0123456789ab';
  const b = 'FFFF1234-5678-4abc-9def-0123456789ac';
  const session = 'm3x9k2-abcdef12';
  const token = identity.pairToken(a, b, session);
  assert.match(token, /^[0-9a-f]{64}$/);
  // Both phones derive the same value regardless of argument order or case.
  assert.equal(token, identity.pairToken(b, a, session));
  assert.equal(token, identity.pairToken(` ${a.toUpperCase()} `, b, session));
  assert.equal(token, identity.pairToken(a, b, session));
  // A different session or friend must change the token.
  assert.notEqual(token, identity.pairToken(a, b, `${session}-other`));
  assert.notEqual(token, identity.pairToken(a, 'other-uuid', session));
  // Incomplete inputs never produce a token that could authenticate a socket.
  assert.equal(identity.pairToken('', b, session), '');
  assert.equal(identity.pairToken(a, '', session), '');
  assert.equal(identity.pairToken(a, b, ''), '');
});

test('the call path persists and reuses the MAC through the DirectWifi wrapper', () => {
  const source = fs.readFileSync(path.join(root, 'modules/DirectWifi.ts'), 'utf8');
  assert.match(source, /import \{ useAppStore \} from '\.\.\/store\/appStore'/);
  assert.match(source, /expectedPeerNames\(uuid, deviceName\)/);
  assert.match(source, /validP2pMac\(store\.getCurrentMac\(uuid\)\)/);
  assert.match(source, /store\.updateFriendMac\(uuid, valid\)/);
  assert.match(source, /setDeviceTag: \(uuid: string\)/);
  assert.match(source, /p2pTag\(uuid\)/);
  // The audio handoff must ask the wrapper with the friend UUID, not build a
  // raw name array, so the MAC cache is consulted on every call.
  const audio = fs.readFileSync(path.join(root, 'services/DirectCallAudio.ts'), 'utf8');
  assert.match(audio, /wifi\.getPeerP2pAddress\(r\.peer, r\.peerDeviceName\)/);
});

test('app startup publishes the identity tag and native applies it to the radio', () => {
  const layout = fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8');
  assert.match(layout, /void wifi\.setDeviceTag\(myUUID\)/);
  const native = fs.readFileSync(path.join(
    root, 'android/app/src/main/java/com/anonymous/kelakonnect/DirectWifiModule.kt'), 'utf8');
  assert.match(native, /@ReactMethod fun setDeviceTag\(tag: String, promise: Promise\)/);
  // Wi-Fi Direct has no public setDeviceName(); the tag is advertised as a
  // DNS-SD service instance and resolved back to a P2P address by tag.
  assert.match(native, /WifiP2pDnsSdServiceInfo\.newInstance\(tag, SERVICE_TYPE/);
  assert.match(native, /setDnsSdResponseListeners\(c,/);
  assert.match(native, /serviceMacs\[name\] = srcDevice\.deviceAddress/);
  assert.match(native, /private fun installDnsSdListeners/);
  assert.match(native, /private fun applyDeviceTag\(\)/);
  // The tag must be applied both when identity arrives and on radio touch.
  assert.match(native, /override fun initialize\(\)[\s\S]*?applyDeviceTag\(\)/);
  assert.match(native, /fun warmUpPeerDiscovery[\s\S]*?applyDeviceTag\(\)/);
});

test('the native callee listener and dialer replace the Nearby bootstrap', () => {
  const native = fs.readFileSync(path.join(
    root, 'android/app/src/main/java/com/anonymous/kelakonnect/DirectWifiModule.kt'), 'utf8');
  // Always-on callee side: identity tag, -CALL beacon, authenticated accept.
  assert.match(native, /@ReactMethod fun startCallListener\(myUuid: String, friends: String, promise: Promise\)/);
  assert.match(native, /@ReactMethod fun stopCallListener\(promise: Promise\)/);
  assert.match(native, /private fun startListenerThread\(\)/);
  assert.match(native, /private fun handleIncoming\(socket: Socket\)/);
  assert.match(native, /emitRaw\("onIncomingCall"/);
  assert.match(native, /val expected = pairToken\(me, from, sessionId\)/);
  assert.match(native, /MessageDigest\.isEqual/);
  // The caller forms the group and opens the authenticated socket itself.
  assert.match(native, /@ReactMethod fun dialCall\(id: String, peerAddress: String, peerUuid: String, promise: Promise\)/);
  assert.match(native, /r\.relay = false/);
  assert.match(native, /private fun pairToken\(a: String, b: String, sessionId: String\)/);
  // The call beacon is the caller's tag with a suffix; the callee joins on it.
  assert.match(native, /if \(beaconOn\) "\$base-CALL" else base/);
  assert.match(native, /name\.endsWith\("-CALL"\)/);
  assert.match(native, /maybeJoinCallGroup\(base, srcDevice\.deviceAddress\)/);
  // Both sides still default to the keeper relay; the new dial opts out
  // because the persistent listener owns the real P2P port.
  assert.match(native, /r\.relay && KeeperVpnService\.configureRelay\(true, localIp, ip\)/);
});

test('the live call UI uses DirectCallFlow and never the Nearby bootstrap', () => {
  const flow = fs.readFileSync(path.join(root, 'services/DirectCallFlow.ts'), 'utf8');
  assert.match(flow, /pairToken\(me, peerUuid, sessionId\)/);
  assert.match(flow, /wifi\.dialCall\(sessionId, address, peerUuid\)/);
  assert.match(flow, /wifi\.send\(sessionId, callSignal\('call-request'/);
  assert.match(flow, /callSignal\('call-accept'/);
  assert.match(flow, /callSignal\('call-reject'/);
  assert.match(flow, /callSignal\('call-end'/);
  // Unplugged, not deleted: the flow must not import the legacy transport.
  assert.doesNotMatch(flow, /from '\.\.\/modules\/Nearby'/);
  assert.doesNotMatch(flow, /from '\.\.\/services\/CallSignaling'/);
  const home = fs.readFileSync(path.join(root, 'components/CallingHome.tsx'), 'utf8');
  assert.match(home, /import \{ placeDirectCall \} from '\.\.\/services\/DirectCallFlow'/);
  assert.match(home, /placeDirectCall\(uuid, label, setDialStatus\)/);
  assert.doesNotMatch(home, /placeCall\(uuid/);
  // The root layout surfaces the native authenticated incoming call.
  const layout = fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8');
  assert.match(layout, /wifi\.onIncomingCall\(e =>/);
  assert.match(layout, /rejectDirectCall\(e\.sessionId, e\.from\)/);
  assert.match(layout, /localIp: call\.localIp/);
  // The new call screen is selected by the session/localIp params only.
  const call = fs.readFileSync(path.join(root, 'app/call.tsx'), 'utf8');
  assert.match(call, /<DirectCallScreen role="caller"/);
  const incoming = fs.readFileSync(path.join(root, 'app/incoming-call.tsx'), 'utf8');
  assert.match(incoming, /<DirectCallScreen role="callee"/);
});

test('direct audio skips the Nearby handoff and replays early signals', () => {
  const audio = fs.readFileSync(path.join(root, 'services/DirectCallAudio.ts'), 'utf8');
  // Direct mode goes straight to WebRTC over the already-authenticated socket.
  assert.match(audio, /if \(direct\) \{/);
  assert.match(audio, /r\.socketReady = true;\s*\n\s*r\.localIp = direct\.localIp;/);
  assert.match(audio, /await this\.initializeMedia\(r\);/);
  // The legacy handoff remains compiled but is bypassed in direct mode.
  assert.match(audio, /r\.handoff = this\.handoff\(r, credentials\)/);
  // Call-level messages do not enter the WebRTC enqueue path.
  assert.match(audio, /msg\.type === 'call-request'/);
  // A signal that arrived before the audio run subscribed can be replayed.
  assert.match(audio, /inject\(id: string, data: string\)/);
  // Nearby resume only happens on the legacy handoff path.
  assert.match(audio, /if \(r\.handoff\) await Nearby\.resumeAfterDirectCall\(r\.id\)/);
  const hook = fs.readFileSync(path.join(root, 'hooks/useDirectCall.ts'), 'utf8');
  assert.match(hook, /audio\.inject\(sessionId, raw\)/);
  assert.match(hook, /audio\.start\(role, peer, sessionId,[\s\S]*?\{ localIp \}\)/);
});
