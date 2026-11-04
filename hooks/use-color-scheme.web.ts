import { useColorScheme as useRNColorScheme } from 'react-native';

/**
 * Use the runtime color scheme directly on web; default to light for static rendering.
 */
export function useColorScheme() {
  return useRNColorScheme() ?? 'light';
}
