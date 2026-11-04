import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, BackHandler, DeviceEventEmitter, PermissionsAndroid, Platform, Vibration } from 'react-native';
import { callNotifications } from '../services/BackgroundAvailability';
import { router } from 'expo-router';
import Nearby from '../modules/Nearby';
import audio from '../services/DirectCallAudio';
import wifi, { DirectCredentials } from '../modules/DirectWifi';
import { signalingManager as signals } from '../services/CallSignaling';
import { callStateManager as calls } from '../services/CallStateManager';
import { useAppStore } from '../store/appStore';

type State = 'initiating' | 'ringing' | 'connecting' | 'active' | 'ended';
type Outcome = 'completed' | 'failed' | 'missed' | 'rejected';

/** One owner for one call. All asynchronous continuations check the same ended flag. */
export function useNearbyCall(role: 'caller' | 'callee', peer: string, name: string, endpoint: string, incomingId?: string) {
  const [id] = useState(() => incomingId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const [state, setState] = useState<State>(role === 'caller' ? 'initiating' : 'ringing');
  const [status, setStatus] = useState('');
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(false);
  const control = useRef({
    ended: false, closing: false, started: false, startingAudio: false, active: false, seconds: 0,
    startedAt: new Date(), timer: undefined as ReturnType<typeof setInterval> | undefined,
    timeout: undefined as ReturnType<typeof setTimeout> | undefined,
  });
  const unmountTimer = useRef<ReturnType<typeof setTimeout>>();
  const subscriptions = useRef<{ remove(): void }[]>([]);

  const cleanup = useCallback((outcome: Outcome, navigate = true) => {
    const c = control.current;
    if (c.ended) return;
    c.ended = true;
    if (navigate) { setState('ended'); setStatus('Closing connection…'); }
    callNotifications.dismissIncoming(id);
    void callNotifications.stopCallService().catch(() => {});
    clearInterval(c.timer); clearTimeout(c.timeout); Vibration.cancel();
    subscriptions.current.forEach(s => s.remove()); subscriptions.current = [];
    const stopped = audio.stopStreaming();
    useAppStore.getState().addCallRecord({
      friendUUID: peer, friendName: name || '', direction: role === 'caller' ? 'outgoing' : 'incoming',
      outcome, startedAt: c.startedAt, duration: c.seconds,
    });
    // Keep the call state busy until native teardown has completed. Reset then
    // notifies availability to restart discovery without racing the old group.
    void stopped.finally(() => {
      if (calls.getSessionId() === id) calls.reset();
      if (navigate) router.back();
    });
  }, [endpoint, id, name, peer, role]);

  const finish = useCallback(async (outcome: Outcome, message = '') => {
    const c = control.current;
    if (c.ended || c.closing) return;
    c.closing = true;
    setState('ended'); setStatus(message);
    if (outcome === 'failed' && message) Alert.alert('Call ended', message);
    audio.setMuted(true);
    await audio.end();
    audio.stopStreaming();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    // After handoff the Nearby endpoint is deliberately gone. Direct control
    // above owns hangup; do not send a second end over the disconnected bootstrap.
    if (signals.getActiveConnection(peer)) await Promise.race([
      signals.sendCallEnd(peer, id),
      new Promise<void>(resolve => { deadline = setTimeout(resolve, 800); }),
    ]);
    clearTimeout(deadline);
    cleanup(outcome);
  }, [cleanup, id, peer]);

  const startAudio = useCallback(async (credentials?: DirectCredentials) => {
    const c = control.current;
    if (c.ended || c.closing || c.startingAudio || c.active) return;
    c.startingAudio = true;
    clearTimeout(c.timeout);
    // Outlives the audio service backstop (90s) so its specific failure detail
    // surfaces first: the Wi-Fi-off chain needs a 12s panel wait, a 12s direct
    // address read and a 30s native watchdog before media starts.
    c.timeout = setTimeout(() => { void finish('failed', 'Direct call setup timed out'); }, 90000);
    Vibration.cancel(); setState('connecting'); setStatus('Starting audio…');
    try {
      if (Platform.OS === 'android' && await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)
          !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Microphone permission required');
      if (c.ended || c.closing) return;
      // Foreground microphone eligibility was established by the caller/answer gesture.
      await audio.start(role, peer, id, {
        onError: error => {
          if (error === 'Peer ended the call') cleanup(c.active ? 'completed' : 'missed');
          else void finish('failed', error);
        },
        onStatus: message => { if (!c.ended && !c.closing) setStatus(message); },
      }, credentials, name);
      if (c.ended || c.closing) return;
      c.active = true; c.startedAt = new Date();
      clearTimeout(c.timeout);
      calls.setState('streaming');
      setState('active'); setStatus('');
      c.timer = setInterval(() => { c.seconds++; setDuration(c.seconds); }, 1000);
      void useAppStore.getState().saveCallSession({
        sessionId: id, peerUUID: peer, peerConnectionId: endpoint, startTime: Date.now(),
        state: 'streaming', codec: 'opus',
      }).catch(error => console.warn('[Call] Could not save session:', error));
    } catch (error: any) {
      if (!c.ended) {
        console.error('[Call] Audio startup failed:', error?.message);
        void finish('failed', error?.message || 'Audio startup failed');
      }
    }
  }, [cleanup, endpoint, finish, id, name, peer, role]);

  const accepting = useRef(false);
  const acceptCall = useCallback(async () => {
    if (accepting.current || control.current.ended || control.current.closing) return;
    accepting.current = true; Vibration.cancel(); setState('connecting');
    callNotifications.dismissIncoming(id);
    try {
      if (AppState.currentState !== 'active') throw new Error('Open the app to answer this call');
      if (Platform.OS === 'android' && await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)
          !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Microphone permission required');
    } catch (e: any) { void finish('failed', e.message); return; }
    // The accept signal starts the peer's direct setup. Run the foreground
    // service start beside it instead of making the peer wait for ours.
    const service = callNotifications.startCallService(name).then(() => null, (e: any) => e);
    const accepted = await signals.sendCallAccept(peer, id, useAppStore.getState().myDeviceName || 'Unknown').catch(() => false);
    const serviceError = await service;
    if (control.current.ended || control.current.closing) { await callNotifications.stopCallService().catch(() => {}); return; }
    if (!accepted) { void finish('failed', 'Could not accept call'); return; }
    if (serviceError) { void finish('failed', serviceError?.message || 'Could not start the call service'); return; }
    if (!control.current.ended) await startAudio();
  }, [finish, id, name, peer, startAudio]);

  useEffect(() => {
    const current = control.current;
    clearTimeout(unmountTimer.current);
    // Deferring initialization avoids duplicate startup during React Strict Mode effect replay.
    const init = setTimeout(() => {
      const c = control.current;
      if (c.started || c.ended) return;
      c.started = true;
      if (!peer || !endpoint || (role === 'callee' && !incomingId)) { cleanup('failed'); return; }
      calls.initSession(id, peer, endpoint);
      signals.setActiveConnection(peer, endpoint);
      const listen = (event: string, fn: (signal: any) => void) => {
        const handler = ({ signal, connectionId }: any) => {
          if (!c.ended && !c.closing && signal.sessionId === id && signal.from === peer && connectionId === endpoint) fn(signal);
        };
        signals.on(event, handler);
        subscriptions.current.push({ remove: () => signals.off(event, handler) });
      };
      listen('call-end', () => cleanup(c.active ? 'completed' : 'failed'));
      listen('call-reject', () => cleanup('rejected'));
      subscriptions.current.push(Nearby.onConnectionClosed(e => {
        if (e.connectionId === endpoint && !audio.isStartingOrActive(id)) cleanup(c.active ? 'failed' : 'missed');
      }));
      c.timeout = setTimeout(() => { void finish('failed', 'Call setup timed out'); }, 45000);
      if (role === 'caller') {
        listen('call-accept', signal => {
          if (signal.data?.mediaEngine !== 'webrtc-direct-v2') {
            void finish('failed', 'Install the same new APK on both phones'); return;
          }
          if (!c.active && !c.startingAudio) {
            clearTimeout(c.timeout);
            // Post-accept setup, same composed budget as startAudio's.
            c.timeout = setTimeout(() => { void finish('failed', 'Direct call setup timed out'); }, 90000);
            setState('connecting'); setStatus('Peer accepted…');
          }
        });
        listen('direct-config', signal => {
          if (signal.data?.mediaEngine !== 'webrtc-direct-v2'
              || !signal.data?.direct?.peerP2pAddress || !signal.data?.direct?.token) {
            void finish('failed', 'Install the same new APK on both phones'); return;
          }
          void startAudio(signal.data.direct);
        });
        void (async () => {
          try {
            if (Platform.OS === 'android' && await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)
                !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Microphone permission required');
            if (c.ended || c.closing) return;
            await callNotifications.startCallService(name);
            if (c.ended || c.closing) { await callNotifications.stopCallService(); return; }
            setState('ringing');
            // Discovery gets the whole ring to surface the peer: it took 1.4s on
            // one phone and 3.9s on the other, and one session missed the peer
            // entirely inside 6.4s. Never blocks, never turns Wi-Fi on here.
            void wifi.warmUpPeerDiscovery();
            if (!(await signals.sendCallRequest(peer, id, useAppStore.getState().myDeviceName || 'Unknown')))
              throw new Error('Call request failed');
          } catch (e: any) { if (!c.ended) void finish('failed', e?.message); }
        })();
      } else {
        // Explicit answer is required; stored legacy auto-answer preferences are ignored.
        // Ringing is owned by Android's notification channel, not a repeating JS vibration.
        // The callee needs the caller's address just as much as the caller needs
        // the callee's, and this is where its discovery time is free.
        void wifi.warmUpPeerDiscovery();
      }
    }, 0);
    return () => {
      clearTimeout(init);
      unmountTimer.current = setTimeout(() => {
        if (!current.ended) {
          current.closing = true;
          void audio.end().finally(() => {
            if (signals.getActiveConnection(peer)) void signals.sendCallEnd(peer, id);
            cleanup(current.active ? 'completed' : 'missed', false);
          });
        }
      }, 0);
    };
  }, [acceptCall, cleanup, endpoint, finish, id, incomingId, peer, role, startAudio]);

  const rejectCall = async () => {
    if (control.current.ended || control.current.closing) return;
    control.current.closing = true;
    callNotifications.dismissIncoming(id);
    void signals.sendCallReject(peer, id);
    // Let the control payload enter Nearby before releasing the endpoint.
    setTimeout(() => cleanup('rejected'), 300);
  };
  useEffect(() => {
    const act = async () => {
      if (role !== 'callee' || AppState.currentState !== 'active' || control.current.ended || accepting.current) return;
      const action = await callNotifications.consumeCallAction(id);
      if (action === 'answer') void acceptCall();
      if (action === 'decline') void rejectCall();
    };
    const app = AppState.addEventListener('change', s => { if (s === 'active') void act(); });
    const notification = DeviceEventEmitter.addListener('onCallNotificationAction', act);
    const initial = setTimeout(() => void act(), 0);
    return () => { clearTimeout(initial); app.remove(); notification.remove(); };
  }, [acceptCall, id, role]);
  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      BackHandler.exitApp(); return true;
    });
    return () => back.remove();
  }, []);
  return {
    state, status, duration, muted, speaker, acceptCall, rejectCall,
    hangUp: () => finish(control.current.active ? 'completed' : 'failed'),
    toggleMute: () => { setMuted(v => { audio.setMuted(!v); return !v; }); },
    toggleSpeaker: () => { setSpeaker(v => { audio.setSpeaker(!v); return !v; }); },
  };
}
