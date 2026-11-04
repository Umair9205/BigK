import { useLocalSearchParams } from 'expo-router';
import VoiceCallScreen from '../components/VoiceCallScreen';
export default function IncomingCallScreen() {
  const p = useLocalSearchParams<{callerUUID:string;callerName:string;connectionId:string;sessionId:string}>();
  return <VoiceCallScreen role="callee" peer={p.callerUUID} name={p.callerName} endpoint={p.connectionId} sessionId={p.sessionId}/>;
}
