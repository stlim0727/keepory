import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';

import { useT } from '@/i18n';
import {
  dismissDuplicateShareNotice,
  refreshDuplicateShareNotice,
  subscribeDuplicateShareNotice,
  type DuplicateShareNotice,
} from '@/share/duplicate-notice';
import { usePalette } from '@/theme';

/** An acknowledged duplicate remains visible until View or Close is tapped. */
export function DuplicateShareRibbon({ getBookmark, ready, maxWidth }: {
  getBookmark: (id: string) => { id: string } | null | undefined;
  ready: boolean;
  maxWidth: number;
}) {
  const [notice, setNotice] = useState<DuplicateShareNotice | null>(null);
  const palette = usePalette();
  const t = useT();
  const router = useRouter();

  useEffect(() => {
    const unsubscribe = subscribeDuplicateShareNotice(setNotice);
    if (ready) void refreshDuplicateShareNotice();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && ready) void refreshDuplicateShareNotice();
    });
    return () => { unsubscribe(); subscription.remove(); };
  }, [ready]);

  // Do not expose or navigate to another account's item during account changes,
  // or offer View for an item that has since been permanently deleted.
  if (!notice || !ready || !getBookmark(notice.bookmarkId)) return null;

  const dismiss = () => { void dismissDuplicateShareNotice(notice.id); };
  return <View testID="duplicate-share-ribbon" style={[styles.ribbon, {
    maxWidth, backgroundColor: palette.accentSoft, borderColor: palette.border,
  }]}>
    <Ionicons name="copy-outline" size={18} color={palette.accentText} accessible={false} />
    <Text accessibilityLiveRegion="polite" style={[styles.message, { color: palette.text }]}>
      {t('toast.duplicate')}
    </Text>
    <Pressable accessibilityRole="button" accessibilityLabel={t('common.view')}
      onPress={() => { router.push(`/bookmark/${notice.bookmarkId}` as any); dismiss(); }}
      style={styles.action}>
      <Text style={[styles.actionText, { color: palette.accentText }]}>{t('common.view')}</Text>
    </Pressable>
    <Pressable testID="duplicate-share-ribbon-close" accessibilityRole="button"
      accessibilityLabel={t('common.close')} onPress={dismiss} style={styles.close}>
      <Ionicons name="close" size={20} color={palette.textSecondary} accessible={false} />
    </Pressable>
  </View>;
}

const styles = StyleSheet.create({
  ribbon: { width: '100%', alignSelf: 'center', flexDirection: 'row', alignItems: 'center',
    gap: 8, paddingLeft: 12, paddingRight: 4, marginBottom: 8, borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth },
  message: { flex: 1, fontSize: 14, fontWeight: '600', paddingVertical: 10 },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  actionText: { fontSize: 14, fontWeight: '700' },
  close: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
