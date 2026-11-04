/**
 * CallServiceModule — Bridge to Android foreground service
 * Keeps call alive when app is backgrounded
 */
import { NativeModules } from 'react-native';

const CallService = NativeModules.CallServiceModule;

if (!CallService) {
  throw new Error('CallServiceModule not available');
}

export default {
  /**
   * Start foreground service for ongoing call
   * Shows persistent notification on Android
   */
  startCallService: (): Promise<boolean> => {
    return CallService.startCallService();
  },

  /**
   * Stop foreground service when call ends
   */
  stopCallService: (): Promise<boolean> => {
    return CallService.stopCallService();
  },
};
