import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { ScrollView, StatusBar, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import { useAppStore } from '../store/appStore';

export default function QRCodeScreen() {
  const uuid = useAppStore(s => s.myUUID);
  const name = useAppStore(s => s.myDeviceName);
  const { width } = useWindowDimensions();
  return <SafeAreaView style={s.page}>
    <StatusBar barStyle="dark-content" backgroundColor="#F8FAF9" />
    <View style={s.header}><TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={s.back}><Ionicons name="arrow-back" size={24} color="#17352D" /></TouchableOpacity><Text style={s.brand}>BigK</Text></View>
    <ScrollView contentContainerStyle={s.content}>
      <Text style={s.title}>My contact code</Text>
      <Text style={s.detail}>An easy way to add each other. No phone number needed.</Text>
      <View style={s.card}>
        <View style={s.avatar}><Text style={s.initial}>{(name || '?').slice(0,1).toUpperCase()}</Text></View>
        <Text style={s.name}>{name || 'Your profile'}</Text><Text style={s.label}>BigK contact</Text>
        <View style={s.code} accessibilityLabel="Your BigK contact QR code">
          {uuid && name ? <QRCode value={JSON.stringify({uuid,name})} size={Math.max(100,Math.min(240,width-128))} color="#17352D" backgroundColor="#FFFFFF" /> : <Text style={s.detail}>Complete your profile to share your code.</Text>}
        </View>
        <Text style={s.hint}>Ask your contact to open BigK and scan this code.</Text>
      </View>
      <View style={s.note}><Ionicons name="people-outline" size={23} color="#087F69" /><Text style={s.noteText}>Add each other on both phones to call in either direction. Share your code only with people you know.</Text></View>
      <TouchableOpacity accessibilityRole="button" style={s.primary} onPress={()=>router.replace('/qr-scanner')}><Ionicons name="scan-outline" size={22} color="#FFFFFF" /><Text style={s.primaryText}>Scan a contact instead</Text></TouchableOpacity>
      <Text style={s.hint}>Adding a contact does not extend your wireless range.</Text>
    </ScrollView>
  </SafeAreaView>;
}
const s = StyleSheet.create({
  page:{flex:1,backgroundColor:'#F8FAF9'},header:{flexDirection:'row',alignItems:'center',paddingHorizontal:16,paddingVertical:8,gap:12},back:{width:48,height:48,alignItems:'center',justifyContent:'center'},brand:{fontSize:17,fontWeight:'700',letterSpacing:3,color:'#087F69'},
  content:{padding:24,paddingTop:10,gap:18,alignItems:'center'},title:{fontSize:30,fontWeight:'700',color:'#17352D',alignSelf:'flex-start'},detail:{fontSize:16,lineHeight:24,color:'#657C76',alignSelf:'flex-start'},
  card:{width:'100%',maxWidth:440,backgroundColor:'#FFFFFF',borderRadius:28,borderWidth:1,borderColor:'#E1EBE7',padding:20,alignItems:'center'},avatar:{width:64,height:64,borderRadius:32,backgroundColor:'#DDEFE7',alignItems:'center',justifyContent:'center'},initial:{fontSize:28,fontWeight:'600',color:'#087F69'},
  name:{fontSize:24,fontWeight:'600',color:'#17352D',marginTop:12,textAlign:'center'},label:{fontSize:14,color:'#657C76',marginTop:4},code:{padding:16,backgroundColor:'#FFFFFF',marginVertical:16},hint:{fontSize:13,lineHeight:21,color:'#657C76',textAlign:'center'},
  note:{flexDirection:'row',gap:12,alignItems:'flex-start',width:'100%',maxWidth:440},noteText:{flex:1,fontSize:14,lineHeight:22,color:'#657C76'},primary:{backgroundColor:'#087F69',borderRadius:16,padding:17,flexDirection:'row',gap:10,justifyContent:'center',alignItems:'center',width:'100%',maxWidth:440},primaryText:{color:'#FFFFFF',fontWeight:'600',fontSize:16},
});
