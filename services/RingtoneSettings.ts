export interface RingtoneSettings {
  name: string;
  notificationsEnabled: boolean;
  channelEnabled: boolean;
  soundAllowed: boolean;
  vibration: boolean;
}

export function ringtoneDescription(settings: RingtoneSettings | null, alertsEnabled: boolean): string {
  if (!alertsEnabled) return 'Call alerts off · choose a sound for when enabled';
  if (!settings) return 'Choose sound in Android settings';
  if (!settings.notificationsEnabled || !settings.channelEnabled) return 'Call notifications blocked in Android settings';
  if (!settings.soundAllowed) return 'Silent · change Sound in Android settings';
  return `${settings.name} · change in Android settings`;
}
