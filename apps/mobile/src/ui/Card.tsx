import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { usePalette, uiMetrics } from '@/theme';

interface CardProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  elevated?: boolean;
  bordered?: boolean;
  selected?: boolean;
  testID?: string;
}

export function Card({
  children,
  style,
  elevated = false,
  bordered = false,
  selected = false,
  testID,
}: CardProps) {
  const palette = usePalette();
  const showBorder = bordered || elevated || selected;

  return (
    <View
      testID={testID}
      style={[
        styles.card,
        {
          backgroundColor: selected ? palette.accentSoft : palette.card,
          borderColor: selected ? palette.accent : palette.border,
          borderWidth: selected ? 2 : showBorder ? 1 : 0,
        },
        elevated && palette.shadow.card,
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 0,
    borderRadius: uiMetrics.radius,
  },
});
