import { AppState, DeviceEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';
import { create } from 'zustand';
import Nearby from '../modules/Nearby';
import { ensureNearbyAvailable, ensureLocationEnabled, LOCATION_OFF } from './NearbyAvailability';
import { nearbyDiscoveryService as discovery } from './NearbyDiscoveryService';
import { callStateManager as calls } from './CallStateManager';
import { useAppStore } from '../store/appStore';

export const callNotifications = NativeModules.CallForegroundServiceModule;
export function requireCallNotifications(method: string) {
  if (typeof callNotifications?.[method] !== 'function') {
    throw new Error('Local calling support is missing from this installation. Install the updated BigK APK.');
  }
  return callNotifications;
}
export const useAvailability = create<{status: string; enabled: boolean; busy: boolean}>(() => ({
  status: 'Starting local calling…', enabled: false, busy: false,
}));
let pending: Promise<void> | null = null;
let wanted = false;
let generation = 0;

/** The one place that reflects a native pause into JS state. */
function markPaused() {
  wanted = false; generation++;
  void discovery.stopDiscovery();
  void useAppStore.getState().updateSettings({ scanningEnabled: false });
  useAvailability.setState({ enabled: false, status: 'Unavailable · local calling paused' });
}

export async function pauseAvailability() {
  if (calls.getState() !== 'idle') return;
  wanted = false; generation++;
  useAvailability.setState({ busy: true });
  try {
    await useAppStore.getState().updateSettings({ scanningEnabled: false });
    await pending?.catch(() => {});
    await discovery.stopDiscovery();
    await Nearby.stopAdvertising();
    await requireCallNotifications('stopAvailability').stopAvailability();
    useAvailability.setState({ enabled: false, status: 'Unavailable · local calling paused' });
  } catch (error: any) {
    useAvailability.setState({ enabled: false, status: error?.message || 'Could not pause local calling. Reopen BigK and retry.' });
  } finally { useAvailability.setState({ busy: false }); }
}

export function resumeAvailability(request = true, explicitResume = false): Promise<void> {
  if (pending) return pending;
  const ticket = generation;
  wanted = true;
  pending = (async () => {
    useAvailability.setState({ busy: true });
    try {
      if (request && AppState.currentState !== 'active') return;
      requireCallNotifications('startAvailability');
      const native = await requireCallNotifications('availabilityStatus').availabilityStatus();
      if (!explicitResume && native.paused) { markPaused(); return; }
      if (Platform.OS === 'android' && Number(Platform.Version) >= 33 && request)
        await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS' as any);
      // Start while visible; no microphone service is started for idle availability.
      const store = useAppStore.getState();
      await Nearby.configureAvailability(store.myUUID!, store.myDeviceName!, store.friends.map(f => ({uuid: f.uuid, name: f.name})), store.settings.ringtoneEnabled);
      await ensureNearbyAvailable(request);
      if (!wanted || ticket !== generation) return;
      await callNotifications.startAvailability(explicitResume);
      if (!wanted || ticket !== generation) return;
      if (calls.getState() === 'idle') await discovery.startContinuousDiscovery(useAppStore.getState().friends);
      const status = await callNotifications.availabilityStatus();
      if (!wanted || ticket !== generation) return;
      if (!status.running) throw new Error('Background availability stopped. Reopen the app to retry.');
      useAvailability.setState({ enabled: true, status: status.notifications
        ? 'Local calling enabled · reachability checked when you call'
        : 'Notifications blocked · background calls may not alert you' });
      if (request) await useAppStore.getState().updateSettings({ scanningEnabled: true });
    } catch (error: any) {
      useAvailability.setState({ enabled: false, status: error?.message || 'Local calling unavailable' });
      // Do not leave advertisements active after a failed foreground-service start.
      await discovery.stopDiscovery().catch(() => {});
      await Nearby.stopAdvertising().catch(() => {});
    } finally { useAvailability.setState({ busy: false }); }
  })().finally(() => { pending = null; });
  return pending;
}

export const AVAILABILITY_HEALTH_INTERVAL_MS = 60_000;

/**
 * Self-heal pass. OEM killers, slow service starts, or an abandoned call session
 * can silently stop scanning while the process is still alive — foreground or
 * background. Cheap no-op while healthy (one status call per minute).
 * Returns true when the state was healthy, false when recovery was attempted.
 */
export async function availabilityHealthCheck(): Promise<boolean> {
  if (!wanted || pending || calls.getState() !== 'idle') return true;
  try {
    const status = await requireCallNotifications('availabilityStatus').availabilityStatus();
    if (!wanted || calls.getState() !== 'idle') return true;
    if (status.paused) { markPaused(); return true; }
    // `scanning` is absent on older APKs (undefined), never treated as broken.
    if (status.running && status.scanning !== false) return true;
    console.warn('[Availability] Health check failed; recovering', JSON.stringify(status));
    await resumeAvailability(false);
    return false;
  } catch (error) {
    console.warn('[Availability] Health check error', String(error));
    return false;
  }
}

/** App lifetime, not screen lifetime. No interval scans and no scanning during audio. */
export function startAvailabilityLifecycle() {
  if (!useAppStore.getState().settings.scanningEnabled)
    useAvailability.setState({ enabled: false, status: 'Unavailable · local calling paused' });
  const app = AppState.addEventListener('change', state => {
    if (state === 'active' && wanted && calls.getState() === 'idle') void resumeAvailability(false);
  });
  const location = DeviceEventEmitter.addListener('onLocationStateChanged', ({ enabled }: {enabled: boolean}) => {
    if (!wanted) return;
    if (!enabled) {
      useAvailability.setState({ enabled: false, status: LOCATION_OFF });
      void ensureLocationEnabled().catch(() => {});
      // Do not tear down an established voice call when Location changes.
      void discovery.stopDiscovery().catch(() => {});
    } else if (calls.getState() === 'idle') void resumeAvailability(false);
  });
  const recovered = DeviceEventEmitter.addListener('onDirectCleanupRecovered', () => {
    if (wanted && calls.getState() === 'idle') void resumeAvailability(false);
  });
  const paused = DeviceEventEmitter.addListener('onAvailabilityPaused', () => { markPaused(); });
  const state = calls.subscribe(next => {
    if (next === 'idle' && wanted) void resumeAvailability(false);
    else if (next !== 'idle') void discovery.stopDiscovery();
  });
  const contacts = useAppStore.subscribe((next, previous) => {
    if (next.myUUID && next.myDeviceName && (next.friends !== previous.friends || next.myDeviceName !== previous.myDeviceName || next.settings.ringtoneEnabled !== previous.settings.ringtoneEnabled))
      void Nearby.configureAvailability(next.myUUID, next.myDeviceName, next.friends.map(f => ({uuid:f.uuid,name:f.name})), next.settings.ringtoneEnabled).catch(() => {});
    if (next.friends !== previous.friends && wanted && calls.getState() === 'idle') void resumeAvailability(false);
  });
  // Runs in background too: the process, not the screen, is what the scan needs.
  const health = setInterval(() => { void availabilityHealthCheck(); }, AVAILABILITY_HEALTH_INTERVAL_MS);
  const unref = (health as unknown as {unref?: () => void}).unref;
  if (typeof unref === 'function') unref.call(health);
  return () => {
    app.remove(); location.remove(); recovered.remove(); paused.remove(); state(); contacts();
    clearInterval(health);
  };
}
