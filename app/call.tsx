import { useLocalSearchParams } from 'expo-router';
import VoiceCallScreen from '../components/VoiceCallScreen';
export default function CallScreen() {
  const p = useLocalSearchParams<{friendUUID:string;friendName:string;connectionId:string}>();
  return <VoiceCallScreen role="caller" peer={p.friendUUID} name={p.friendName} endpoint={p.connectionId}/>;
}
