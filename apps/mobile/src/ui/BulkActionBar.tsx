import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useT } from '@/i18n';
import { uiMetrics, usePalette } from '@/theme';
import { overlayLayer } from '@/ui/layering';

export interface BulkActionBarProps {
  selectedCount: number;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  onMove: () => void;
  onTag: () => void;
  onArchive?: () => void;
  onDelete: () => void;
  maxWidth?: number;
  bottomInset?: number;
}

export function BulkActionBar({
  selectedCount,
  isRefreshing = false,
  onRefresh,
  onMove,
  onTag,
  onArchive,
  onDelete,
  maxWidth,
  bottomInset = 0,
}: BulkActionBarProps) {
  const palette = usePalette();
  const t = useT();

  const disabled = selectedCount === 0;

  return (
    <View
      testID="inbox-bulk-action-bar"
      accessibilityRole="toolbar"
      accessibilityLabel={t('inbox.bulkToolbarA11y')}
      style={[
        styles.bar,
        {
          backgroundColor: palette.surfaceElevated,
          borderColor: palette.border,
          bottom: bottomInset + 16,
          maxWidth: maxWidth ?? 500,
        },
      ]}
    >
      {onRefresh ? (
        <>
          <Pressable
            testID="inbox-bulk-refresh"
            accessibilityRole="button"
            accessibilityLabel={t('inbox.bulkRefreshA11y')}
            accessibilityState={{ disabled: disabled || isRefreshing }}
            disabled={disabled || isRefreshing}
            hitSlop={8}
            onPress={onRefresh}
            style={({ pressed }) => [
              styles.actionButton,
              { opacity: disabled ? 0.38 : pressed ? 0.7 : 1 },
            ]}
          >
            {isRefreshing ? (
              <ActivityIndicator size="small" color={palette.accent} style={styles.iconSlot} />
            ) : (
              <Ionicons
                name="refresh-outline"
                size={20}
                color={disabled ? palette.textSecondary : palette.accent}
                style={styles.iconSlot}
              />
            )}
            <Text
              style={[
                styles.actionLabel,
                { color: disabled ? palette.textSecondary : palette.text },
              ]}
              numberOfLines={1}
            >
              {t('inbox.bulkRefresh')}
            </Text>
          </Pressable>
          <View style={[styles.separator, { backgroundColor: palette.border }]} />
        </>
      ) : null}

      <Pressable
        testID="inbox-bulk-tag"
        accessibilityRole="button"
        accessibilityLabel={t('inbox.bulkTagA11y')}
        accessibilityState={{ disabled: disabled || isRefreshing }}
        disabled={disabled || isRefreshing}
        hitSlop={8}
        onPress={onTag}
        style={({ pressed }) => [
          styles.actionButton,
          { opacity: disabled ? 0.38 : pressed ? 0.7 : 1 },
        ]}
      >
        <Ionicons
          name="pricetag-outline"
          size={20}
          color={disabled ? palette.textSecondary : palette.text}
          style={styles.iconSlot}
        />
        <Text
          style={[
            styles.actionLabel,
            { color: disabled ? palette.textSecondary : palette.text },
          ]}
          numberOfLines={1}
        >
          {t('inbox.bulkTag')}
        </Text>
      </Pressable>

      <View style={[styles.separator, { backgroundColor: palette.border }]} />

      <Pressable
        testID="inbox-bulk-move"
        accessibilityRole="button"
        accessibilityLabel={t('inbox.bulkMoveA11y')}
        accessibilityState={{ disabled: disabled || isRefreshing }}
        disabled={disabled || isRefreshing}
        hitSlop={8}
        onPress={onMove}
        style={({ pressed }) => [
          styles.actionButton,
          { opacity: disabled ? 0.38 : pressed ? 0.7 : 1 },
        ]}
      >
        <Ionicons
          name="folder-outline"
          size={20}
          color={disabled ? palette.textSecondary : palette.text}
          style={styles.iconSlot}
        />
        <Text
          style={[
            styles.actionLabel,
            { color: disabled ? palette.textSecondary : palette.text },
          ]}
          numberOfLines={1}
        >
          {t('inbox.bulkMove')}
        </Text>
      </Pressable>

      {onArchive ? (
        <>
          <View style={[styles.separator, { backgroundColor: palette.border }]} />
          <Pressable
            testID="inbox-bulk-archive"
            accessibilityRole="button"
            accessibilityLabel={t('inbox.bulkArchiveA11y' as any) || 'Archive selected bookmarks'}
            accessibilityState={{ disabled: disabled || isRefreshing }}
            disabled={disabled || isRefreshing}
            hitSlop={8}
            onPress={onArchive}
            style={({ pressed }) => [
              styles.actionButton,
              { opacity: disabled ? 0.38 : pressed ? 0.7 : 1 },
            ]}
          >
            <Ionicons
              name="archive-outline"
              size={20}
              color={disabled ? palette.textSecondary : palette.text}
              style={styles.iconSlot}
            />
            <Text
              style={[
                styles.actionLabel,
                { color: disabled ? palette.textSecondary : palette.text },
              ]}
              numberOfLines={1}
            >
              {t('inbox.bulkArchive' as any) || 'Archive'}
            </Text>
          </Pressable>
        </>
      ) : null}

      <View style={[styles.separator, { backgroundColor: palette.border }]} />

      <Pressable
        testID="inbox-bulk-delete"
        accessibilityRole="button"
        accessibilityLabel={t('inbox.bulkDeleteA11y')}
        accessibilityState={{ disabled: disabled || isRefreshing }}
        disabled={disabled || isRefreshing}
        hitSlop={8}
        onPress={onDelete}
        style={({ pressed }) => [
          styles.actionButton,
          { opacity: disabled ? 0.38 : pressed ? 0.7 : 1 },
        ]}
      >
        <Ionicons
          name="trash-outline"
          size={20}
          color={disabled ? palette.textSecondary : palette.danger}
          style={styles.iconSlot}
        />
        <Text
          style={[
            styles.actionLabel,
            { color: disabled ? palette.textSecondary : palette.danger },
          ]}
          numberOfLines={1}
        >
          {t('inbox.bulkDelete')}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 16,
    right: 16,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    ...overlayLayer(10),
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.14,
    shadowRadius: 16,
    elevation: 6,
    ...Platform.select({
      web: {
        backdropFilter: 'blur(16px)',
      },
    }),
  },
  actionButton: {
    flex: 1,
    minHeight: uiMetrics.touchTarget,
    minWidth: uiMetrics.touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: 999,
  },
  iconSlot: {
    marginBottom: 2,
    height: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  separator: {
    width: StyleSheet.hairlineWidth,
    height: 24,
    opacity: 0.5,
  },
});
