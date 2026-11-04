import { NativeModules } from 'react-native';

describe('OpusModule compatibility', () => {
  it('exposes the native module shape expected by the app', () => {
    expect(NativeModules.OpusModule).toBeDefined();
    expect(typeof NativeModules.OpusModule?.initEncoder).toBe('function');
    expect(typeof NativeModules.OpusModule?.initDecoder).toBe('function');
    expect(typeof NativeModules.OpusModule?.encode).toBe('function');
    expect(typeof NativeModules.OpusModule?.decode).toBe('function');
  });
});
