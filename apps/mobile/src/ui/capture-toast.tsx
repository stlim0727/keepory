import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PostHogMaskView } from 'posthog-react-native';

import { usePalette } from '@/theme';
import { overlayLayer } from '@/ui/layering';

// A plain confirmation auto-dismisses quickly; one carrying tap targets stays
// up longer so there is ample time to reach for them before it slides away.
const TOAST_VISIBLE_MS = 2500;
const TOAST_WITH_ACTION_VISIBLE_MS = 6000;
const AUTO_ADVANCE_DELAY_MS = 1400;

// Google M3 Expressive Sparkle tokens
const SPARKLE_PURPLE_LIGHT = '#7c4dff';
const SPARKLE_PURPLE_DARK = '#b388ff';
const SPARKLE_SOFT_LIGHT = '#f3e8ff';
const SPARKLE_SOFT_DARK = '#311b92';

/** An optional inline tap target or action chip (e.g. "[ 📂 Move to Folder ]", "[ ✎ Add Note ]", "[ View ↗ ]"). */
export interface CaptureToastAction {
  label: string;
  onPress: () => void;
  icon?: string;
  trailingIcon?: string;
  testID?: string;
}

export type CaptureToastPhase = 'saved' | 'enriching' | 'idle';

export interface CaptureToastOptions {
  action?: CaptureToastAction;
  actions?: CaptureToastAction[];
  phase?: CaptureToastPhase;
  status?: CaptureToastPhase;
  /** Whether to auto-advance from 'saved' to 'enriching' */
  autoAdvance?: boolean;
  /** Delay in ms before advancing to 'enriching' (default: 1400) */
  enrichDelayMs?: number;
  /** Custom duration in ms */
  durationMs?: number;
  /** Quick action shortcuts */
  onMoveToFolder?: () => void;
  onAddNote?: () => void;
  onView?: () => void;
  /**
   * Critical Invariant: "Capture is sacred".
   * Dismissal or toast animation must NEVER discard or interrupt optimistic
   * durable SQLite persistence. Passing `persisted` allows UI tracking without
   * ever disrupting the underlying write.
   */
  persisted?: Promise<boolean>;
}

export interface CaptureToastContextValue {
  /**
   * Show a short confirmation toast. Pass `action` or `options` to add inline
   * action chips, customize 3-phase capture status, or provide quick actions.
   */
  show: (message: string, actionOrOptions?: CaptureToastAction | CaptureToastOptions) => void;
  /**
   * Refined 3-phase status UI helper:
   * - Saved state: `✓ Saved locally` (green checkmark, peace of mind)
   * - Enriching state: `✨ AI Analyzing...` (soft purple progress indicator)
   * - Action chips: Quick actions `[ 📂 Move to Folder ]`, `[ ✎ Add Note ]`, `[ View ↗ ]`
   */
  showCapturePhase: (
    phase: 'saved' | 'enriching',
    options?: {
      message?: string;
      actions?: CaptureToastAction[];
      onMoveToFolder?: () => void;
      onAddNote?: () => void;
      onView?: () => void;
      autoAdvance?: boolean;
      persisted?: Promise<boolean>;
    },
  ) => void;
  /** Dismiss the toast overlay. Never disrupts background persistence. */
  dismiss: () => void;
  /** Whether a toast is currently visible. */
  isVisible: boolean;
}

const CaptureToastContext = createContext<CaptureToastContextValue | null>(null);

interface ToastState {
  id: number;
  message: string;
  phase: CaptureToastPhase;
  actions: CaptureToastAction[];
  hasMultipleActions: boolean;
  autoAdvance?: boolean;
  enrichDelayMs?: number;
  durationMs?: number;
}

function normalizeAction(action: CaptureToastAction): CaptureToastAction {
  // If label is "View", add default trailing "↗" if no icons specified
  if (action.label === 'View' && !action.icon && !action.trailingIcon) {
    return { ...action, trailingIcon: '↗' };
  }
  if (action.label === 'Move to Folder' && !action.icon) {
    return { ...action, icon: '📂' };
  }
  if (action.label === 'Add Note' && !action.icon) {
    return { ...action, icon: '✎' };
  }
  return action;
}

function normalizeActions(actionOrOptions?: CaptureToastAction | CaptureToastOptions): CaptureToastAction[] {
  if (!actionOrOptions) {
    return [];
  }
  if ('onPress' in actionOrOptions && typeof actionOrOptions.onPress === 'function') {
    return [normalizeAction(actionOrOptions)];
  }
  const opts = actionOrOptions as CaptureToastOptions;
  const list: CaptureToastAction[] = [];
  if (opts.actions && opts.actions.length > 0) {
    list.push(...opts.actions.map(normalizeAction));
  } else if (opts.action) {
    list.push(normalizeAction(opts.action));
  }
  if (opts.onMoveToFolder) {
    list.push(normalizeAction({ label: 'Move to Folder', icon: '📂', onPress: opts.onMoveToFolder }));
  }
  if (opts.onAddNote) {
    list.push(normalizeAction({ label: 'Add Note', icon: '✎', onPress: opts.onAddNote }));
  }
  if (opts.onView) {
    list.push(normalizeAction({ label: 'View', trailingIcon: '↗', onPress: opts.onView }));
  }
  return list;
}

function inferPhase(message: string, explicitPhase?: CaptureToastPhase): CaptureToastPhase {
  if (explicitPhase && explicitPhase !== 'idle') {
    return explicitPhase;
  }
  const lower = message.toLowerCase();
  if (message.includes('✨') || lower.includes('analyzing') || lower.includes('분석')) {
    return 'enriching';
  }
  if (message.includes('✓') || lower.includes('saved') || lower.includes('저장')) {
    return 'saved';
  }
  return 'idle';
}

/**
 * M3 Expressive Capture Toast Provider:
 *
 * Renders a floating pill snackbar (`radius: 999` or `radius: 16` rounded container)
 * floating above the screen bottom with smooth spring motion.
 *
 * Features 3-phase status UI:
 * 1. Saved state: `✓ Saved locally` (green checkmark, peace of mind)
 * 2. Enriching state: `✨ AI Analyzing...` (soft purple progress indicator)
 * 3. Action chips: Quick actions `[ 📂 Move to Folder ]`, `[ ✎ Add Note ]`, `[ View ↗ ]`
 *
 * Critical Invariant: "Capture is sacred" — dismissal, auto-advance, or action chip taps
 * must NEVER discard, abort, or interrupt optimistic durable SQLite persistence.
 */
export function CaptureToastProvider({ children }: { children: ReactNode }) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const isDark = palette.text === '#f7f6f2';

  const [toast, setToast] = useState<ToastState | null>(null);
  const toastRef = useRef<ToastState | null>(null);
  toastRef.current = toast;

  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(18)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextToastId = useRef(1);

  const dismiss = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    if (advanceTimer.current) {
      clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
    const dismissId = toastRef.current?.id;
    opacity.stopAnimation();
    translateY.stopAnimation();
    Animated.parallel([
      Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 14, duration: 180, useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (finished && dismissId !== undefined) {
        setToast((current) => (current && current.id === dismissId ? null : current));
      }
    });
  }, [opacity, translateY]);

  const show = useCallback(
    (message: string, actionOrOptions?: CaptureToastAction | CaptureToastOptions) => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      if (advanceTimer.current) {
        clearTimeout(advanceTimer.current);
        advanceTimer.current = null;
      }
      opacity.stopAnimation();
      translateY.stopAnimation();

      const actions = normalizeActions(actionOrOptions);
      const isOptions =
        actionOrOptions && !('onPress' in actionOrOptions && typeof actionOrOptions.onPress === 'function');
      const opts = isOptions ? (actionOrOptions as CaptureToastOptions) : undefined;
      const phase = inferPhase(message, opts?.phase ?? opts?.status);
      const hasMultipleActions = actions.length > 1;

      // Invariant: "Capture is sacred" — monitor persistence safely if provided
      if (opts?.persisted) {
        void opts.persisted.catch(() => false);
      }

      setToast({
        id: nextToastId.current++,
        message,
        phase,
        actions,
        hasMultipleActions,
        autoAdvance: opts?.autoAdvance,
        enrichDelayMs: opts?.enrichDelayMs,
        durationMs: opts?.durationMs,
      });
    },
    [opacity, translateY],
  );

  const showCapturePhase = useCallback(
    (
      phase: 'saved' | 'enriching',
      options?: {
        message?: string;
        actions?: CaptureToastAction[];
        onMoveToFolder?: () => void;
        onAddNote?: () => void;
        onView?: () => void;
        autoAdvance?: boolean;
        persisted?: Promise<boolean>;
      },
    ) => {
      const defaultMessage = phase === 'saved' ? 'Saved locally' : 'AI Analyzing...';
      const message = options?.message ?? defaultMessage;
      show(message, {
        phase,
        actions: options?.actions,
        onMoveToFolder: options?.onMoveToFolder,
        onAddNote: options?.onAddNote,
        onView: options?.onView,
        autoAdvance: options?.autoAdvance ?? (phase === 'saved'),
        persisted: options?.persisted,
      });
    },
    [show],
  );

  useEffect(() => {
    if (!toast) {
      return;
    }

    opacity.setValue(0);
    translateY.setValue(18);

    // Smooth spring entrance motion
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: 0, tension: 75, friction: 8, useNativeDriver: true }),
    ]).start();

    // Enriching progress indicator animation
    if (toast.phase === 'enriching') {
      progressAnim.setValue(0);
      Animated.loop(
        Animated.sequence([
          Animated.timing(progressAnim, { toValue: 1, duration: 1800, useNativeDriver: false }),
          Animated.timing(progressAnim, { toValue: 0, duration: 0, useNativeDriver: false }),
        ]),
      ).start();
    }

    // Auto-advance from 'saved' to 'enriching' if requested
    if (toast.phase === 'saved' && toast.autoAdvance) {
      advanceTimer.current = setTimeout(() => {
        setToast((current) => {
          if (!current || current.id !== toast.id) {
            return current;
          }
          return {
            ...current,
            phase: 'enriching',
            message:
              current.message === 'Saved locally' || current.message.includes('저장')
                ? 'AI Analyzing...'
                : current.message,
          };
        });
      }, toast.enrichDelayMs ?? AUTO_ADVANCE_DELAY_MS);
    }

    // Auto-dismiss schedule
    const hasActions = toast.actions.length > 0;
    const defaultVisibleTime = hasActions ? TOAST_WITH_ACTION_VISIBLE_MS : TOAST_VISIBLE_MS;
    const visibleFor = toast.durationMs ?? defaultVisibleTime;
    const currentToastId = toast.id;

    hideTimer.current = setTimeout(() => {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 14, duration: 180, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) {
          setToast((current) => (current && current.id === currentToastId ? null : current));
        }
      });
    }, visibleFor);

    return () => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
      }
      if (advanceTimer.current) {
        clearTimeout(advanceTimer.current);
      }
    };
  }, [toast?.id, toast?.phase, opacity, translateY, progressAnim, toast?.autoAdvance, toast?.actions.length, toast?.durationMs, toast?.enrichDelayMs]);

  const handleActionPress = useCallback(
    (action: CaptureToastAction) => {
      // Critical Invariant: "Capture is sacred" — action execution must never abort persistence
      action.onPress();
      dismiss();
    },
    [dismiss],
  );

  const hasMultipleActions = toast?.hasMultipleActions ?? false;
  const singleAction = !hasMultipleActions && toast?.actions.length === 1 ? toast.actions[0] : null;
  const sparkleColor = isDark ? SPARKLE_PURPLE_DARK : SPARKLE_PURPLE_LIGHT;
  const sparkleSoft = isDark ? SPARKLE_SOFT_DARK : SPARKLE_SOFT_LIGHT;

  return (
    <CaptureToastContext.Provider value={{ show, showCapturePhase, dismiss, isVisible: toast !== null }}>
      {children}
      {toast ? (
        <Animated.View
          // Only an actionable toast needs to catch touches; a plain one stays
          // fully pass-through so it can never block the screen underneath.
          pointerEvents={toast.actions.length > 0 ? 'box-none' : 'none'}
          style={[
            styles.toast,
            {
              opacity,
              transform: [{ translateY }],
              bottom: hasMultipleActions ? insets.bottom + 84 : insets.bottom + 20,
              right: hasMultipleActions ? 16 : 88,
              borderRadius: hasMultipleActions ? 16 : 999,
              backgroundColor: palette.card,
              borderColor: palette.border,
            },
          ]}
        >
          {/* Main Status Row */}
          <View style={styles.statusRow}>
            {toast.phase === 'saved' ? (
              <View style={[styles.statusBadge, { backgroundColor: palette.successSoft }]} testID="toast-checkmark">
                <Text style={[styles.statusIcon, { color: palette.success }]}>✓</Text>
              </View>
            ) : null}

            {toast.phase === 'enriching' ? (
              <View style={[styles.statusBadge, { backgroundColor: sparkleSoft }]} testID="toast-sparkle">
                <Text style={[styles.statusIcon, { color: sparkleColor }]}>✨</Text>
              </View>
            ) : null}

            <View accessible accessibilityLabel={toast.message} style={styles.toastTextWrap}>
              <PostHogMaskView>
                <Text style={[styles.toastText, { color: palette.text }]}>{toast.message}</Text>
              </PostHogMaskView>
            </View>

            {/* Single Action Chip (inline in status row) */}
            {singleAction ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={singleAction.label}
                onPress={() => handleActionPress(singleAction)}
                hitSlop={8}
                style={({ pressed }) => [
                  styles.singleActionChip,
                  {
                    backgroundColor: palette.accentSoft,
                    borderColor: palette.accentSoft,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}
                testID={singleAction.testID ?? 'toast-action-view'}
              >
                {singleAction.icon ? (
                  <Text style={[styles.chipIcon, { color: palette.accentText }]}>{singleAction.icon} </Text>
                ) : null}
                <Text style={[styles.chipText, { color: palette.accentText }]}>{singleAction.label}</Text>
                {singleAction.trailingIcon ? (
                  <Text style={[styles.chipIcon, { color: palette.accentText }]}>
                    {' '}{singleAction.trailingIcon}
                  </Text>
                ) : null}
              </Pressable>
            ) : null}
          </View>

          {/* Multiple Quick Action Chips Row */}
          {hasMultipleActions ? (
            <View style={styles.actionChipsRow}>
              {toast.actions.map((act, index) => {
                const isView = act.label === 'View' || act.trailingIcon === '↗';
                return (
                  <Pressable
                    key={`${act.label}-${index}`}
                    accessibilityRole="button"
                    accessibilityLabel={act.label}
                    onPress={() => handleActionPress(act)}
                    hitSlop={6}
                    style={({ pressed }) => [
                      styles.actionChip,
                      {
                        backgroundColor: isView ? palette.accentSoft : palette.surface,
                        borderColor: isView ? palette.accentSoft : palette.border,
                        opacity: pressed ? 0.7 : 1,
                      },
                    ]}
                    testID={act.testID ?? `toast-action-chip-${index}`}
                  >
                    {act.icon ? <Text style={styles.chipIcon}>{act.icon} </Text> : null}
                    <Text
                      style={[
                        styles.chipText,
                        { color: isView ? palette.accentText : palette.text },
                      ]}
                    >
                      {act.label}
                    </Text>
                    {act.trailingIcon ? (
                      <Text
                        style={[
                          styles.chipIcon,
                          { color: isView ? palette.accentText : palette.text },
                        ]}
                      >
                        {' '}{act.trailingIcon}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          {/* Soft Purple Progress Indicator for AI Enriching State */}
          {toast.phase === 'enriching' ? (
            <View style={[styles.progressTrack, { backgroundColor: sparkleSoft }]}>
              <Animated.View
                style={[
                  styles.progressFill,
                  {
                    backgroundColor: sparkleColor,
                    width: progressAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: ['0%', '100%'],
                    }),
                  },
                ]}
                testID="toast-enriching-progress"
              />
            </View>
          ) : null}
        </Animated.View>
      ) : null}
    </CaptureToastContext.Provider>
  );
}

export function useCaptureToast(): CaptureToastContextValue {
  const context = useContext(CaptureToastContext);
  if (!context) {
    throw new Error('useCaptureToast must be used within a CaptureToastProvider');
  }
  return context;
}

export function useOptionalCaptureToast(): CaptureToastContextValue | null {
  return useContext(CaptureToastContext);
}

const styles = StyleSheet.create({
  toast: {
    ...overlayLayer(60),
    position: 'absolute',
    left: 16,
    // On phones with FAB (STASH-66), single-action right clearance leaves 88px;
    // multi-action floating pills float comfortably above the FAB at insets.bottom + 84.
    maxWidth: 480,
    alignSelf: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderWidth: StyleSheet.hairlineWidth,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOpacity: 0.16,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 4 },
      },
      web: {
        boxShadow: '0px 4px 16px rgba(0, 0, 0, 0.14)',
      } as any,
      default: {},
    }),
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusBadge: {
    width: 22,
    height: 22,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  statusIcon: {
    fontSize: 13,
    fontWeight: '800',
  },
  toastTextWrap: {
    flexShrink: 1,
  },
  toastText: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  singleActionChip: {
    marginLeft: 'auto',
    paddingLeft: 10,
    paddingRight: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },
  actionChip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipIcon: {
    fontSize: 13,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '700',
  },
  progressTrack: {
    height: 3,
    borderRadius: 999,
    overflow: 'hidden',
    marginTop: 8,
    width: '100%',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
  },
});
