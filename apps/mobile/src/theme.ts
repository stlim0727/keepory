import { useColorScheme } from 'react-native';

export const uiMetrics = {
  touchTarget: 48,
  screenGutter: 16,
  radius: 16,
} as const;

const shared = {
  radius: {
    sm: 10,
    md: 16,
    lg: 22,
    xl: 28,
    pill: 999,
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    xxl: 32,
  },
  shadow: {
    card: {
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.10,
      shadowRadius: 24,
      elevation: 2,
    },
    soft: {
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.08,
      shadowRadius: 8,
      elevation: 1,
    },
  },
} as const;

export const palettes = {
  light: {
    ...shared,
    text: '#151b26',
    textSecondary: '#5a6070',
    background: '#f7f6f2',
    surface: '#ffffff',
    surfaceElevated: '#ffffff',
    surfaceContainerLowest: '#ffffff',
    surfaceContainerLow: '#f7f6f2',
    surfaceContainer: '#eeede8',
    surfaceContainerHigh: '#e8e7e1',
    surfaceContainerHighest: '#e2e1db',
    onSurface: '#151b26',
    onSurfaceVariant: '#5a6070',
    mutedSurface: '#eeede8',
    card: '#ffffff',
    border: '#d8d7d0',
    controlBorder: '#85857e',
    accent: '#2473cc',
    accentForeground: '#ffffff',
    accentSoft: '#e6f0fc',
    accentText: '#1a5ca8',
    highlight: '#c9941c',
    highlightText: '#151b26',
    // Soft tinted fill derived from `highlight`, following the same pattern as
    // `accentSoft`/`successSoft`. Used by Folder View's hash-based collection
    // tile coloring (see `@/domain/collection-color`).
    highlightSoft: '#faf1de',
    danger: '#c0392b',
    dangerSoft: '#fce8e6',
    success: '#1e7a4e',
    successSoft: '#e3f5ec',
  },
  dark: {
    ...shared,
    text: '#f7f6f2',
    textSecondary: '#aaaeb8',
    background: '#151b26',
    surface: '#202733',
    surfaceElevated: '#202733',
    surfaceContainerLowest: '#0f131a',
    surfaceContainerLow: '#1a202c',
    surfaceContainer: '#202733',
    surfaceContainerHigh: '#262f3d',
    surfaceContainerHighest: '#2d3747',
    onSurface: '#f7f6f2',
    onSurfaceVariant: '#aaaeb8',
    mutedSurface: '#2a3443',
    card: '#202733',
    border: '#3a4454',
    controlBorder: '#8290a3',
    accent: '#4a98e8',
    accentForeground: '#151b26',
    accentSoft: '#253b50',
    accentText: '#d8ebff',
    highlight: '#eecb69',
    highlightText: '#151b26',
    highlightSoft: '#3d3420',
    danger: '#ff8a7a',
    dangerSoft: '#432529',
    success: '#8eddbb',
    successSoft: '#203d33',
  },
} as const;

export type Palette = (typeof palettes)['light'];

export function usePalette() {
  const scheme = useColorScheme();
  return palettes[scheme === 'dark' ? 'dark' : 'light'];
}
