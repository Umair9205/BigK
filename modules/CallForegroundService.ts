/**
 * CallForegroundService Bridge — Start/stop native foreground service
 * Keeps call alive when app is backgrounded
 */
import { NativeModules } from 'react-native';

const CallForegroundServiceModule = NativeModules.CallForegroundServiceModule;

if (!CallForegroundServiceModule) {
  throw new Error('CallForegroundServiceModule is not available');
}

class CallForegroundServiceBridge {
  async startCallService(peerName: string): Promise<boolean> {
    try {
      console.log('[CallForegroundService] Starting service for:', peerName);
      const result = await CallForegroundServiceModule.startCallService(peerName);
      return result;
    } catch (e: any) {
      console.error('[CallForegroundService] Start error:', e);
      throw e;
    }
  }

  async stopCallService(): Promise<boolean> {
    try {
      console.log('[CallForegroundService] Stopping service');
      const result = await CallForegroundServiceModule.stopCallService();
      return result;
    } catch (e: any) {
      console.error('[CallForegroundService] Stop error:', e);
      throw e;
    }
  }
}

export default new CallForegroundServiceBridge();
