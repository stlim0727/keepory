import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  PixelRatio,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { PostHogMaskView } from 'posthog-react-native';

import { usePalette, uiMetrics } from '@/theme';
import { Chip } from '@/ui/Chip';
import { ShelfEdge, useShelfEdges } from '@/ui/ShelfEdges';
import { useT } from '@/i18n';
import type { SearchSuggestion } from '@/domain/search-suggestions';

/** Reveal/dismiss timings (ms), per the design spec §6. */
const REVEAL_MS = 140;
const DISMISS_MS = 120;

const LABEL_FONT_SIZE = 14;
const LABEL_WEIGHT = Platform.select({ web: '600', default: '700' }) as '600' | '700';
const LABEL_LINE_RATIO = 1.57;

/** Soft purple sparkle tokens for AI Assist chips (Google PAIR / M3 Expressive). */
const SPARKLE_THEME = {
  light: {
    background: '#f3e8ff',
    border: '#e9d5ff',
    text: '#5b21b6',
  },
  dark: {
    background: '#311b92',
    border: '#4c1d95',
    text: '#e9d5ff',
  },
} as const;

/** The leading glyph for each chip family. */
const KIND_ICON = {
  recent: 'time-outline',
  folder: 'folder-outline',
  status: 'funnel-outline',
  assist: 'sparkles',
  tag: undefined,
} as const;

export type ChipFamily = 'filter' | 'assist' | 'suggestion';

/**
 * Categorize a search suggestion into one of three visual families:
 * - Filter: folders / status facets (filled tonal background)
 * - AI Assist: smart unread summaries or suggestions (soft purple sparkle container)
 * - Suggestion: recents / tags (outlined / mutedSurface with clock or tag glyph)
 */
export function getChipFamily(suggestion: SearchSuggestion): ChipFamily {
  if (suggestion.family) {
    return suggestion.family;
  }
  if (suggestion.kind === 'folder' || suggestion.kind === 'status') {
    return 'filter';
  }
  if (suggestion.kind === 'assist') {
    return 'assist';
  }
  return 'suggestion';
}

export interface SearchAnchorProps {
  /** The current search query string */
  query?: string;
  /** Value alias for controlled usage */
  value?: string;
  /** Callback fired when query changes */
  onChangeQuery?: (query: string) => void;
  /** Callback alias for onChangeQuery */
  onChangeText?: (text: string) => void;
  /** Callback when search is submitted */
  onSubmit?: (query: string) => void;
  /** Callback alias for onSubmit */
  onSubmitEditing?: () => void;
  /** Callback when input is cleared */
  onClear?: () => void;
  /** Callback on input focus */
  onFocus?: () => void;
  /** Callback on input blur */
  onBlur?: () => void;
  /** Callback when anchor is pressed in non-editable / button mode */
  onPress?: () => void;
  /** Placeholder text */
  placeholder?: string;
  /** Keyboard shortcut badge text (default: '⌘ K') */
  shortcutBadge?: string;
  /** Ref to the internal TextInput */
  inputRef?: React.Ref<React.ComponentRef<typeof TextInput>>;
  /** Test ID for the anchor container */
  testID?: string;
  /** Container style */
  style?: StyleProp<ViewStyle>;
  /** Content max-width */
  maxWidth?: number;
  /** Whether the input is editable */
  editable?: boolean;
  /** External focus state override */
  focused?: boolean;
}

/**
 * Material 3 Pill Search Anchor Bar.
 *
 * Implements the M3 Search Anchor specification with `radius: 999`, subtle
 * tonal border, search icon, keyboard shortcut badge (`⌘ K`), and clear action.
 */
export function SearchAnchor({
  query: queryProp,
  value,
  onChangeQuery,
  onChangeText,
  onSubmit,
  onSubmitEditing,
  onClear,
  onFocus,
  onBlur,
  onPress,
  placeholder,
  shortcutBadge = '⌘ K',
  inputRef,
  testID = 'search-anchor',
  style,
  maxWidth,
  editable = true,
  focused: focusedProp,
}: SearchAnchorProps) {
  const palette = usePalette();
  const t = useT();
  const [internalFocused, setInternalFocused] = useState(false);
  const [internalQuery, setInternalQuery] = useState('');
  const isFocused = focusedProp ?? internalFocused;
  const isControlled = queryProp !== undefined || value !== undefined;
  const currentQuery = isControlled ? (queryProp ?? value ?? '') : internalQuery;

  const handleChange = (text: string) => {
    if (!isControlled) {
      setInternalQuery(text);
    }
    onChangeQuery?.(text);
    onChangeText?.(text);
  };

  const handleSubmit = () => {
    onSubmit?.(currentQuery);
    onSubmitEditing?.();
  };

  const handleClear = () => {
    if (!isControlled) {
      setInternalQuery('');
    }
    if (onClear) {
      onClear();
    } else {
      handleChange('');
    }
  };

  const handleFocus = () => {
    setInternalFocused(true);
    onFocus?.();
  };

  const handleBlur = () => {
    setInternalFocused(false);
    onBlur?.();
  };

  const resolvedPlaceholder = placeholder ?? t('inbox.searchPlaceholder');

  return (
    <View
      testID={testID}
      style={[
        styles.anchorContainer,
        {
          backgroundColor: palette.surface,
          borderColor: isFocused ? palette.accent : palette.border,
        },
        maxWidth ? { maxWidth } : null,
        style,
      ]}
    >
      <Pressable
        testID="search-anchor-icon-button"
        onPress={onPress}
        disabled={!onPress}
        accessibilityRole={onPress ? 'button' : undefined}
        accessibilityLabel={resolvedPlaceholder}
        style={styles.anchorIconBtn}
      >
        <Ionicons
          name="search"
          size={18}
          color={isFocused ? palette.accent : palette.textSecondary}
          testID="search-anchor-icon"
        />
      </Pressable>
      <TextInput
        ref={inputRef}
        testID="search-anchor-input"
        accessibilityRole="search"
        accessibilityLabel={resolvedPlaceholder}
        value={currentQuery}
        onChangeText={handleChange}
        onSubmitEditing={handleSubmit}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder={resolvedPlaceholder}
        placeholderTextColor={palette.textSecondary}
        selectionColor={palette.accent}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        editable={editable}
        style={[
          styles.anchorInput,
          {
            color: palette.text,
          },
        ]}
      />
      {currentQuery.length > 0 ? (
        <Pressable
          testID="search-anchor-clear"
          accessibilityRole="button"
          accessibilityLabel={t('inbox.searchCloseA11y')}
          onPress={handleClear}
          hitSlop={8}
          style={styles.anchorClearBtn}
        >
          <Ionicons name="close-circle" size={16} color={palette.textSecondary} />
        </Pressable>
      ) : null}
      {shortcutBadge ? (
        <View
          testID="search-anchor-shortcut-badge"
          style={[
            styles.shortcutBadge,
            {
              backgroundColor: palette.mutedSurface,
              borderColor: palette.border,
            },
          ]}
        >
          <Text
            style={[
              styles.shortcutBadgeText,
              {
                color: palette.textSecondary,
              },
            ]}
          >
            {shortcutBadge}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export interface SearchSuggestionShelfProps {
  suggestions: SearchSuggestion[];
  /** Align the shelf to the same centered content rail as the open search field. */
  maxWidth?: number;
  /** Tap: fill the query (recent) or apply a facet (tag/folder). See §5. */
  onPick: (suggestion: SearchSuggestion) => void;
  /** Long-press a recent chip to remove just that entry (Phase-1 Q2). */
  onRemoveRecent?: (suggestion: SearchSuggestion) => void;
  /**
   * The active (debounced) query, when typing. Phase 2 (§13.7): swaps the
   * ScrollView's a11y region label to announce the rail is a FILTERED set
   * matching the query, rather than the generic "Search suggestions". Empty/
   * absent in the focus-empty state, where the generic label is correct.
   */
  query?: string;
  /** Optional top search anchor pill integration */
  showAnchor?: boolean;
  /** Optional search anchor props */
  anchorProps?: SearchAnchorProps;
}

/**
 * The focused-empty search suggestion shelf: a single horizontally-scrolling row
 * of 3-tier semantic chips offering the user's recent searches, top tags, top
 * folders, and AI Assist chips.
 *
 * Visually differentiates 3 semantic chip tiers:
 * 1. Filter chips (folders / status): filled tonal background (`accentSoft`, `accentText`).
 * 2. AI Assist chips: soft purple sparkle container (`#f3e8ff` / `#311b92`, `sparkles` glyph).
 * 3. Suggestion chips (recents / tags): subtle `mutedSurface` with clock icon.
 *
 * Preserves horizontal scrolling performance, wheel-to-horizontal on web, and
 * edge chevron fades (`ShelfEdges`).
 */
export function SearchSuggestionShelf({
  suggestions,
  maxWidth,
  onPick,
  onRemoveRecent,
  query = '',
  showAnchor = false,
  anchorProps,
}: SearchSuggestionShelfProps) {
  const palette = usePalette();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const sparkleTheme = isDark ? SPARKLE_THEME.dark : SPARKLE_THEME.light;
  const t = useT();

  const opacity = useRef(new Animated.Value(0)).current;
  const { shelfRef, canLeft, canRight, updateEdges, scrollBy, isWeb } = useShelfEdges(true, [
    suggestions.length,
  ]);

  const chipLineHeight = Math.round(LABEL_FONT_SIZE * LABEL_LINE_RATIO * PixelRatio.getFontScale());

  useEffect(() => {
    const reveal = Animated.timing(opacity, {
      toValue: 1,
      duration: REVEAL_MS,
      useNativeDriver: true,
    });
    reveal.start();
    return () => {
      reveal.stop();
      Animated.timing(opacity, {
        toValue: 0,
        duration: DISMISS_MS,
        useNativeDriver: true,
      }).start();
    };
  }, [opacity]);

  return (
    <Animated.View
      testID="search-suggestion-shelf-container"
      style={[styles.container, { opacity }, maxWidth ? { maxWidth } : null]}
    >
      {showAnchor || anchorProps ? (
        <View style={styles.anchorWrapper}>
          <SearchAnchor
            maxWidth={maxWidth}
            query={query}
            {...anchorProps}
          />
        </View>
      ) : null}

      <Text
        style={[styles.affordance, { color: palette.textSecondary }]}
      >
        {t('search.shelfAffordance')}
      </Text>

      <View style={isWeb ? styles.shelfWrap : undefined}>
        <ScrollView
          ref={shelfRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          testID="search-suggestion-shelf"
          accessibilityLabel={
            query.trim() ? t('search.shelfFilteredA11y', { query: query.trim() }) : t('search.shelfA11y')
          }
          keyboardShouldPersistTaps="handled"
          onScroll={isWeb ? updateEdges : undefined}
          onLayout={isWeb ? updateEdges : undefined}
          scrollEventThrottle={isWeb ? 16 : undefined}
          style={styles.shelf}
          contentContainerStyle={styles.shelfContent}
        >
          {suggestions.map((suggestion) => {
            const family = getChipFamily(suggestion);
            const chipQuery = suggestion.query ?? suggestion.label;
            const a11yLabel =
              suggestion.kind === 'recent'
                ? t('search.recentChipA11y', { query: chipQuery })
                : suggestion.kind === 'tag'
                  ? t('search.tagChipA11y', { name: suggestion.label.replace(/^#/, '') })
                  : suggestion.kind === 'folder'
                    ? t('search.collectionChipA11y', { name: suggestion.label })
                    : suggestion.label;

            const removable = suggestion.kind === 'recent' && onRemoveRecent;

            // 1. AI Assist Chip (Google PAIR Soft Purple Sparkle Container)
            if (family === 'assist') {
              return (
                <Pressable
                  key={suggestion.key}
                  testID={`suggestion-${suggestion.kind}-${suggestion.key}`}
                  accessibilityRole="button"
                  accessibilityLabel={a11yLabel}
                  onPress={() => onPick(suggestion)}
                  style={({ pressed }) => [
                    styles.chipBase,
                    styles.assistChip,
                    {
                      backgroundColor: sparkleTheme.background,
                      borderColor: sparkleTheme.border,
                      opacity: pressed ? 0.78 : 1,
                    },
                  ]}
                >
                  <Ionicons
                    name="sparkles"
                    size={13}
                    color={sparkleTheme.text}
                    style={styles.chipIcon}
                    testID={`chip-icon-sparkles`}
                  />
                  <PostHogMaskView>
                    <Text
                      style={[
                        styles.chipLabel,
                        { color: sparkleTheme.text, lineHeight: chipLineHeight },
                      ]}
                    >
                      {suggestion.label}
                    </Text>
                  </PostHogMaskView>
                  {typeof suggestion.count === 'number' ? (
                    <Text
                      style={[
                        styles.chipCount,
                        { color: sparkleTheme.text, opacity: 0.8, lineHeight: chipLineHeight },
                      ]}
                    >
                      {`· ${suggestion.count}`}
                    </Text>
                  ) : null}
                </Pressable>
              );
            }

            // 2. Filter Chip (Filled Tonal Background: accentSoft + accentText)
            if (family === 'filter') {
              return (
                <Chip
                  key={suggestion.key}
                  testID={`suggestion-${suggestion.kind}-${suggestion.key}`}
                  accessibilityRole="button"
                  accessibilityLabel={a11yLabel}
                  variant="accent"
                  icon={KIND_ICON[suggestion.kind as keyof typeof KIND_ICON] ?? 'folder-outline'}
                  onPress={() => onPick(suggestion)}
                  count={suggestion.count}
                  style={styles.filterChip}
                  mask
                >
                  {suggestion.label}
                </Chip>
              );
            }

            // 3. Suggestion Chip (Outlined / Muted Surface with Clock or Tag glyph)
            return (
              <Chip
                key={suggestion.key}
                testID={`suggestion-${suggestion.kind}-${suggestion.key}`}
                accessibilityRole="button"
                accessibilityLabel={a11yLabel}
                accessibilityActions={
                  removable ? [{ name: 'delete', label: t('search.removeRecentA11y', { query: chipQuery }) }] : undefined
                }
                onAccessibilityAction={
                  removable
                    ? (event) => {
                        if (event.nativeEvent.actionName === 'delete') {
                          onRemoveRecent!(suggestion);
                        }
                      }
                    : undefined
                }
                variant="default"
                icon={suggestion.kind === 'recent' ? 'time-outline' : undefined}
                onPress={() => onPick(suggestion)}
                onLongPress={removable ? () => onRemoveRecent!(suggestion) : undefined}
                count={suggestion.count}
                style={[
                  styles.suggestionChip,
                  {
                    backgroundColor: palette.mutedSurface,
                    borderColor: palette.border,
                  },
                ]}
                mask
              >
                {suggestion.label}
              </Chip>
            );
          })}
        </ScrollView>
        {isWeb && canLeft ? (
          <ShelfEdge side="left" label={t('inbox.shelfPrevA11y')} onPress={() => scrollBy(-1)} />
        ) : null}
        {isWeb && canRight ? (
          <ShelfEdge side="right" label={t('inbox.shelfMoreA11y')} onPress={() => scrollBy(1)} />
        ) : null}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    alignSelf: 'center',
  },
  anchorWrapper: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 4,
    width: '100%',
    alignSelf: 'center',
  },
  anchorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    alignSelf: 'center',
    borderRadius: 999, // M3 pill shape
    borderWidth: 1,
    minHeight: 48,
    paddingHorizontal: 16,
    gap: 10,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  anchorIconBtn: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  anchorInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    fontSize: 15,
    paddingVertical: Platform.select({ ios: 8, default: 4 }),
    paddingHorizontal: 0,
  },
  anchorClearBtn: {
    padding: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shortcutBadge: {
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shortcutBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
  },
  shelfWrap: {
    position: 'relative',
  },
  affordance: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    marginTop: 8,
  },
  shelf: {
    flexGrow: 0,
    minHeight: 42,
    marginTop: 4,
    marginBottom: 0,
  },
  shelfContent: {
    paddingHorizontal: 16,
    alignItems: 'center',
    minHeight: 42,
    gap: 8,
  },
  filterChip: {
    borderRadius: 999,
  },
  suggestionChip: {
    borderRadius: 999,
  },
  chipBase: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    minHeight: 34,
    minWidth: uiMetrics.touchTarget,
    paddingVertical: 6,
    paddingHorizontal: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  assistChip: {
    borderWidth: 1,
  },
  chipIcon: {
    marginRight: 5,
  },
  chipLabel: {
    fontSize: LABEL_FONT_SIZE,
    fontWeight: LABEL_WEIGHT,
  },
  chipCount: {
    fontSize: LABEL_FONT_SIZE,
    fontWeight: Platform.select({ web: '500', default: '600' }) as '500' | '600',
    marginLeft: 5,
  },
});
