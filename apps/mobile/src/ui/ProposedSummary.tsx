/**
 * The AI summary rendered as a *proposed note*, sitting directly under the note
 * field on the Bookmark Detail screen. It is deliberately its own dashed,
 * clearly-labeled ghost block — never poured into the note input — so it can't
 * be mistaken for user-authored text. This is the sacred-fields principle made
 * visual: the generated summary stays in this container until the user
 * explicitly chooses it.
 *
 * Google PAIR AI Smart Assist & Attribution Block:
 * - Lavender / violet tonal surface (#f3e8ff in light mode / #311b92 in dark mode).
 * - Explainability (출처 표기) indicator badge: e.g. [출처: 본문 H2 핵심 요약] or [도메인 기반 추천].
 * - Non-destructive note merge contract: Empty note fills ("Use as note"), existing note appends
 *   ("Add to note") without overwriting user-authored text.
 * - One-tap tag adoption interaction chips if passed.
 *
 * Accept is conflict-safe: an empty note is *filled* ("Use as note"); a note
 * that already has text is *appended to* ("Add to note"), never overwritten. The
 * caller owns that write (and the durable "reviewed" bookkeeping); this
 * component only decides which label to show and fires the callbacks.
 */
import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { PostHogMaskView } from 'posthog-react-native';

import { useT } from '@/i18n';
import type { TFunction } from '@/i18n/translate';

export interface ProposedSummaryMetadata {
  /** Source or origin of the summary/suggestions, e.g. 'content_h2', 'domain_heuristic', 'model' */
  source?: 'content_h2' | 'domain_heuristic' | 'model' | string;
  /** True when generated via heuristic fallback rather than full model */
  degraded?: boolean;
  /** The model identifier, e.g. 'gemini-1.5-flash' */
  model?: string | null;
  /** Explicit attribution string (e.g. '[출처: 본문 H2 핵심 요약]') */
  attribution?: string;
}

export interface ProposedTagItem {
  name: string;
  confidence?: number;
}

export interface ProposedSummaryProps {
  summary: string;
  /**
   * True when the note is empty, so accept *fills* it ("Use as note"); false
   * relabels to "Add to note" (append) to signal the non-destructive path.
   * Can be omitted if `existingNote` is provided.
   */
  noteEmpty?: boolean;
  /**
   * Optional existing note value. If provided and noteEmpty is omitted,
   * noteEmpty is derived as `existingNote.trim() === ''`.
   */
  existingNote?: string;
  busy: boolean;
  onUse: () => void;
  onDismiss: () => void;
  /**
   * Override the default accessibility labels below. Detail shows one
   * bookmark per screen, so the default (title-less) labels are unambiguous;
   * Review can show several summary cards at once and passes labels naming
   * the bookmark instead.
   */
  useA11yLabel?: string;
  dismissA11yLabel?: string;
  /**
   * Metadata describing the origin of the AI generation, used to derive the
   * Explainability (출처 표기) badge.
   */
  metadata?: ProposedSummaryMetadata;
  /**
   * Explicit attribution string to display in the Explainability indicator badge.
   * Takes precedence over metadata-derived label if supplied.
   */
  attribution?: string;
  /** Alias for attribution */
  sourceBadge?: string;
  /**
   * Suggested tags or chips to adopt with one tap.
   * Accepts string[] or ProposedTagItem[] / SuggestedTag[].
   */
  tags?: Array<string | ProposedTagItem>;
  suggestedTags?: Array<string | ProposedTagItem>;
  /**
   * Callback fired when a tag chip is tapped.
   */
  onAdoptTag?: (tagName: string) => void;
  /**
   * Optional callback fired with the non-destructively merged note text when accepted.
   */
  onMergeNote?: (mergedNote: string) => void;
}

/**
 * Non-destructive note merge helper enforcing the Google PAIR / sacred-fields contract:
 * - Empty note fills ("Use as note").
 * - Existing note appends with two newlines ("Add to note"), never overwriting user-authored text.
 */
export function mergeNoteSafely(
  existingNote: string | null | undefined,
  summaryToAppend: string,
): string {
  const trimmedSummary = summaryToAppend.trim();
  if (!trimmedSummary) {
    return existingNote?.trim() ?? '';
  }
  const trimmedExisting = existingNote?.trim() ?? '';
  if (!trimmedExisting) {
    return trimmedSummary;
  }
  return `${trimmedExisting}\n\n${trimmedSummary}`;
}

/**
 * Derives the Explainability indicator badge label based on metadata or explicit attribution.
 */
export function deriveAttributionBadge(
  metadata?: ProposedSummaryMetadata,
  explicitAttribution?: string,
  t?: TFunction,
): string {
  if (explicitAttribution) {
    return explicitAttribution.startsWith('[') && explicitAttribution.endsWith(']')
      ? explicitAttribution
      : `[${explicitAttribution}]`;
  }
  if (metadata?.attribution) {
    return metadata.attribution.startsWith('[') && metadata.attribution.endsWith(']')
      ? metadata.attribution
      : `[${metadata.attribution}]`;
  }
  if (metadata?.degraded || metadata?.source === 'domain_heuristic') {
    const text = t ? t('detail.summarySourceDomain') : '도메인 기반 추천';
    return `[${text}]`;
  }
  if (metadata?.source === 'content_h2') {
    const text = t ? t('detail.summarySourceContentH2') : '출처: 본문 H2 핵심 요약';
    return `[${text}]`;
  }
  if (metadata?.model) {
    const prefix = t ? t('detail.summarySourcePrefix') : '출처';
    return `[${prefix}: ${metadata.model}]`;
  }
  if (metadata?.source) {
    return `[${metadata.source}]`;
  }
  const text = t ? t('detail.summarySourceContentH2') : '출처: 본문 H2 핵심 요약';
  return `[${text}]`;
}

export function ProposedSummary({
  summary,
  noteEmpty,
  existingNote,
  busy,
  onUse,
  onDismiss,
  useA11yLabel,
  dismissA11yLabel,
  metadata,
  attribution,
  sourceBadge,
  tags,
  suggestedTags,
  onAdoptTag,
  onMergeNote,
}: ProposedSummaryProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const t = useT();

  const isNoteEmpty =
    noteEmpty ?? (existingNote !== undefined ? existingNote.trim() === '' : true);
  const useLabel = isNoteEmpty ? t('detail.summaryUseAsNote') : t('detail.summaryAppendToNote');
  const useA11y =
    useA11yLabel ?? (isNoteEmpty ? t('detail.summaryUseAsNoteA11y') : t('detail.summaryAppendToNoteA11y'));
  const dismissA11y = dismissA11yLabel ?? t('detail.summaryDismissA11y');

  const badgeText = deriveAttributionBadge(metadata, attribution ?? sourceBadge, t);

  const rawTags = tags ?? suggestedTags ?? [];
  const tagList: ProposedTagItem[] = rawTags.map((item) =>
    typeof item === 'string' ? { name: item } : item,
  );

  // Soft sparkle / lavender tonal surface tokens
  const colors = {
    surface: isDark ? '#311b92' : '#f3e8ff',
    border: isDark ? '#6d28d9' : '#d8b4fe',
    bodyText: isDark ? '#f5f3ff' : '#1e1b4b',
    headerText: isDark ? '#ddd6fe' : '#6b21a8',
    sparkleIcon: isDark ? '#c084fc' : '#7e22ce',
    badgeBg: isDark ? '#4527a0' : '#ede9fe',
    badgeBorder: isDark ? '#7c3aed' : '#c084fc',
    badgeText: isDark ? '#e9d5ff' : '#6b21a8',
    tagSectionLabel: isDark ? '#c4b5fd' : '#7e22ce',
    tagChipBg: isDark ? '#3b1d82' : '#ffffff',
    tagChipBorder: isDark ? '#7c3aed' : '#d8b4fe',
    tagChipText: isDark ? '#e9d5ff' : '#6b21a8',
    useBtnBg: isDark ? '#6d28d9' : '#7e22ce',
    useBtnBorder: isDark ? '#7c3aed' : '#6b21a8',
    dismissText: isDark ? '#c4b5fd' : '#7e22ce',
  };

  const handleUse = () => {
    onUse();
    if (onMergeNote) {
      onMergeNote(mergeNoteSafely(existingNote, summary));
    }
  };

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
    >
      {/* Header Row: Sparkle Icon + Title + Explainability Badge */}
      <View style={styles.headerRow}>
        <View style={styles.headerTitleGroup}>
          <Ionicons
            name="sparkles"
            size={14}
            color={colors.sparkleIcon}
            style={styles.sparkleIcon}
          />
          <Text style={[styles.label, { color: colors.headerText }]}>
            {t('detail.summaryLabel')}
          </Text>
        </View>

        {badgeText ? (
          <View
            style={[
              styles.badge,
              { backgroundColor: colors.badgeBg, borderColor: colors.badgeBorder },
            ]}
            accessibilityRole="text"
            accessibilityLabel={badgeText}
          >
            <Text style={[styles.badgeText, { color: colors.badgeText }]}>
              {badgeText}
            </Text>
          </View>
        ) : null}
      </View>

      {/* Accessible summary body masked for PostHog replay recordings */}
      <View
        accessible
        accessibilityLabel={`${t('detail.summaryLabel')} ${badgeText}: ${summary}`}
      >
        <PostHogMaskView>
          <Text style={[styles.body, { color: colors.bodyText }]}>{summary}</Text>
        </PostHogMaskView>
      </View>

      {/* One-tap tag adoption interaction chips */}
      {tagList.length > 0 ? (
        <View style={styles.tagSection}>
          <View style={styles.tagHeader}>
            <Ionicons
              name="pricetag-outline"
              size={12}
              color={colors.tagSectionLabel}
            />
            <Text style={[styles.tagSectionLabel, { color: colors.tagSectionLabel }]}>
              {t('detail.summarySuggestedTags')}
            </Text>
          </View>
          <View style={styles.tagChips}>
            {tagList.map((tag) => (
              <Pressable
                key={tag.name}
                accessibilityRole="button"
                accessibilityLabel={t('detail.summaryAdoptTagA11y', { name: tag.name })}
                disabled={busy}
                style={({ pressed }) => [
                  styles.tagChip,
                  {
                    backgroundColor: colors.tagChipBg,
                    borderColor: colors.tagChipBorder,
                    opacity: busy ? 0.6 : pressed ? 0.78 : 1,
                  },
                ]}
                onPress={() => onAdoptTag?.(tag.name)}
              >
                <Ionicons
                  name="add"
                  size={13}
                  color={colors.tagChipText}
                  style={styles.tagChipAddIcon}
                />
                <Text style={[styles.tagChipLabel, { color: colors.tagChipText }]}>
                  {`#${tag.name}`}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {/* Non-destructive Action Buttons */}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={useA11y}
          disabled={busy}
          style={({ pressed }) => [
            styles.useButton,
            {
              backgroundColor: colors.useBtnBg,
              borderColor: colors.useBtnBorder,
              opacity: busy ? 0.6 : pressed ? 0.8 : 1,
            },
          ]}
          onPress={handleUse}
        >
          <Ionicons
            name={isNoteEmpty ? 'document-text-outline' : 'add-circle-outline'}
            size={14}
            color="#ffffff"
            style={styles.useButtonIcon}
          />
          <Text style={styles.useLabel}>{useLabel}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={dismissA11y}
          disabled={busy}
          hitSlop={8}
          style={({ pressed }) => [
            styles.dismiss,
            { opacity: busy ? 0.6 : pressed ? 0.7 : 1 },
          ]}
          onPress={onDismiss}
        >
          <Text style={[styles.dismissLabel, { color: colors.dismissText }]}>
            {t('detail.summaryDismiss')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: 16,
    borderStyle: 'dashed',
    padding: 14,
    gap: 10,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
  },
  headerTitleGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  sparkleIcon: {
    marginRight: -2,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  badge: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
  },
  tagSection: {
    marginTop: 2,
    gap: 6,
  },
  tagHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  tagSectionLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  tagChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  tagChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 10,
    gap: 4,
  },
  tagChipAddIcon: {
    marginRight: -2,
  },
  tagChipLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 14,
    marginTop: 4,
  },
  useButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 14,
    gap: 6,
  },
  useButtonIcon: {
    marginRight: -2,
  },
  useLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ffffff',
  },
  dismiss: {
    paddingVertical: 8,
    paddingHorizontal: 6,
  },
  dismissLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
});
