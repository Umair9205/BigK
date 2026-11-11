import { Alert, AppState, PermissionsAndroid, Platform } from 'react-native';
import Nearby from '../modules/Nearby';
import { useAppStore } from '../store/appStore';

export function nearbyPermissions(): string[] {
  const permissions: string[] = [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  if (Number(Platform.Version) >= 31) permissions.push('android.permission.BLUETOOTH_SCAN',
    'android.permission.BLUETOOTH_CONNECT', 'android.permission.BLUETOOTH_ADVERTISE');
  if (Number(Platform.Version) >= 33) permissions.push('android.permission.NEARBY_WIFI_DEVICES');
  return permissions;
}
export async function requestNearbyPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const result = await PermissionsAndroid.requestMultiple(nearbyPermissions() as any);
  return Object.values(result).every(value => value === PermissionsAndroid.RESULTS.GRANTED);
}
let pending: Promise<void> | null = null;
let locationPromptOpen = false;
export const LOCATION_OFF = 'Location is off · turn it on to find nearby contacts and receive new local calls.';
export async function ensureLocationEnabled(prompt = true): Promise<void> {
  if (Platform.OS !== 'android' || await Nearby.isLocationEnabled()) return;
  if (prompt && AppState.currentState === 'active' && !locationPromptOpen) {
    locationPromptOpen = true;
    const dismissed = () => { locationPromptOpen = false; };
    Alert.alert('Turn on Location for local calling',
      'Android uses this setting for nearby-device discovery. With Location off, finding contacts and setting up new calls may fail. BigK is not requesting GPS coordinates. The app will stay open.', [
        { text: 'Not now', style: 'cancel', onPress: dismissed },
        { text: 'Open settings', onPress: () => {
          dismissed();
          void Nearby.openLocationSettings().catch(() => Alert.alert('Open Location settings', 'Turn on Location from your phone’s Quick Settings or Android Settings.'));
        } },
      ], { onDismiss: dismissed });
  }
  throw new Error(LOCATION_OFF);
}
export function ensureNearbyAvailable(request = true): Promise<void> {
  // Nearby is unplugged (step 4): the Wi-Fi Direct P2P path is the only live
  // call bootstrap, so skip the Bluetooth permission group, advertising and
  // discovery. Location stays required (Wi-Fi Direct peer discovery uses it).
  if ((Nearby as any).NEARBY_ENABLED === false) {
    void ensureLocationEnabled().catch(() => {});
    return Promise.resolve();
  }
  if (pending) return pending;
  pending = (async () => {
    const { myUUID, myDeviceName } = useAppStore.getState();
    if (!myUUID || !myDeviceName) throw new Error('Complete setup first');
    if (Platform.OS === 'android') {
      const granted = request ? await requestNearbyPermissions() :
        (await Promise.all(nearbyPermissions().map(p => PermissionsAndroid.check(p as any)))).every(Boolean);
      if (!granted) throw new Error('Nearby permissions are required. Enable local calling and allow Bluetooth, Wi-Fi and Location access.');
      await ensureLocationEnabled();
    }
    await Nearby.startAdvertising(myUUID, myDeviceName);
  })().finally(() => { pending = null; });
  return pending;
}
