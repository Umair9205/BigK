import { useEffect, useState } from 'react';
import { Alert, FlatList, Linking, StatusBar, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useAppStore } from '../store/appStore';
import { nearbyDiscoveryService as discovery } from '../services/NearbyDiscoveryService';
import { placeCall } from '../services/OutgoingCall';
import { requireCallNotifications, pauseAvailability, resumeAvailability, useAvailability } from '../services/BackgroundAvailability';
import CallRingtoneSetting from './CallRingtoneSetting';

type Tab = 'Calls' | 'Contacts' | 'Settings';

function relativeTime(value: Date | string | number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(value).toLocaleDateString();
}

export default function CallingHome({ initialTab = 'Calls' }: { initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [search, setSearch] = useState('');
  const [dialing, setDialing] = useState(false);
  const [dialStatus, setDialStatus] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');
  const presentUuids = () => new Set(discovery.getDiscoveredFriends().filter(f => f.discovered).map(f => f.uuid));
  const [nearby, setNearby] = useState(presentUuids);
  const friends = useAppStore(s => s.friends);
  const lastSeenMap = useAppStore(s => s.lastSeen);
  const history = useAppStore(s => s.callHistory);
  const name = useAppStore(s => s.myDeviceName);
  const settings = useAppStore(s => s.settings);
  const availability = useAvailability();
  const openSettings = async (battery: boolean) => {
    try {
      if (battery) await requireCallNotifications('openBatterySettings').openBatterySettings();
      else await Linking.openSettings();
    } catch (error: any) {
      Alert.alert('Settings unavailable', error?.message || 'Open BigK’s app settings manually from Android Settings.');
    }
  };
  useEffect(() => discovery.onFriendDiscovered(friend => {
    // Persist presence (throttled in the store) so "Last seen" survives restarts.
    if (friend.discovered) useAppStore.getState().touchLastSeen(friend.uuid);
    setNearby(presentUuids());
  }), []);
  const call = async (uuid: string, label: string) => {
    if (dialing) return;
    setDialing(true);
    // Warm the radio with visible feedback instead of silently stacking
    // permissions + service start + scanning behind the tap.
    setDialStatus(useAvailability.getState().enabled ? 'Finding contact…' : 'Enabling local calling…');
    try {
      if (!useAvailability.getState().enabled) await resumeAvailability(true, true);
      if (useAvailability.getState().enabled) {
        await placeCall(uuid, label, setDialStatus);
      } else {
        Alert.alert('Local calling is off', useAvailability.getState().status || 'Turn on “Receive local calls” in Settings, then try again.');
      }
    } finally {
      setDialing(false);
      setDialStatus('');
      // A failed outgoing connection stops discovery before a call screen exists.
      if (useAvailability.getState().enabled) void resumeAvailability(false);
    }
  };
  const contactMeta = (uuid: string, lastSeen?: Date) =>
    availability.enabled && nearby.has(uuid) ? 'Nearby now · tap to call'
    : lastSeenMap[uuid] ? `Last seen ${relativeTime(lastSeenMap[uuid])}`
    : lastSeen ? `Last seen ${relativeTime(lastSeen)}`
    : 'Tap to find and call';
  const empty = (title: string, detail: string) => <View style={s.empty}>
    <Ionicons name="call-outline" size={44} color="#79928C" />
    <Text style={s.emptyTitle}>{title}</Text><Text style={s.detail}>{detail}</Text>
    <TouchableOpacity accessibilityRole="button" style={s.primary} onPress={() => router.push('/qr-scanner')}><Text style={s.primaryText}>Add a contact</Text></TouchableOpacity>
  </View>;
  const matches = (value: string) => value.toLowerCase().includes(search.toLowerCase());
  const contactList = [...friends].filter(f => matches(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  return <SafeAreaView style={s.page}>
    <StatusBar barStyle="dark-content" backgroundColor="#F8FAF9" />
    <View style={s.header}><View style={s.info}><Text style={s.brand}>BigK</Text><Text style={s.title}>{tab}</Text></View>
      <TouchableOpacity style={s.iconButton} accessibilityRole="button" accessibilityLabel="Share my contact QR" onPress={() => router.push('/qr-code')}><Ionicons name="qr-code-outline" size={24} color="#087F69" /></TouchableOpacity>
      <TouchableOpacity style={s.iconButton} accessibilityRole="button" accessibilityLabel="Add contact" onPress={() => router.push('/qr-scanner')}><Ionicons name="person-add-outline" size={24} color="#087F69" /></TouchableOpacity>
    </View>
    <TouchableOpacity
      style={s.availability}
      accessibilityRole="button"
      accessibilityLabel={availability.enabled ? 'Local calling status' : 'Enable local calling'}
      disabled={availability.enabled || availability.busy}
      onPress={() => void resumeAvailability(true, true)}
      activeOpacity={0.6}
    >
      <View style={[s.dot, { backgroundColor: dialing || !availability.enabled ? '#B26A23' : '#087F69' }]} />
      <Text accessibilityLiveRegion="polite" style={s.availabilityText}>{dialing ? dialStatus : availability.status}</Text>
      {!availability.enabled && !availability.busy && <Ionicons name="refresh-outline" size={15} color="#087F69" />}
    </TouchableOpacity>
    {tab !== 'Settings' && <View style={s.search}><Ionicons name="search-outline" size={20} color="#657C76" /><TextInput value={search} onChangeText={setSearch} placeholder="Search contacts" placeholderTextColor="#657C76" accessibilityLabel="Search contacts" style={s.input} /></View>}
    {tab === 'Contacts' && <FlatList data={contactList} keyExtractor={f => f.uuid} contentContainerStyle={s.list}
      ListEmptyComponent={empty(search ? 'No matching contacts' : 'Your people, one tap away', 'Scan each other’s QR code to add a contact. Nearby discovery runs automatically.')}
      renderItem={({ item }) => <TouchableOpacity disabled={dialing} accessibilityRole="button" accessibilityLabel={`Call ${item.name}`} style={s.row} onPress={() => void call(item.uuid, item.name)}
        onLongPress={() => Alert.alert(`Remove ${item.name}?`, 'This removes the contact from this phone.', [{ text: 'Cancel' }, { text: 'Remove', style: 'destructive', onPress: () => void useAppStore.getState().removeFriend(item.uuid) }])}>
        <View style={s.avatar}><Text style={s.initial}>{item.name[0]?.toUpperCase()}</Text></View><View style={s.info}><Text style={s.name}>{item.name}</Text><Text style={s.meta}>{contactMeta(item.uuid, item.lastSeen)}</Text></View><Ionicons name="call-outline" size={23} color="#087F69" />
      </TouchableOpacity>} />}
    {tab === 'Calls' && <FlatList data={[...history].filter(r => matches(r.friendName)).sort((a,b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())} keyExtractor={r => r.id} contentContainerStyle={s.list}
      ListEmptyComponent={empty(search ? 'No matching calls' : 'No calls yet', 'Choose a saved contact to make your first local voice call. No internet is needed for direct calls.')}
      renderItem={({ item }) => <TouchableOpacity style={s.row} disabled={dialing} accessibilityRole="button" accessibilityLabel={`Call ${item.friendName}`} onPress={() => {
        if (!friends.some(f => f.uuid === item.friendUUID)) { Alert.alert('Contact removed', 'Add this contact again before calling.'); return; }
        void call(item.friendUUID, item.friendName);
      }} onLongPress={() => Alert.alert('Delete call record?', '', [{text:'Cancel'}, {text:'Delete',style:'destructive',onPress:() => void useAppStore.getState().deleteCallRecord(item.id)}])}>
        <View style={s.avatar}><Text style={s.initial}>{item.friendName[0]?.toUpperCase()}</Text></View><View style={s.info}><Text style={[s.name, item.outcome === 'missed' && {color:'#B94343'}]}>{item.friendName}</Text><Text style={s.meta}>{item.direction === 'incoming' ? 'Incoming' : 'Outgoing'} · {item.outcome} · {new Date(item.startedAt).toLocaleDateString()}</Text></View><Ionicons name="call-outline" size={23} color="#087F69" />
      </TouchableOpacity>} />}
    {tab === 'Settings' && <FlatList data={['availability','ringtone','ringtoneSound','battery','permissions','qr','clear']} keyExtractor={x=>x} contentContainerStyle={s.list}
      ListHeaderComponent={<View><TouchableOpacity style={s.profile} accessibilityRole="button" accessibilityLabel="Edit display name" onPress={() => {setDraftName(name || '');setEditingName(true);}}><View style={s.avatar}><Text style={s.initial}>{name?.[0]?.toUpperCase()}</Text></View><View><Text style={s.name}>{name}</Text><Text style={s.meta}>Tap to edit your display name</Text></View></TouchableOpacity>{editingName && <View style={s.row}><TextInput style={[s.input,s.info]} value={draftName} onChangeText={setDraftName} maxLength={60} accessibilityLabel="Display name"/><TouchableOpacity style={s.iconButton} accessibilityRole="button" accessibilityLabel="Save display name" onPress={() => {if(draftName.trim()) void useAppStore.getState().setMyDeviceName(draftName.trim()).then(()=>setEditingName(false));}}><Text style={{color:'#087F69'}}>Save</Text></TouchableOpacity></View>}</View>}
      ListFooterComponent={<Text style={s.footnote}>Keep Bluetooth and Wi-Fi on. Background availability uses battery and depends on Android permissions and power settings. Force-stopping the app makes it unreachable until reopened. Shared-router calling is not included in this build.</Text>}
      renderItem={({item}) => item === 'availability' ? <View style={s.row}><View style={s.info}><Text style={s.name}>Receive local calls</Text><Text style={s.meta}>Automatic nearby availability</Text></View><Switch disabled={availability.busy} value={availability.enabled} onValueChange={on => void (on ? resumeAvailability(true, true) : pauseAvailability())} trackColor={{true:'#087F69',false:'#CAD5D1'}} accessibilityLabel="Receive local calls" /></View>
        : item === 'ringtone' ? <View style={s.row}><View style={s.info}><Text style={s.name}>Incoming call alerts</Text><Text style={s.meta}>Sound and vibration, subject to system settings</Text></View><Switch value={settings.ringtoneEnabled} onValueChange={on => void useAppStore.getState().updateSettings({ringtoneEnabled:on})} accessibilityLabel="Incoming call sound" /></View>
        : item === 'ringtoneSound' ? <CallRingtoneSetting alertsEnabled={settings.ringtoneEnabled} />
        : <TouchableOpacity style={s.row} accessibilityRole="button" onPress={() => item === 'battery' ? void openSettings(true) : item === 'permissions' ? void openSettings(false) : item === 'clear' ? Alert.alert('Clear call history?', 'This removes the call records on this phone.', [{text:'Cancel'}, {text:'Clear',style:'destructive',onPress:()=>void useAppStore.getState().clearCallHistory()}]) : router.push('/qr-code')}><Text style={[s.name,s.info]}>{item === 'battery' ? 'Battery optimization settings' : item === 'permissions' ? 'Permissions and notifications' : item === 'clear' ? 'Clear call history' : 'My contact QR code'}</Text><Ionicons name="chevron-forward" size={20} color="#657C76" /></TouchableOpacity>} />}
    <View style={s.nav}>{(['Calls','Contacts','Settings'] as Tab[]).map(t => <TouchableOpacity key={t} style={s.navItem} accessibilityRole="tab" accessibilityState={{selected:tab===t}} onPress={() => {setTab(t);setSearch('');}}><Ionicons name={t==='Calls'?'call-outline':t==='Contacts'?'people-outline':'settings-outline'} size={23} color={tab===t?'#087F69':'#657C76'} /><Text style={[s.navText,tab===t&&{color:'#087F69',fontWeight:'700'}]}>{t}</Text></TouchableOpacity>)}</View>
  </SafeAreaView>;
}
const s = StyleSheet.create({
  page:{flex:1,backgroundColor:'#F8FAF9'},header:{flexDirection:'row',alignItems:'center',padding:22,gap:10},brand:{fontSize:11,letterSpacing:2,color:'#087F69',fontWeight:'700'},title:{fontSize:32,fontWeight:'700',color:'#172B25',marginTop:5},iconButton:{padding:12},availability:{flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:22,paddingBottom:14},dot:{width:8,height:8,borderRadius:4},availabilityText:{flex:1,fontSize:12,color:'#526B62'},search:{marginHorizontal:18,paddingHorizontal:14,backgroundColor:'#EAF0ED',borderRadius:14,flexDirection:'row',alignItems:'center'},input:{flex:1,padding:12,color:'#172B25',fontSize:16},list:{paddingHorizontal:20,paddingBottom:24,flexGrow:1},row:{flexDirection:'row',alignItems:'center',gap:14,paddingVertical:20,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:'#DEE7E2'},avatar:{width:48,height:48,borderRadius:24,backgroundColor:'#DCEEE6',alignItems:'center',justifyContent:'center'},initial:{fontSize:22,fontWeight:'600',color:'#087F69'},info:{flex:1},name:{fontSize:16,fontWeight:'600',color:'#172B25'},meta:{fontSize:12,color:'#657C76',marginTop:5,lineHeight:18},empty:{flex:1,alignItems:'center',justifyContent:'center',padding:25,gap:14},emptyTitle:{fontSize:21,fontWeight:'600',color:'#172B25',textAlign:'center'},detail:{fontSize:14,lineHeight:22,color:'#657C76',textAlign:'center'},primary:{padding:15,backgroundColor:'#087F69',borderRadius:24,marginTop:10},primaryText:{color:'white',fontWeight:'600'},nav:{flexDirection:'row',borderTopWidth:StyleSheet.hairlineWidth,borderTopColor:'#DEE7E2',paddingVertical:12},navItem:{flex:1,alignItems:'center',gap:5,minHeight:48},navText:{fontSize:12,color:'#657C76'},profile:{flexDirection:'row',alignItems:'center',gap:14,paddingVertical:24},footnote:{fontSize:13,color:'#657C76',lineHeight:21,marginTop:25},notice:{padding:12,color:'#087F69',textAlign:'center'},
});
