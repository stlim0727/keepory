import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { useOpenReport } from '@/feedback/open-report';
import type { FeedbackSourceContext } from '@/feedback/screenshot-session';
import { useT } from '@/i18n';
import type { MessageKey } from '@/i18n/messages';
import { usePalette } from '@/theme';

/**
 * Inline "report this defect" action surfaced directly on an abnormal UI state
 * (sync failure, save failure, crash). Framed as diagnostic telemetry to the
 * development team — a bug icon and defect copy — rather than a generic
 * "Report a problem" that reads like a 1:1 support desk. Opens the shared
 * report flow via `useOpenReport` with a precise source surface.
 */
export function ReportDefectButton({
  source,
  labelKey,
  testID,
  disabled = false,
  style,
}: {
  source: FeedbackSourceContext;
  labelKey: MessageKey;
  testID?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useT();
  const palette = usePalette();
  const { openReport, capturing } = useOpenReport(source.route);
  const inactive = disabled || capturing;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t(labelKey)}
      accessibilityHint={t('report.defectA11yHint')}
      accessibilityState={{ disabled: inactive }}
      testID={testID}
      disabled={inactive}
      onPress={() => void openReport(source)}
      style={({ pressed }) => [
        styles.action,
        inactive && styles.inactive,
        pressed && { opacity: 0.6 },
        style,
      ]}
    >
      <Ionicons name="bug-outline" size={16} color={palette.accent} />
      <Text style={[styles.label, { color: palette.accent }]}>{t(labelKey)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    minHeight: 48,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
  },
  inactive: {
    opacity: 0.5,
  },
});
