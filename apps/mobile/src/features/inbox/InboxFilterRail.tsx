import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { InboxFilter } from '@/domain/filter';
import type { ViewMode } from '@/domain/view-mode';
import { VIEW_MODE_ICON, VIEW_MODE_LABEL_KEY } from '@/features/inbox/layout';
import type { TFunction } from '@/i18n/translate';
import { uiMetrics, usePalette } from '@/theme';

export interface InboxFilterRailProps {
  filter: InboxFilter;
  activeChip?: { label: string };
  scopeMenuOpen: boolean;
  setScopeMenuOpen: (open: boolean) => void;
  setSortMenuOpen: (open: boolean) => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  isLoading: boolean;
  viewOptionsReady: boolean;
  contentMaxWidth: number;
  t: TFunction;
  onViewModeChange?: (mode: ViewMode) => void;
}

export function InboxFilterRail({
  filter,
  activeChip,
  scopeMenuOpen,
  setScopeMenuOpen,
  setSortMenuOpen,
  viewMode,
  setViewMode,
  isLoading,
  viewOptionsReady,
  contentMaxWidth,
  t,
  onViewModeChange,
}: InboxFilterRailProps) {
  const palette = usePalette();

  return (
    <View testID="inbox-filter-options-row" style={[styles.filterOptionsRow, { maxWidth: contentMaxWidth }]}>
      <Pressable
        testID="inbox-scope-picker"
        accessibilityRole="button"
        accessibilityLabel={t('inbox.scopePickerA11y')}
        accessibilityState={{
          expanded: viewMode === 'folder' ? false : scopeMenuOpen,
          disabled: viewMode === 'folder' || isLoading,
        }}
        disabled={viewMode === 'folder' || isLoading}
        onPress={() => setScopeMenuOpen(true)}
        style={[
          styles.scopePicker,
          {
            backgroundColor: palette.card,
            borderColor: palette.controlBorder,
            opacity: viewMode === 'folder' || isLoading ? 0.5 : 1,
          },
        ]}
      >
        <Ionicons
          name="folder-outline"
          size={14}
          color={palette.textSecondary}
        />
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          style={[styles.viewOptionsLabel, { color: palette.text }]}
        >
          {viewMode === 'folder' || filter.kind === 'all'
            ? t('inbox.filterAll')
            : filter.kind === 'uncollected'
              ? t('inbox.filterNoCollection')
              : activeChip?.label ?? t('inbox.filterAll')}
        </Text>
        {viewMode !== 'folder' ? (
          <Ionicons name="chevron-down" size={14} color={palette.textSecondary} />
        ) : null}
      </Pressable>

      <View testID="inbox-view-actions" style={styles.viewActions}>
        <View
          testID="inbox-view-mode-control"
          style={[styles.viewModeControl, { backgroundColor: palette.surface, borderColor: palette.border }]}
        >
          {(['card', 'list', 'folder'] as const).map((mode) => (
            <Pressable
              key={mode}
              testID={`inbox-view-${mode}`}
              accessibilityRole="button"
              accessibilityLabel={t(VIEW_MODE_LABEL_KEY[mode])}
              accessibilityState={{ selected: viewMode === mode, disabled: isLoading || !viewOptionsReady }}
              disabled={isLoading || !viewOptionsReady}
              onPress={() => {
                setViewMode(mode);
                onViewModeChange?.(mode);
              }}
              style={({ pressed }) => [
                styles.viewModeButton,
                {
                  backgroundColor: viewMode === mode ? palette.mutedSurface : 'transparent',
                  opacity: pressed || isLoading || !viewOptionsReady ? 0.6 : 1,
                },
              ]}
            >
              <Ionicons
                name={VIEW_MODE_ICON[mode]}
                size={16}
                color={viewMode === mode ? palette.text : palette.textSecondary}
              />
            </Pressable>
          ))}
        </View>
        <Pressable
          testID="inbox-view-options"
          accessibilityRole="button"
          accessibilityLabel={t('inbox.viewOptions')}
          accessibilityState={{ disabled: isLoading || !viewOptionsReady }}
          disabled={isLoading || !viewOptionsReady}
          onPress={() => setSortMenuOpen(true)}
          style={styles.viewOptions}
        >
          <Ionicons name="ellipsis-horizontal" size={18} color={palette.textSecondary} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  filterOptionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: uiMetrics.screenGutter,
    paddingVertical: 8,
    gap: 8,
    width: '100%',
    alignSelf: 'center',
  },
  scopePicker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 34,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  viewOptionsLabel: {
    fontSize: 13,
    fontWeight: '600',
    flexShrink: 1,
  },
  viewActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: 4,
  },
  viewModeControl: {
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    padding: 3,
  },
  viewModeButton: {
    width: 38,
    minHeight: 34,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewOptions: {
    width: 40,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
