import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Linking, ScrollView, StatusBar, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore } from '../store/appStore';

export default function QRScannerScreen() {
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [cameraError, setCameraError] = useState(false);
  const [torch, setTorch] = useState(false);
  const lock = useRef(false);
  const addFriend = useAppStore(s => s.addFriend);
  useFocusEffect(useCallback(() => { setFocused(true); return () => { setFocused(false); setTorch(false); }; }, []));
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      setActive(state === 'active');
      if (state === 'active') void getPermission().catch(() => {}); else setTorch(false);
    });
    return () => sub.remove();
  }, [getPermission]);
  const retry = () => { lock.current = false; setScanned(false); };
  const handleBarcode = ({ data }: { data: string }) => {
    if (lock.current) return;
    lock.current = true; setScanned(true); setTorch(false);
    try {
      if (data.length > 2048) throw new Error();
      const parsed = JSON.parse(data);
      if (!parsed || typeof parsed.uuid !== 'string' || typeof parsed.name !== 'string' ||
          !parsed.uuid.trim() || parsed.uuid.length > 128 || !parsed.name.trim() || parsed.name.length > 100) throw new Error();
      const { uuid } = parsed; const name = parsed.name.trim();
      if (uuid === useAppStore.getState().myUUID) {
        Alert.alert('That is your code', 'Scan the code on the other phone.', [{text:'Scan again',onPress:retry}]); return;
      }
      if (useAppStore.getState().isFriendByUUID(uuid)) {
        Alert.alert('Already in contacts', name + ' is already saved.', [{text:'Scan another',onPress:retry},{text:'Done',onPress:()=>router.back()}]); return;
      }
      Alert.alert('Add ' + name + '?', 'Only add people you know. Ask them to scan your code too.', [
        {text:'Cancel',style:'cancel',onPress:retry},
        {text:'Add contact',onPress:async()=>{
          try {
            await addFriend({uuid,name,currentMac:''});
          } catch { Alert.alert('Could not save contact', 'Please try again.', [{text:'Retry',onPress:retry}]); return; }
          Alert.alert('Contact added', name + ' is now in your contacts.', [{text:'Scan another',onPress:retry},{text:'Done',onPress:()=>router.back()}]);
        }},
      ], {cancelable:false});
    } catch { Alert.alert('Not a BigK contact code', 'Ask your contact to open My contact code in BigK.', [{text:'Scan again',onPress:retry}]); }
  };
  const allowCamera = async () => {
    try { if (permission?.canAskAgain === false) await Linking.openSettings(); else await requestPermission(); }
    catch { Alert.alert('Camera access unavailable', 'Allow BigK camera access in Android Settings.'); }
  };
  return <SafeAreaView style={s.page}>
    <StatusBar barStyle="dark-content" backgroundColor="#F8FAF9" />
    <View style={s.header}><TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" style={s.back} onPress={()=>router.back()}><Ionicons name="arrow-back" size={24} color="#17352D" /></TouchableOpacity><Text style={s.brand}>BigK</Text></View>
    <ScrollView contentContainerStyle={s.content}>
      <Text style={s.title}>Add a contact</Text><Text style={s.detail}>Scan their BigK code to stay in touch locally.</Text>
      <View style={s.cameraBox}>
        {permission?.granted && focused && active && !cameraError ? <>
          <CameraView style={StyleSheet.absoluteFillObject} facing="back" enableTorch={torch} onMountError={()=>setCameraError(true)} onBarcodeScanned={scanned ? undefined : handleBarcode} barcodeScannerSettings={{barcodeTypes:['qr']}} />
          <View pointerEvents="none" style={s.overlay}><View style={s.finder}><View style={[s.corner,s.tl]}/><View style={[s.corner,s.tr]}/><View style={[s.corner,s.bl]}/><View style={[s.corner,s.br]}/></View><Text style={s.cameraHint}>{scanned ? 'Code captured' : 'Keep the code inside the frame'}</Text></View>
        </> : <View style={s.permission}>
          {!permission ? <ActivityIndicator color="#087F69" /> : <Ionicons name="camera-outline" size={44} color="#087F69" />}
          <Text style={s.permissionTitle}>{cameraError ? 'Camera unavailable' : permission?.granted ? 'Camera paused' : 'Allow camera access'}</Text>
          <Text style={s.permissionText}>{cameraError ? 'Close other camera apps, then try again.' : 'Your camera is used to scan contact codes.'}</Text>
          {permission && (!permission.granted || cameraError) && <TouchableOpacity accessibilityRole="button" style={s.primary} onPress={cameraError ? ()=>setCameraError(false) : allowCamera}><Text style={s.primaryText}>{cameraError ? 'Try again' : permission.canAskAgain ? 'Allow camera' : 'Open settings'}</Text></TouchableOpacity>}
        </View>}
      </View>
      {permission?.granted && <TouchableOpacity accessibilityRole="button" accessibilityLabel={torch ? 'Turn flashlight off' : 'Turn flashlight on'} disabled={scanned || !active || cameraError} onPress={()=>setTorch(v=>!v)} style={s.flash}><Ionicons name={torch ? 'flash' : 'flash-outline'} size={20} color="#087F69" /><Text style={s.flashText}>Flashlight {torch ? 'on' : 'off'}</Text></TouchableOpacity>}
      <View style={s.note}><Ionicons name="people-outline" size={22} color="#087F69" /><Text style={s.noteText}>On the other phone, open BigK and tap the QR icon, and have them scan your code too so you both appear in Contacts.</Text></View>
      <TouchableOpacity accessibilityRole="button" style={s.secondary} onPress={()=>router.replace('/qr-code')}><Ionicons name="qr-code-outline" size={22} color="#087F69" /><Text style={s.flashText}>Show my contact code</Text></TouchableOpacity>
    </ScrollView>
  </SafeAreaView>;
}
const s = StyleSheet.create({
  page:{flex:1,backgroundColor:'#F8FAF9'},header:{flexDirection:'row',alignItems:'center',paddingHorizontal:16,paddingVertical:8,gap:12},back:{width:48,height:48,alignItems:'center',justifyContent:'center'},brand:{fontSize:17,fontWeight:'700',letterSpacing:3,color:'#087F69'},
  content:{padding:24,paddingTop:10,gap:18,alignItems:'center'},title:{fontSize:30,fontWeight:'700',color:'#17352D',alignSelf:'flex-start'},detail:{fontSize:16,lineHeight:24,color:'#657C76',alignSelf:'flex-start'},
  cameraBox:{width:'100%',maxWidth:440,aspectRatio:0.92,backgroundColor:'#EAF1EE',borderRadius:28,overflow:'hidden'},overlay:{...StyleSheet.absoluteFillObject,alignItems:'center',justifyContent:'center',backgroundColor:'rgba(0,0,0,0.12)'},finder:{width:'70%',aspectRatio:1},
  corner:{position:'absolute',width:32,height:32,borderColor:'#88E5C1'},tl:{top:0,left:0,borderTopWidth:4,borderLeftWidth:4,borderTopLeftRadius:12},tr:{top:0,right:0,borderTopWidth:4,borderRightWidth:4,borderTopRightRadius:12},bl:{bottom:0,left:0,borderBottomWidth:4,borderLeftWidth:4,borderBottomLeftRadius:12},br:{bottom:0,right:0,borderBottomWidth:4,borderRightWidth:4,borderBottomRightRadius:12},
  cameraHint:{position:'absolute',bottom:20,color:'#FFFFFF',backgroundColor:'#17352D',padding:10,borderRadius:10,fontSize:13},permission:{flex:1,justifyContent:'center',alignItems:'center',padding:24,gap:14},permissionTitle:{fontSize:21,fontWeight:'600',color:'#17352D',textAlign:'center'},permissionText:{fontSize:14,lineHeight:21,color:'#657C76',textAlign:'center'},
  primary:{backgroundColor:'#087F69',borderRadius:14,paddingHorizontal:24,paddingVertical:15},primaryText:{fontSize:16,fontWeight:'600',color:'#FFFFFF'},flash:{minHeight:48,flexDirection:'row',gap:8,alignItems:'center',paddingHorizontal:18},flashText:{fontSize:16,fontWeight:'600',color:'#087F69'},
  note:{flexDirection:'row',gap:12,maxWidth:440},noteText:{flex:1,fontSize:14,lineHeight:22,color:'#657C76'},secondary:{width:'100%',maxWidth:440,minHeight:56,borderWidth:1,borderColor:'#C8DFD6',borderRadius:16,flexDirection:'row',justifyContent:'center',alignItems:'center',gap:10,padding:12},
});
