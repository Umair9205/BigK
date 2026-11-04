/**
 * setup.tsx — First launch setup screen (FR-1, FR-25, FR-26)
 * Collects name, requests all permissions with explanations
 */
import { router } from 'expo-router';
import { useState } from 'react';
import {
    Alert, ImageBackground, KeyboardAvoidingView, PermissionsAndroid,
    Platform, StatusBar, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useAppStore } from '../store/appStore';
import { nearbyPermissions } from '../services/NearbyAvailability';

const BG = require('../assets/images/banana-bg.png');

const PERMISSIONS_EXPLANATION = [
  { perm: 'RECORD_AUDIO',      why: 'Microphone — to capture your voice during calls' },
  { perm: 'ACCESS_FINE_LOCATION', why: 'Location — required by Android for WiFi Direct peer discovery' },
];

export default function SetupScreen() {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const initIdentity = useAppStore(s => s.initIdentity);

  const requestPermissions = async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;
    const perms: string[] = [
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      ...nearbyPermissions(),
    ];
    if (Platform.Version >= 33) perms.push('android.permission.NEARBY_WIFI_DEVICES' as any);

    // Show explanation before requesting (FR-26)
    await new Promise<void>(resolve =>
      Alert.alert(
        'Permissions Needed',
        'BigK needs these permissions:\n\n' +
        PERMISSIONS_EXPLANATION.map(p => `• ${p.why}`).join('\n') +
        (Platform.Version as number >= 33 ? '\n• Nearby Devices — to scan for WiFi Direct peers on Android 13+' : '') +
        '\n\nNo data leaves your device.',
        [{ text: 'Continue', onPress: () => resolve() }]
      )
    );

    const results = await PermissionsAndroid.requestMultiple(perms as any);
    const allGranted = Object.values(results).every(r => r === PermissionsAndroid.RESULTS.GRANTED);
    if (!allGranted) {
      Alert.alert('Some permissions denied', 'Discovery and calling may not work without location permission. You can grant them in Settings.');
    }
    return allGranted;
  };

  const handleStart = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length < 2) {
      Alert.alert('Enter your name', 'Please enter at least 2 characters.'); return;
    }
    setLoading(true);
    try {
      if (!(await requestPermissions())) return;
      await initIdentity(trimmed);
      router.replace('/(tabs)');
    } catch (e: any) {
      Alert.alert('Setup failed', e?.message ?? 'Unknown error');
    } finally { setLoading(false); }
  };

  return (
    <ImageBackground source={BG} style={styles.bg} resizeMode="cover">
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView style={styles.kav} behavior="padding">
        <View style={styles.overlay}>
          <View style={styles.top}>
            <Text style={styles.appName}>BigK</Text>
            <Text style={styles.tagline}>Offline P2P Voice Calling</Text>
            <Text style={styles.sub}>No internet · No servers · Encrypted</Text>
          </View>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Set Your Name</Text>
            <Text style={styles.cardSub}>This is how nearby users will identify you</Text>
            <TextInput
              style={styles.input}
              placeholder="Your name"
              placeholderTextColor="rgba(255,255,255,0.3)"
              value={name}
              onChangeText={setName}
              maxLength={30}
              autoCapitalize="words"
              returnKeyType="done"
              onSubmitEditing={handleStart}
            />
            <TouchableOpacity
              style={[styles.btn, (!name.trim() || loading) && styles.btnDisabled]}
              onPress={handleStart}
              disabled={!name.trim() || loading}
            >
              <Text style={styles.btnText}>{loading ? 'Setting up...' : 'Get Started →'}</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.footer}>Nearby Connections · Opus Audio · Offline-First</Text>
        </View>
      </KeyboardAvoidingView>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1 },
  kav: { flex: 1 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'space-between', paddingVertical: 70, paddingHorizontal: 24 },
  top: { alignItems: 'center', gap: 8 },
  appName: { fontSize: 12, fontWeight: '900', letterSpacing: 4, color: '#F5C842' },
  tagline: { fontSize: 32, fontWeight: '900', color: '#fff', textAlign: 'center', letterSpacing: -0.5 },
  sub: { fontSize: 14, color: 'rgba(255,255,255,0.5)', fontWeight: '600' },
  card: { backgroundColor: 'rgba(15,15,15,0.9)', borderRadius: 24, padding: 24, gap: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  cardTitle: { fontSize: 20, fontWeight: '900', color: '#fff' },
  cardSub: { fontSize: 13, color: 'rgba(255,255,255,0.4)', marginTop: -4 },
  input: { backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, color: '#fff', fontWeight: '600' },
  btn: { backgroundColor: '#F5C842', borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  btnDisabled: { opacity: 0.4 },
  btnText: { fontSize: 16, fontWeight: '900', color: '#1a1a1a' },
  footer: { textAlign: 'center', fontSize: 10, color: 'rgba(255,255,255,0.2)', fontWeight: '700', letterSpacing: 2 },
});
