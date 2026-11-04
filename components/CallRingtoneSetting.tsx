import { useEffect, useState } from 'react';
import { Alert, AppState, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { requireCallNotifications } from '../services/BackgroundAvailability';
import { RingtoneSettings, ringtoneDescription } from '../services/RingtoneSettings';

export default function CallRingtoneSetting({ alertsEnabled }: { alertsEnabled: boolean }) {
  const [settings, setSettings] = useState<RingtoneSettings | null>(null);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const value = await requireCallNotifications('getRingtoneSettings').getRingtoneSettings();
        if (live) { setSettings(value); setError(''); }
      } catch (error: any) {
        if (live) { setSettings(null); setError(error?.message || 'Could not read Android ringtone settings. Tap to retry opening settings.'); }
      }
    };
    void refresh();
    const listener = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); });
    return () => { live = false; listener.remove(); };
  }, []);
  const open = async () => {
    if (opening) return;
    setOpening(true);
    try { await requireCallNotifications('openRingtoneSettings').openRingtoneSettings(); }
    catch (error: any) { Alert.alert('Ringtone settings unavailable', error?.message || 'Open BigK’s notification settings from Android Settings to choose a sound.'); }
    finally { setOpening(false); }
  };
  return <TouchableOpacity style={s.row} disabled={opening} accessibilityRole="button" accessibilityLabel="Choose call ringtone in Android settings" onPress={() => void open()}>
    <Ionicons name="musical-note-outline" size={22} color="#087F69" />
    <View style={s.info}><Text style={s.title}>Call ringtone</Text><Text accessibilityLiveRegion="polite" style={s.description}>{error || ringtoneDescription(settings, alertsEnabled)}</Text></View>
    <Ionicons name="chevron-forward" size={20} color="#657C76" />
  </TouchableOpacity>;
}
const s = StyleSheet.create({row:{flexDirection:'row',alignItems:'center',gap:14,paddingVertical:20,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:'#DEE7E2'},info:{flex:1},title:{fontSize:16,fontWeight:'600',color:'#172B25'},description:{fontSize:12,lineHeight:18,color:'#657C76',marginTop:5}});
