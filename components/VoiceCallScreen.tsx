import { Ionicons } from '@expo/vector-icons';
import { StatusBar, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNearbyCall } from '../hooks/useNearbyCall';
import { useDirectCall } from '../hooks/useDirectCall';

type CallState = 'initiating' | 'ringing' | 'connecting' | 'active' | 'ended';
type CallControls = {
  state: CallState; status: string; duration: number; muted: boolean; speaker: boolean;
  acceptCall: () => unknown; rejectCall: () => unknown; hangUp: () => unknown;
  toggleMute: () => unknown; toggleSpeaker: () => unknown;
};

function CallView({role, name, call}: {role: 'caller' | 'callee'; name: string; call: CallControls}) {
  const ringing = role === 'callee' && call.state === 'ringing';
  const duration = `${Math.floor(call.duration/60).toString().padStart(2,'0')}:${(call.duration%60).toString().padStart(2,'0')}`;
  const status = call.status || (call.state==='active' ? duration : ringing ? 'Incoming voice call' : call.state==='ringing' ? 'Calling…' : call.state==='connecting' ? 'Connecting audio…' : call.state==='ended' ? 'Call ended' : 'Preparing call…');
  const button = (label:string, icon:React.ComponentProps<typeof Ionicons>['name'], action:()=>unknown, color:string, selected=false) =>
    <View style={s.control}><TouchableOpacity style={[s.button,{backgroundColor:color}]} onPress={action} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{selected}}><Ionicons name={icon} color="white" size={28}/></TouchableOpacity><Text style={s.controlText}>{label}</Text></View>;
  return <SafeAreaView style={s.page}>
    <StatusBar barStyle="light-content" backgroundColor="#112D29"/>
    <View style={s.top}><Text style={s.brand}>BigK</Text><Text style={s.transport}>Direct Wi-Fi voice call</Text></View>
    <View style={s.identity}><View style={s.avatar}><Text style={s.initial}>{(name || '?')[0].toUpperCase()}</Text></View><Text style={s.name}>{name || 'Contact'}</Text><Text accessibilityLiveRegion="polite" style={s.status}>{status}</Text></View>
    <View style={s.bottom}>
      {call.state==='active' && <View style={s.row}>
        {button(call.muted?'Unmute':'Mute',call.muted?'mic-off-outline':'mic-outline',call.toggleMute,call.muted?'#087F69':'#2C4944',call.muted)}
        {button('Speaker',call.speaker?'volume-high':'volume-medium-outline',call.toggleSpeaker,call.speaker?'#087F69':'#2C4944',call.speaker)}
      </View>}
      <View style={s.row}>{ringing ? <>
        {button('Decline','close',call.rejectCall,'#D34C56')}
        {button('Answer','call',call.acceptCall,'#139979')}
      </> : button(call.state==='active'?'End call':'Cancel','call',call.hangUp,'#D34C56')}</View>
      <Text style={s.hint}>{ringing ? 'Your microphone stays off until you answer.' : 'You can leave the app during a call. Tap its notification to return.'}</Text>
    </View>
  </SafeAreaView>;
}

/** Legacy Nearby-bootstrapped call screen, kept for the old route. */
export default function VoiceCallScreen({role, peer, name, endpoint, sessionId}: {
  role:'caller'|'callee';peer:string;name:string;endpoint:string;sessionId?:string;
}) {
  const call = useNearbyCall(role, peer, name, endpoint, sessionId);
  return <CallView role={role} name={name} call={call}/>;
}

/** Nearby-free Wi-Fi Direct call screen: socket already authenticated. */
export function DirectCallScreen({role, peer, name, sessionId, localIp}: {
  role:'caller'|'callee';peer:string;name:string;sessionId:string;localIp:string;
}) {
  const call = useDirectCall(role, peer, name, sessionId, localIp);
  return <CallView role={role} name={name} call={call}/>;
}

const s=StyleSheet.create({page:{flex:1,backgroundColor:'#112D29',justifyContent:'space-between',paddingHorizontal:24},top:{alignItems:'center',paddingTop:24,gap:8},brand:{fontSize:12,letterSpacing:3,color:'#AED2C7',fontWeight:'600'},transport:{fontSize:13,color:'#90B1A7'},identity:{alignItems:'center',gap:20},avatar:{width:112,height:112,borderRadius:56,backgroundColor:'#2C5148',alignItems:'center',justifyContent:'center'},initial:{fontSize:48,color:'#D5F2E7'},name:{fontSize:30,fontWeight:'600',color:'white',textAlign:'center'},status:{fontSize:16,color:'#AED2C7',textAlign:'center'},bottom:{paddingBottom:25,gap:24},row:{flexDirection:'row',justifyContent:'center',gap:55},control:{alignItems:'center',gap:10},button:{width:68,height:68,borderRadius:34,justifyContent:'center',alignItems:'center'},controlText:{color:'#E6F3ED',fontSize:13},hint:{fontSize:12,lineHeight:18,color:'#90B1A7',textAlign:'center'}});
