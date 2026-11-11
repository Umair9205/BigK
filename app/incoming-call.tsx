import { useLocalSearchParams } from 'expo-router';
import VoiceCallScreen, { DirectCallScreen } from '../components/VoiceCallScreen';
export default function IncomingCallScreen() {
  const p = useLocalSearchParams<{callerUUID:string;callerName:string;connectionId:string;sessionId:string;localIp:string}>();
  if (p.sessionId && p.localIp) {
    return <DirectCallScreen role="callee" peer={p.callerUUID} name={p.callerName} sessionId={p.sessionId} localIp={p.localIp}/>;
  }
  return <VoiceCallScreen role="callee" peer={p.callerUUID} name={p.callerName} endpoint={p.connectionId} sessionId={p.sessionId}/>;
}
