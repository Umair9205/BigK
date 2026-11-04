import { router, Stack } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Alert, AppState } from 'react-native';
import Nearby from '../modules/Nearby';
import { signalingManager } from '../services/CallSignaling';
import { useAppStore } from '../store/appStore';
import { callStateManager } from '../services/CallStateManager';
import { resumeAvailability, startAvailabilityLifecycle, callNotifications } from '../services/BackgroundAvailability';
import { ensureBatteryExemption } from '../services/BatteryExemption';

export default function RootLayout() {
  const seenCalls = useRef(new Set<string>());
  const loadData = useAppStore((s) => s.loadData);
  const myUUID = useAppStore((s) => s.myUUID);
  const myDeviceName = useAppStore((s) => s.myDeviceName);
  const isSetupDone = useAppStore((s) => s.isSetupDone);
  const isFriendByUUID = useAppStore((s) => s.isFriendByUUID);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Initialize signaling manager with device UUID
  useEffect(() => {
    if (myUUID) {
      signalingManager.setMyUUID(myUUID);
      console.log('[Layout] Signaling manager initialized with UUID:', myUUID);
    }
  }, [myUUID]);

  // Start Nearby advertising when device identity is ready
  useEffect(() => {
    if (!myUUID || !myDeviceName) return;

    const stop = startAvailabilityLifecycle();
    if (useAppStore.getState().settings.scanningEnabled) void resumeAvailability(true);
    // One-time background exemption; round 18 froze the running service 5 s
    // after Home without it. Skips itself when already granted or asked.
    void ensureBatteryExemption();
    return stop;
  }, [myUUID, myDeviceName]);

  // Global incoming call listener
  useEffect(() => {
    const handler = ({ signal }: any) => {
      // Native owns ringing while backgrounded; navigate only when a screen exists.
      if (AppState.currentState !== 'active') return;
      if (!useAppStore.getState().settings.scanningEnabled || signal.to !== myUUID) return;
      // Ignore own call-request (Nearby broadcasts back to sender)
      if (signal.from === myUUID) {
        console.log('[Layout] Ignoring own call-request');
        return;
      }

      // Check the saved contact again at the UI boundary. Native background
      // handling applies the same filter; UUIDs are not cryptographic identity.
      if (!signal.from || !isFriendByUUID(signal.from)) {
        console.warn('[Layout] 🚫 Rejecting call-request from non-friend:', signal.from);
        if (signal.from && signal.sessionId) {
          signalingManager.sendCallReject(signal.from, signal.sessionId).catch((e) =>
            console.error('[Layout] Failed to send reject to non-friend:', e)
          );
        }
        return;
      }

      // Get connectionId from signalingManager (auto-registered when signal arrived)
      if (signal.data?.mediaEngine !== 'webrtc-direct-v2') {
        void signalingManager.sendCallReject(signal.from, signal.sessionId);
        Alert.alert('Update required', 'Install the same new APK on both phones for WebRTC audio.');
        return;
      }
      const connectionId = signalingManager.getActiveConnection(signal.from);

      if (!connectionId) {
        console.error('[Layout] ❌ No connection found for peer:', signal.from);
        return;
      }

      if (!signal.sessionId || seenCalls.current.has(signal.sessionId)) return;
      if (callStateManager.getState() !== 'idle') {
        void signalingManager.sendCallReject(signal.from, signal.sessionId);
        return;
      }
      seenCalls.current.add(signal.sessionId);
      if (seenCalls.current.size > 64) {
        seenCalls.current.delete(seenCalls.current.values().next().value!);
      }
      // Reserve this session synchronously before navigation/effect initialization.
      callStateManager.initSession(signal.sessionId, signal.from, connectionId);
      const savedName = useAppStore.getState().getFriendByUUID(signal.from)?.name || 'Contact';
      void callNotifications.showIncoming(signal.sessionId, savedName, useAppStore.getState().settings.ringtoneEnabled)
        .catch((e: Error) => console.warn('[Incoming notification]', e.message));

      console.log('[Layout] 📞 Incoming call from:', signal.from, 'connectionId:', connectionId);
      router.push({
        pathname: '/incoming-call',
        params: {
          callerName: savedName,
          callerUUID: signal.from ?? '',
          sessionId: signal.sessionId ?? '',
          connectionId: connectionId ?? '',
        },
      });
    };
    signalingManager.on('call-request', handler);
    // Calls can arrive while no React screen exists. Native keeps only the current
    // live invitation; canceled/expired calls are removed before we read it.
    let live = true;
    const restoreIncoming = async () => {
      if (!myUUID || AppState.currentState !== 'active') return;
      try {
        const pending = await Nearby.pendingIncoming();
        if (!live || !pending) return;
        const signal = JSON.parse(pending.data);
        signalingManager.setActiveConnection(signal.from, pending.connectionId);
        handler({ signal });
      } catch (error) { console.warn('[Incoming restore]', String(error)); }
    };
    void restoreIncoming();
    const appState = AppState.addEventListener('change', state => { if (state === 'active') void restoreIncoming(); });
    return () => {
      live = false; appState.remove();
      signalingManager.off('call-request', handler);
    };
  }, [myUUID, isFriendByUUID]);

  // Redirect to setup after loadData completes on first launch
  useEffect(() => {
    if (isSetupDone === false && myUUID === null) {
      const t = setTimeout(() => {
        if (!useAppStore.getState().isSetupDone) {
          router.replace('/setup');
        }
      }, 500);
      return () => clearTimeout(t);
    }
  }, [isSetupDone, myUUID]);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="setup" />
      <Stack.Screen name="discover" />
      <Stack.Screen name="friends" />
      <Stack.Screen name="history" />
      <Stack.Screen name="settings" />
      <Stack.Screen name="call" options={{ gestureEnabled: false }} />
      <Stack.Screen name="incoming-call" options={{ gestureEnabled: false }} />
      <Stack.Screen name="qr-code" />
      <Stack.Screen name="qr-scanner" />
    </Stack>
  );
}
