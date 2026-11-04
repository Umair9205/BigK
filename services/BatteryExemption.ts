/**
 * BatteryExemption — the one-time "let BigK run in the background" ask.
 *
 * Android's battery-optimization exemption is the standard switch that keeps a
 * background service alive. Round 18 showed what happens without it: Transsion's
 * Usf_Hiber froze our running foreground service 5 s after Home, proxied the
 * wake lock, and background receive died with the process.
 *
 * Asked at most once per install, only while foregrounded and never mid-call.
 * Declining is remembered (the Settings row stays as the manual path) and
 * never blocks setup or a call.
 */
import { Alert, AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { callNotifications } from './BackgroundAvailability';
import { callStateManager } from './CallStateManager';

const ASKED_KEY = 'batteryExemptionAsked';
let inFlight = false;

/** Null on iOS or on an APK too old to expose the bridge. */
function bridge() {
  const native = callNotifications;
  return typeof native?.isBatteryUnrestricted === 'function' ? native : null;
}

export async function isBatteryUnrestricted(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const native = bridge();
  if (!native) return false;
  try { return !!(await native.isBatteryUnrestricted()); }
  catch (error) { console.warn('[BatteryExemption] state check failed', String(error)); return false; }
}

function waitForActive(): Promise<void> {
  return new Promise(resolve => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') { sub.remove(); resolve(); }
    });
  });
}

async function rememberAsked(): Promise<void> {
  try { await AsyncStorage.setItem(ASKED_KEY, '1'); }
  catch { /* best effort — a lost flag only means one more prompt */ }
}

async function grant(): Promise<void> {
  await rememberAsked();
  const native = bridge();
  if (!native) return;
  try {
    await native.requestBatteryExemption();
    console.log('[BatteryExemption] system dialog requested');
    // Log the outcome on return: this is the line the retest greps for.
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active') return;
      sub.remove();
      void isBatteryUnrestricted().then(ok =>
        console.log(`[BatteryExemption] after prompt: unrestricted=${ok}`));
    });
  } catch (error) { console.warn('[BatteryExemption] request failed', String(error)); }
}

/** Ask once per install when identity is ready. Never throws, never blocks. */
export async function ensureBatteryExemption(): Promise<void> {
  if (Platform.OS !== 'android' || inFlight) return;
  inFlight = true;
  try {
    if (AppState.currentState !== 'active') await waitForActive();
    if (callStateManager.getState() !== 'idle') return;
    if (await isBatteryUnrestricted()) { console.log('[BatteryExemption] already unrestricted'); return; }
    if (await AsyncStorage.getItem(ASKED_KEY)) return;
    await new Promise<void>(resolve =>
      Alert.alert(
        'Keep calls coming in',
        'Some phones switch apps off when the screen goes off, which would stop calls from nearby friends reaching this phone.\n\n' +
        'Allow BigK to run in the background? This is a one-time setting.',
        [
          { text: 'Not now', style: 'cancel', onPress: () => void rememberAsked().then(resolve) },
          { text: 'Allow', onPress: () => void grant().then(resolve) },
        ],
      ),
    );
  } catch (error) {
    console.warn('[BatteryExemption]', String(error));
  } finally { inFlight = false; }
}
