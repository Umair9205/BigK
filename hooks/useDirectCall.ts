/**
 * useDirectCall — call lifecycle for the Nearby-free Wi-Fi Direct path.
 *
 * The caller has already dialled (placeDirectCall) and the callee's native
 * listener has already accepted an authenticated control socket. This hook
 * waits for the peer's call-accept, runs WebRTC over that same socket, and
 * owns teardown. It deliberately does not touch CallSignaling or Nearby.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, BackHandler, DeviceEventEmitter, PermissionsAndroid, Platform, Vibration } from 'react-native';
import { router } from 'expo-router';
import audio from '../services/DirectCallAudio';
import wifi from '../modules/DirectWifi';
import { callNotifications } from '../services/BackgroundAvailability';
import { accept as acceptSignal, reject as rejectSignal, end as endSignal, clearPendingIncoming } from '../services/DirectCallFlow';
import { callStateManager as calls } from '../services/CallStateManager';
import { useAppStore } from '../store/appStore';

type State = 'initiating' | 'ringing' | 'connecting' | 'active' | 'ended';
type Outcome = 'completed' | 'failed' | 'missed' | 'rejected';

const CALL_LEVEL = new Set(['call-request', 'call-accept', 'call-reject', 'call-end']);

export function useDirectCall(role: 'caller' | 'callee', peer: string, name: string, sessionId: string, localIp: string) {
  const [state, setState] = useState<State>('ringing');
  const [status, setStatus] = useState(role === 'caller' ? 'Calling…' : '');
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
  const buffered = useRef<string[]>([]);
  const audioReady = useRef(false);

  const cleanup = useCallback(async (outcome: Outcome, navigate = true) => {
    const c = control.current;
    if (c.ended) return;
    c.ended = true;
    if (navigate) { setState('ended'); setStatus('Closing connection…'); }
    callNotifications.dismissIncoming(sessionId);
    clearPendingIncoming(sessionId);
    // Await the native teardown so setShowWhenLocked(false) has been applied
    // before router.back(), otherwise Home can paint over the lockscreen.
    await callNotifications.stopCallService().catch(() => {});
    clearInterval(c.timer); clearTimeout(c.timeout); Vibration.cancel();
    subscriptions.current.forEach(s => s.remove()); subscriptions.current = [];
    buffered.current = [];
    const stopped = audio.stopStreaming();
    useAppStore.getState().addCallRecord({
      friendUUID: peer, friendName: name || '', direction: role === 'caller' ? 'outgoing' : 'incoming',
      outcome, startedAt: c.startedAt, duration: c.seconds,
    });
    void stopped.finally(() => {
      if (calls.getSessionId() === sessionId) calls.reset();
      if (navigate) router.back();
    });
  }, [name, peer, role, sessionId]);

  const cleanupRef = useRef(cleanup);
  cleanupRef.current = cleanup;

  const finish = useCallback(async (outcome: Outcome, message = '') => {
    const c = control.current;
    if (c.ended || c.closing) return;
    c.closing = true;
    setState('ended'); setStatus(message);
    if (outcome === 'failed' && message) Alert.alert('Call ended', message);
    audio.setMuted(true);
    await audio.end().catch(() => {});
    await endSignal(sessionId, peer).catch(() => {});
    await audio.stopStreaming().catch(() => {});
    void cleanup(outcome);
  }, [cleanup, peer, sessionId]);

  const finishRef = useRef(finish);
  finishRef.current = finish;

  const startAudio = useCallback(async () => {
    const c = control.current;
    if (c.ended || c.closing || c.startingAudio || c.active) return;
    c.startingAudio = true;
    clearTimeout(c.timeout);
    c.timeout = setTimeout(() => { void finishRef.current('failed', 'Direct call setup timed out'); }, 90000);
    Vibration.cancel(); setState('connecting'); setStatus('Starting audio…');
    try {
      if (Platform.OS === 'android' && await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)
          !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Microphone permission required');
      if (c.ended || c.closing) return;
      const started = audio.start(role, peer, sessionId, {
        onError: error => {
          if (error === 'Peer ended the call') void cleanupRef.current(c.active ? 'completed' : 'missed');
          else void finishRef.current('failed', error);
        },
        onStatus: message => { if (!c.ended && !c.closing) setStatus(message); },
      }, undefined, name, { localIp });
      // The socket has been open since before the user answered, so replay any
      // WebRTC setup that arrived while this run was still subscribing.
      setTimeout(() => {
        if (c.ended || c.closing) return;
        audioReady.current = true;
        buffered.current.splice(0).forEach(raw => audio.inject(sessionId, raw));
      }, 0);
      await started;
      if (c.ended || c.closing) return;
      c.active = true; c.startedAt = new Date();
      clearTimeout(c.timeout);
      calls.setState('streaming');
      setState('active'); setStatus('');
      c.timer = setInterval(() => { c.seconds++; setDuration(c.seconds); }, 1000);
      void useAppStore.getState().saveCallSession({
        sessionId, peerUUID: peer, peerConnectionId: sessionId, startTime: Date.now(),
        state: 'streaming', codec: 'opus',
      }).catch(error => console.warn('[DirectCall] Could not save session:', error));
    } catch (error: any) {
      if (!c.ended) {
        console.error('[DirectCall] Audio startup failed:', error?.message);
        void finishRef.current('failed', error?.message || 'Audio startup failed');
      }
    }
  }, [localIp, name, peer, role, sessionId]);

  const accepting = useRef(false);
  const acceptCall = useCallback(async () => {
    if (accepting.current || control.current.ended || control.current.closing) return;
    accepting.current = true; Vibration.cancel(); setState('connecting');
    callNotifications.dismissIncoming(sessionId);
    clearTimeout(control.current.timeout);
    try {
      if (AppState.currentState !== 'active') throw new Error('Open the app to answer this call');
      if (Platform.OS === 'android' && await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)
          !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Microphone permission required');
    } catch (e: any) { void finishRef.current('failed', e.message); return; }
    const service = callNotifications.startCallService(name).then(() => null, (e: any) => e);
    const accepted = await acceptSignal(sessionId, peer).catch(() => false);
    const serviceError = await service;
    if (control.current.ended || control.current.closing) { await callNotifications.stopCallService().catch(() => {}); return; }
    if (!accepted) { void finishRef.current('failed', 'Could not accept call'); return; }
    if (serviceError) { void finishRef.current('failed', serviceError?.message || 'Could not start the call service'); return; }
    await startAudio();
  }, [name, peer, sessionId, startAudio]);

  useEffect(() => {
    const current = control.current;
    clearTimeout(unmountTimer.current);
    const init = setTimeout(() => {
      const c = control.current;
      if (c.started || c.ended) return;
      c.started = true;
      if (!peer || !sessionId || !localIp) { void cleanupRef.current('failed'); return; }
      calls.initSession(sessionId, peer, sessionId);
      const handlers = new Map<string, ((msg: any) => void)[]>();
      const listen = (type: string, fn: (msg: any) => void) => {
        const list = handlers.get(type) || [];
        list.push(fn);
        handlers.set(type, list);
      };
      subscriptions.current.push(wifi.onSignal(e => {
        if (c.ended || c.closing || e.sessionId !== sessionId) return;
        try {
          const msg = JSON.parse(e.data);
          if (msg.sessionId !== sessionId) return;
          if (!CALL_LEVEL.has(msg.type)) {
            // The native socket is already open; hold WebRTC setup until the
            // audio run subscribes, then replay it from startAudio.
            if (!audioReady.current && buffered.current.length < 128) buffered.current.push(e.data);
            return;
          }
          if (msg.from !== peer) return;
          (handlers.get(msg.type) || []).forEach(fn => fn(msg));
        } catch { /* malformed peer payload */ }
      }));
      listen('call-accept', () => {
        if (role !== 'caller' || c.active || c.startingAudio) return;
        clearTimeout(c.timeout);
        c.timeout = setTimeout(() => { void finishRef.current('failed', 'Direct call setup timed out'); }, 90000);
        setState('connecting'); setStatus('Peer accepted…');
        void startAudio();
      });
      listen('call-reject', () => { void cleanupRef.current('rejected'); });
      listen('call-end', () => { void cleanupRef.current(c.active ? 'completed' : 'failed'); });
      subscriptions.current.push(wifi.onError(e => {
        if (e.sessionId === sessionId && !c.ended) void finishRef.current('failed', e.error);
      }));
      c.timeout = setTimeout(() => {
        if (role === 'caller') void finishRef.current('failed', 'No answer');
        else void rejectSignal(sessionId, peer).catch(() => {}).then(() => cleanupRef.current('missed'));
      }, 45000);
      if (role === 'caller') {
        void (async () => {
          try {
            if (Platform.OS === 'android' && await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)
                !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Microphone permission required');
            if (c.ended || c.closing) return;
            await callNotifications.startCallService(name);
            if (c.ended || c.closing) { await callNotifications.stopCallService().catch(() => {}); return; }
            setState('ringing');
          } catch (e: any) { if (!c.ended) void finishRef.current('failed', e?.message); }
        })();
      } else {
        setState('ringing');
      }
    }, 0);
    return () => {
      clearTimeout(init);
      unmountTimer.current = setTimeout(() => {
        if (!current.ended) {
          current.closing = true;
          void audio.end().finally(() => {
            if (role === 'caller') void endSignal(sessionId, peer).catch(() => {});
            void cleanupRef.current(current.active ? 'completed' : 'missed', false);
          });
        }
      }, 0);
    };
  }, [localIp, name, peer, role, sessionId, startAudio]);

  const rejectCall = async () => {
    if (control.current.ended || control.current.closing) return;
    control.current.closing = true;
    callNotifications.dismissIncoming(sessionId);
    void rejectSignal(sessionId, peer);
    setTimeout(() => { void cleanupRef.current('rejected'); }, 300);
  };

  useEffect(() => {
    const act = async () => {
      if (role !== 'callee' || AppState.currentState !== 'active' || control.current.ended || accepting.current) return;
      const action = await callNotifications.consumeCallAction(sessionId);
      if (action === 'answer') void acceptCall();
      if (action === 'decline') void rejectCall();
    };
    const app = AppState.addEventListener('change', s => { if (s === 'active') void act(); });
    const notification = DeviceEventEmitter.addListener('onCallNotificationAction', act);
    const initial = setTimeout(() => void act(), 0);
    return () => { clearTimeout(initial); app.remove(); notification.remove(); };
  }, [acceptCall, role, sessionId]);

  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => { BackHandler.exitApp(); return true; });
    return () => back.remove();
  }, []);

  return {
    state, status, duration, muted, speaker, acceptCall, rejectCall,
    hangUp: () => finishRef.current(control.current.active ? 'completed' : 'failed'),
    toggleMute: () => { setMuted(v => { audio.setMuted(!v); return !v; }); },
    toggleSpeaker: () => { setSpeaker(v => { audio.setSpeaker(!v); return !v; }); },
  };
}
