import { useLocalSearchParams } from 'expo-router';
import VoiceCallScreen, { DirectCallScreen } from '../components/VoiceCallScreen';
export default function CallScreen() {
  const p = useLocalSearchParams<{friendUUID:string;friendName:string;connectionId:string;sessionId:string;localIp:string}>();
  if (p.sessionId && p.localIp) {
    return <DirectCallScreen role="caller" peer={p.friendUUID} name={p.friendName} sessionId={p.sessionId} localIp={p.localIp}/>;
  }
  return <VoiceCallScreen role="caller" peer={p.friendUUID} name={p.friendName} endpoint={p.connectionId}/>;
}
