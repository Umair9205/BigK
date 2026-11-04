const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const source=fs.readFileSync(path.join(root,'services/RingtoneSettings.ts'),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const m={exports:{}};new Function('exports','module',js)(m.exports,m);
const describe=m.exports.ringtoneDescription;
const normal={name:'Default ringtone',notificationsEnabled:true,channelEnabled:true,soundAllowed:true,vibration:true};
test('ringtone label reflects Android selected sound',()=>assert.match(describe(normal,true),/Default ringtone/));
test('disabled alerts never suggest sound will play',()=>assert.match(describe(normal,false),/alerts off/));
test('blocked application or channel is surfaced',()=>{
  assert.match(describe({...normal,notificationsEnabled:false},true),/blocked/);
  assert.match(describe({...normal,channelEnabled:false},true),/blocked/);
});
test('silent or low-importance channel is surfaced',()=>assert.match(describe({...normal,soundAllowed:false},true),/Silent/));
test('not yet loaded settings do not invent a selected ringtone',()=>assert.equal(describe(null,true),'Choose sound in Android settings'));
test('native ringtone settings and notification use the same persistent channel',()=>{
  const native=fs.readFileSync(path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect/IncomingCallNotification.kt'),'utf8');
  const bridge=fs.readFileSync(path.join(root,'android/app/src/main/java/com/anonymous/kelakonnect/CallForegroundServiceModule.kt'),'utf8');
  assert.match(native,/getNotificationChannel\(id\)\?\.let \{ return it \}/);
  assert.match(native,/val channel = ensureChannel\(context, audible\).id/);
  assert.match(native,/\.setSilent\(!audible\)/);
  assert.match(bridge,/Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS/);
  assert.match(bridge,/Settings.EXTRA_CHANNEL_ID, channel.id/);
  assert.doesNotMatch(native,/deleteNotificationChannel/);
});
