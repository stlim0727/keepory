import { Ionicons } from '@expo/vector-icons';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useOpenReport } from '@/feedback/open-report';
import { useT } from '@/i18n';
import { usePalette } from '@/theme';
import { Button } from '@/ui/Button';

/**
 * The crash fallback's report action. Unlike the inline `ReportDefectButton`,
 * this opens the report flow and *then* clears the boundary: the navigator's
 * children are unmounted while the fallback shows, so the report route only
 * renders once the boundary resets after `openReport` has pushed it.
 */
function CrashFallback({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { openReport, capturing } = useOpenReport('/crash');

  const handleReport = async () => {
    await openReport({ route: '/crash', surface: 'crash' });
    onRetry();
  };

  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top + 24 }]}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        <Ionicons name="bug-outline" size={44} color={palette.danger} />
        <Text style={[styles.title, { color: palette.text }]}>{t('crash.title')}</Text>
        <Text style={[styles.body, { color: palette.textSecondary }]}>{t('crash.body')}</Text>
        <View style={styles.actions}>
          <Button
            testID="crash-report"
            variant="secondary"
            icon="bug-outline"
            disabled={capturing}
            onPress={() => void handleReport()}
          >
            {t('crash.report')}
          </Button>
          <Button testID="crash-retry" variant="primary" icon="refresh" onPress={onRetry}>
            {t('crash.retry')}
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}

interface CrashBoundaryState {
  crashed: boolean;
}

/**
 * Renders a diagnostic crash fallback for unhandled render/runtime errors in
 * the route tree. Sits inside the app's providers so the fallback can localize
 * and the report flow stays usable. The error itself is logged (never shown)
 * so it rides the log buffer into the report and Sentry.
 */
export class CrashBoundary extends Component<{ children: ReactNode }, CrashBoundaryState> {
  state: CrashBoundaryState = { crashed: false };

  static getDerivedStateFromError(): CrashBoundaryState {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('app: render crash', error?.message ?? 'unknown', info.componentStack ?? '');
  }

  reset = (): void => {
    this.setState({ crashed: false });
  };

  render(): ReactNode {
    if (this.state.crashed) {
      return <CrashFallback onRetry={this.reset} />;
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  actions: {
    alignSelf: 'stretch',
    gap: 10,
    marginTop: 12,
  },
});
