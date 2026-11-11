import { Ionicons } from '@expo/vector-icons';
import * as Application from 'expo-application';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import type { ErrorBoundaryProps } from 'expo-router';
import { useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { describeBuild, getBuildInfo } from '@/domain/build-info';
import { buildDiagnosticsContext, formatDiagnosticsReport } from '@/domain/diagnostics';
import { useT } from '@/i18n';
import type { MessageKey } from '@/i18n/messages';
import { getLogEntries } from '@/observability/log-buffer';
import { describeRecentSegments } from '@/observability/slow-segment-log';
import { usePalette } from '@/theme';
import { Button } from '@/ui/Button';

function useSafeT() {
  try {
    return useT();
  } catch {
    return (key: MessageKey) => {
      const fallbacks: Record<string, string> = {
        'errorBoundary.title': 'Something went wrong',
        'errorBoundary.message': 'An unexpected error occurred in the application.',
        'errorBoundary.retry': 'Try again',
        'errorBoundary.report': 'Send error log',
        'errorBoundary.copied': 'Error log copied to clipboard',
      };
      return fallbacks[key] ?? key;
    };
  }
}

function useSafePalette() {
  try {
    return usePalette();
  } catch {
    return {
      background: '#0f172a',
      text: '#f8fafc',
      textSecondary: '#94a3b8',
      card: '#1e293b',
      border: '#334155',
      controlBorder: '#475569',
      danger: '#ef4444',
      accent: '#38bdf8',
      accentForeground: '#0f172a',
      mutedSurface: '#1e293b',
    };
  }
}

export function RootErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const t = useSafeT();
  const palette = useSafePalette();
  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);

  const getDiagnosticsPayload = () => {
    const appVersion = Constants.expoConfig?.version ?? '0.0.0';
    const appBuildVersion = Application.nativeBuildVersion ?? undefined;
    const platform = Platform.OS;
    const buildLabel = describeBuild(getBuildInfo(Constants.expoConfig?.extra));
    const recentLogs = getLogEntries().slice(-100).map((e) => `${e.t} [${e.level}] ${e.message}`);
    const context = buildDiagnosticsContext({
      appVersion,
      appBuildVersion,
      platform,
      osVersion: `Expo SDK ${Constants.expoConfig?.sdkVersion ?? '58'}`,
      route: 'error_boundary',
      sourceSurface: 'root_error_boundary',
      authStatus: 'unknown',
      queueDepth: 0,
      isSyncing: false,
      lastPulledAt: null,
      build: buildLabel,
      logs: recentLogs,
      recentSlowSegments: describeRecentSegments(),
    });

    return [
      `Keepory Crash Diagnostic Report`,
      `Error: ${error.name}: ${error.message}`,
      error.stack ? `Stack Trace:\n${error.stack}` : '',
      `--- Diagnostic Context ---`,
      formatDiagnosticsReport(context),
    ]
      .filter(Boolean)
      .join('\n\n');
  };

  const handleShareReport = async () => {
    if (sharing) return;
    setSharing(true);
    const reportText = getDiagnosticsPayload();
    try {
      await Share.share({
        title: 'Keepory Crash Report',
        message: reportText,
      });
    } catch {
      // If native sharing fails or is cancelled, copy to clipboard as fallback
      try {
        await Clipboard.setStringAsync(reportText);
        setCopied(true);
        setTimeout(() => setCopied(false), 3000);
      } catch {}
    } finally {
      setSharing(false);
    }
  };

  return (
    <SafeAreaView
      testID="root-error-boundary"
      style={[styles.container, { backgroundColor: palette.background }]}
    >
      <View style={styles.header}>
        <Ionicons name="alert-circle-outline" size={48} color={palette.danger} />
        <Text style={[styles.title, { color: palette.text }]}>
          {t('errorBoundary.title')}
        </Text>
        <Text style={[styles.subtitle, { color: palette.textSecondary }]}>
          {t('errorBoundary.message')}
        </Text>
      </View>

      <ScrollView
        style={[styles.errorBox, { backgroundColor: palette.card, borderColor: palette.border }]}
        contentContainerStyle={styles.errorContent}
      >
        <Text
          selectable
          testID="root-error-boundary-message"
          style={[styles.errorMessage, { color: palette.danger }]}
        >
          {error.name ? `${error.name}: ${error.message}` : error.message}
        </Text>
        {error.stack ? (
          <Text selectable style={[styles.errorStack, { color: palette.textSecondary }]}>
            {error.stack}
          </Text>
        ) : null}
      </ScrollView>

      {copied ? (
        <Text style={[styles.copiedNote, { color: palette.accent }]}>
          {t('errorBoundary.copied')}
        </Text>
      ) : null}

      <View style={styles.actions}>
        <Button
          testID="root-error-boundary-retry"
          size="lg"
          icon="refresh"
          onPress={retry}
        >
          {t('errorBoundary.retry')}
        </Button>
        <Button
          testID="root-error-boundary-report"
          size="lg"
          variant="secondary"
          icon="bug-outline"
          disabled={sharing}
          onPress={() => void handleShareReport()}
        >
          {t('errorBoundary.report')}
        </Button>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    gap: 16,
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    gap: 8,
    marginTop: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    paddingHorizontal: 16,
  },
  errorBox: {
    flex: 1,
    maxHeight: 240,
    borderRadius: 12,
    borderWidth: 1,
    marginVertical: 8,
  },
  errorContent: {
    padding: 14,
    gap: 8,
  },
  errorMessage: {
    fontSize: 14,
    fontWeight: '600',
    fontFamily: Platform.select({ default: 'monospace', ios: 'Courier New' }),
  },
  errorStack: {
    fontSize: 11,
    lineHeight: 16,
    fontFamily: Platform.select({ default: 'monospace', ios: 'Courier New' }),
  },
  copiedNote: {
    fontSize: 13,
    textAlign: 'center',
    fontWeight: '600',
  },
  actions: {
    gap: 12,
    marginBottom: 8,
  },
});
