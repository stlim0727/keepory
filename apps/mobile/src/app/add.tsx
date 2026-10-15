import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, usePreventRemove, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { parseSmartInput } from '@/domain/smart-parse';
import { MAX_ADD_MEMO_LENGTH } from '@/domain/add-draft';
import { useAddDraft, type AddMode } from '@/features/add/use-add-draft';
import { useImagePaste } from '@/features/add/use-image-paste';
import { makeClientId } from '@/store/bookmarks/helpers';
import { parseCaptureParams } from '@/domain/web-capture';
import { normalizeUrl, canonicalizeUrl, isUrlTooLong } from '@/domain/urls';
import type { TextFormat } from '@/domain/types';
import { useT } from '@/i18n';
import { usePalette } from '@/theme';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { KeyboardAvoidingScreen } from '@/ui/KeyboardAvoidingScreen';
import { MemoEditor } from '@/ui/MemoEditor';
import { useCaptureToast } from '@/ui/capture-toast';
import { useBookmarks } from '@/store/bookmarks';

// On wide (desktop-web) viewports, Add docks as a right-side sheet over the
// dimmed Inbox (mirrors Report's right-docked sheet); this caps the panel
// width. No effect on phones (their width is already below the breakpoint).
const SHEET_PANEL_MAX_WIDTH = 480;

export default function AddBookmarkScreen() {
  const palette = usePalette();
  const router = useRouter();
  const t = useT();
  const insets = useSafeAreaInsets();
  // Wide viewports present Add as a right-side sheet over a dimmed Inbox;
  // phones keep the full-screen layout (mirrors Report's sheet).
  const { width, height, fontScale } = useWindowDimensions();
  const asSheet = width >= 760;
  const { addBookmark, abandonCapture, isLoading } = useBookmarks();
  const { show } = useCaptureToast();
  const [failedMode, setFailedMode] = useState<AddMode | null>(null);
  const smart = useAddDraft(failedMode);
  const { mode, draft: { url, title, memo, format, image } } = smart;
  const setUrl = (value: string) => smart.update({ url: value });
  const setTitle = (value: string) => smart.update({ title: value, titleEdited: true });
  const [error, setError] = useState<string | null>(null);
  const titleInputRef = useRef<React.ComponentRef<typeof TextInput> | null>(null);
  const pasteRoot = useRef<React.ComponentRef<typeof View> | null>(null);
  useImagePaste(pasteRoot, (read, text) => { if (!savingRef.current) void smart.receiveImage(read, text); }, (text) => {
    if (!savingRef.current) { smart.offer(text); setDetailsOpen(true); }
  });
  const captureIds = useRef<Partial<Record<AddMode, string>>>({});
  const [detailsOpen, setDetailsOpen] = useState(false);
  const focusTitleAfterExpand = useRef(false);
  useEffect(() => {
    if (smart.status === 'ready' && mode === 'link' && (title || memo)) setDetailsOpen(true);
  }, [smart.status, mode, title, memo]);
  useEffect(() => {
    if (mode === 'link' && detailsOpen && focusTitleAfterExpand.current) {
      focusTitleAfterExpand.current = false;
      titleInputRef.current?.focus();
    }
  }, [mode, detailsOpen]);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const resumeRemoval = useRef<(() => void) | null>(null);
  // Protect the draft from system Back, modal dismissal, and browser navigation
  // until the local row, image, and outbox have acknowledged persistence.
  const allowRemoval = usePreventRemove(saving || failedMode !== null, ({ repeat }) => {
    if (!savingRef.current && failedMode) {
      resumeRemoval.current = repeat;
      setConfirmDiscard(true);
    }
  });
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const normalizedUrl = normalizeUrl(url);
  const validUrl = normalizedUrl && !isUrlTooLong(canonicalizeUrl(normalizedUrl));
  const canSave = !isLoading && (mode === 'link' ? Boolean(validUrl) : mode === 'image' ? Boolean(image) : Boolean(memo.trim()));

  // A capture intent passed via query params — the web counterpart of the
  // native share handler. The desktop bookmarklet, the PWA Web Share Target,
  // and plain `/add?url=…` deep links all land here. When present we skip the
  // manual editor and save immediately: capture is sacred and fast.
  const params = useLocalSearchParams<{
    url?: string;
    title?: string;
    text?: string;
    note?: string;
  }>();
  const capture = parseCaptureParams(params);
  const captureHandledRef = useRef(false);

  useEffect(() => {
    // Save once the store has loaded so the in-memory dedupe sees existing
    // bookmarks instead of running against an empty set during a cold start
    // (mirrors ShareIntentHandler). Handle exactly once.
    if (!capture || isLoading || captureHandledRef.current) {
      return;
    }
    captureHandledRef.current = true;
    const result = capture.url
      ? addBookmark({
          url: capture.url,
          title: capture.title,
          title_is_derived: true,
          // Preserve any accompanying text (a PWA Web Share Target's selected
          // quote / description) as the note. A share target that merely echoes
          // the URL back into `text` shouldn't duplicate it as a note.
          notes: capture.text && capture.text !== capture.url ? capture.text : undefined,
        })
      : addBookmark({ shared_text: capture.text, title: capture.title });
    const message =
      result.status === 'invalid'
        ? result.reason === 'too_long'
          ? t('toast.urlTooLong')
          : t('toast.noLink')
        : result.status === 'duplicate'
          ? t('toast.duplicate')
          : t('toast.saved');
    show(message);
    // Land on the Inbox so the freshly stashed item is immediately visible.
    router.replace('/');
  }, [capture, isLoading, addBookmark, router, show, t]);

  // Capture mode: a deep-linked save is in flight — show a calm placeholder
  // instead of flashing the manual editor before the redirect. Add is a
  // `transparentModal`, so (as with the main layout below) the height is
  // pinned explicitly — on web the modal container sizes to content, and a
  // bare `flex: 1` here would collapse and let the Inbox bleed through.
  if (capture) {
    return (
      <View style={[styles.capturing, { backgroundColor: palette.background, height }]}>
        <ActivityIndicator color={palette.accent} />
        <Text style={[styles.capturingLabel, { color: palette.textSecondary }]}>
          {t('add.saving')}
        </Text>
      </View>
    );
  }

  function dismissManual() {
    if (router.canGoBack?.() === false) router.replace('/');
    else router.back();
  }

  function requestDismiss() {
    if (savingRef.current) return;
    if (failedMode) { setConfirmDiscard(true); return; }
    smart.cancel();
    dismissManual();
  }

  async function discardFailedDraft() {
    if (savingRef.current || !failedMode) return;
    savingRef.current = true;
    setSaving(true);
    const attemptKey = captureIds.current[failedMode];
    let reconciled = false;
    try { reconciled = !attemptKey || await abandonCapture(attemptKey); }
    catch { reconciled = false; }
    finally { savingRef.current = false; if (mountedRef.current) setSaving(false); }
    if (!mountedRef.current) return;
    if (!reconciled) { setError(t('add.saveFailed')); return; }
    const repeat = resumeRemoval.current;
    resumeRemoval.current = null;
    setConfirmDiscard(false);
    setFailedMode(null);
    smart.cancel();
    if (repeat) repeat();
    else { allowRemoval(); dismissManual(); }
  }

  async function handleSave() {
    if (!canSave || savingRef.current || smart.pending || smart.status === 'reading') return;
    savingRef.current = true;
    setSaving(true);
    const trimmedUrl = url.trim();
    const trimmedTitle = title.trim();
    const submittedTitle = trimmedTitle || (smart.draft.titleEdited ? '' : undefined);

    smart.cancel();
    const clientId = captureIds.current[mode] ?? makeClientId();
    captureIds.current[mode] = clientId;
    try {
      const result = mode === 'link'
        ? addBookmark({
            capture_attempt_id: clientId,
            url: trimmedUrl,
            title: submittedTitle,
            notes: memo,
            replace_existing_notes: true,
            notes_format: format,
          })
        : addBookmark({
            capture_attempt_id: clientId,
            image: mode === 'image' ? image : undefined,
            notes: mode === 'image' ? memo : undefined,
            notes_format: format,
            title: submittedTitle,
            shared_text: memo,
            description_format: format,
          });

      if (result.status === 'invalid') {
        savingRef.current = false;
        setSaving(false);
        setError(result.error);
        return;
      }
      const persisted = await result.persisted;
      if (!mountedRef.current) return;
      if (persisted !== true) {
        setFailedMode(mode);
        setError(t('add.saveFailed'));
        return;
      }
      // Confirm with the same capture toast the share flow uses, so adding a URL
      // that's already saved reads identically however it was captured. The
      // bookmark is already visible in Inbox, so capture stays fast and
      // non-blocking.
      show(result.status === 'duplicate' ? t('toast.duplicate') : t('toast.saved'));
      setFailedMode(null);
      setSaving(false);
      allowRemoval();
      dismissManual();
    } catch { if (mountedRef.current) { setFailedMode(mode); setError(t('add.saveFailed')); } }
    finally { savingRef.current = false; if (mountedRef.current) setSaving(false); }
  }

  const titleField = <>
    <Text style={[styles.label, { color: palette.textSecondary }]}>{t('add.memoTitleLabel')}</Text>
    <TextInput ref={titleInputRef} accessibilityLabel={t('add.memoTitleLabel')}
      editable={!saving} style={[styles.input, { backgroundColor: palette.card, color: palette.text, borderColor: palette.controlBorder }]}
      placeholder={t('add.memoTitlePlaceholder')} placeholderTextColor={palette.textSecondary}
      value={title} onChangeText={(value) => { setTitle(value); setError(null); }} />
  </>;
  const noteField = <MemoEditor label={t('add.memoBodyLabel')} accessibilityLabel={t('add.memoBodyLabel')}
    placeholder={t('add.memoBodyPlaceholder')} alwaysEditing maxLength={MAX_ADD_MEMO_LENGTH}
    value={memo} format={format} onChange={({ value, format: nextFormat }) => {
      if (!savingRef.current) { smart.update({ memo: value, format: nextFormat }); setError(null); }
    }} />;
  const content = <>
    {confirmDiscard ? <Card elevated={false} style={styles.captureCard}>
      <Text accessibilityRole="alert" style={{ color: palette.text }}>{t('add.discardPrompt')}</Text>
      <Button variant="secondary" disabled={saving} onPress={() => { resumeRemoval.current = null; setConfirmDiscard(false); }}>{t('add.keepEditing')}</Button>
      <Button variant="danger" disabled={saving} onPress={discardFailedDraft}>{t('add.discardDraft')}</Button>
    </Card> : null}
    <ScrollView testID="add-scroll" style={[styles.scroll, { backgroundColor: palette.background }]}
      contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Button testID="add-paste" variant="secondary" disabled={saving || smart.status === 'reading'} onPress={smart.paste}>
        {t(mode === 'image' ? 'add.pasteImage' : 'add.paste')}
      </Button>
      {smart.status ? <Text accessibilityRole={smart.status === 'denied' || smart.status === 'empty' || smart.status === 'imageMissing' || smart.status === 'textTooLong' ? 'alert' : 'text'} accessibilityLiveRegion="polite" style={{ color: palette.textSecondary }}>{t(`add.clipboard.${smart.status}`)}</Text> : null}
      {smart.pending ? <Card elevated={false} style={styles.captureCard}>
        <Text style={{ color: palette.text }}>{t('add.replacePrompt')}</Text>
        {smart.pending.draft.image ? <Image source={{ uri: smart.pending.draft.image.uri }} accessibilityLabel={t('add.imagePreview')} style={{ width: '100%', height: 160, resizeMode: 'contain' }} /> : null}
        <Text numberOfLines={5} style={{ color: palette.textSecondary }}>{[smart.pending.draft.url, smart.pending.draft.title, smart.pending.draft.memo].filter(Boolean).join('\n')}</Text>
        <Button variant="secondary" onPress={() => { smart.replace(); setError(null); setDetailsOpen(true); }}>{t('add.replaceDraft')}</Button>
        <Button variant="ghost" onPress={smart.keep}>{t('add.keepEditing')}</Button>
      </Card> : null}
      <View style={[styles.modeRow, fontScale >= 1.5 && { flexDirection: 'column' }]}>

        {(['link', 'note', 'image'] as const).map((value) => <Button key={value}
          testID={`add-mode-${value}`} variant={mode === value ? 'primary' : 'ghost'}
          accessibilityState={{ selected: mode === value, disabled: saving || failedMode !== null }} accessibilityLabel={t(value === 'link' ? 'add.modeLinkA11y' : value === 'note' ? 'add.modeMemoA11y' : 'add.modeImageA11y')} style={fontScale >= 1.5 ? undefined : { flex: 1 }} disabled={saving || failedMode !== null}
          onPress={() => { smart.changeMode(value); setError(null); }}>
          {t(value === 'link' ? 'add.modeLink' : value === 'note' ? 'add.modeMemo' : 'add.modeImage')}
        </Button>)}
      </View>
      {failedMode && smart.status !== 'savePending' ? <Text accessibilityLiveRegion="polite" style={{ color: palette.textSecondary }}>{t('add.clipboard.savePending')}</Text> : null}
      <Card elevated={false} style={styles.captureCard}>
        {/* Keep a native parent while input blocking changes; flattening this
            wrapper on save completion can reparent Fabric children. */}
        <View collapsable={false} pointerEvents={saving ? 'none' : 'auto'} style={{ gap: 10 }}>
        {mode === 'link' ? <>
          <Text style={[styles.label, { color: palette.textSecondary }]}>{t('add.urlLabel')}</Text>
          <TextInput testID="add-url" accessibilityLabel={t('add.urlLabel')}
            style={[styles.input, { backgroundColor: palette.card, color: palette.text, borderColor: palette.controlBorder }]}
            placeholder={t('add.urlPlaceholder')} placeholderTextColor={palette.textSecondary}
            autoCapitalize="none" autoCorrect={false} autoFocus keyboardType="url" returnKeyType="next"
            value={url} editable={!saving} onChangeText={(value) => {
              const lengthChange = Math.abs(value.length - url.length);
              const pasted = lengthChange > 8 || (value.includes('\n') && lengthChange > 1);
              const parsed = pasted ? parseSmartInput(value) : null;
              if (parsed?.mode === 'link' && (parsed.title || parsed.notes)) {
                smart.offer(value);
                setDetailsOpen(true);
              } else {
                setUrl(value);
              }
              setError(null);
            }}
            onSubmitEditing={() => {
              if (detailsOpen) {
                titleInputRef.current?.focus();
              } else {
                focusTitleAfterExpand.current = true;
                setDetailsOpen(true);
              }
            }} />
          <Button variant="ghost" accessibilityState={{ expanded: detailsOpen }}
            onPress={() => setDetailsOpen((value) => !value)}>{t('add.details')}</Button>
          {detailsOpen ? <>{titleField}{noteField}</> : null}
        </> : <>
          {mode === 'image' ? image ? <>
            <Image source={{ uri: image.uri }} accessibilityLabel={t('add.imagePreview')} style={{ width: '100%', height: 220, resizeMode: 'contain' }} />
            <Button testID="add-remove-image" variant="ghost" disabled={saving} onPress={() => smart.update({ image: undefined })}>{t('add.removeImage')}</Button>
          </> : <Text style={{ color: palette.textSecondary }}>{t('add.imageEmpty')}</Text> : null}
          {noteField}{titleField}
        </>}
        </View>
        {error ? <Text accessibilityRole="alert" style={[styles.error, { color: palette.danger }]}>{error}</Text> : null}
      </Card>
      <Text style={[styles.hint, { color: palette.textSecondary }]}>{t(mode === 'note' ? 'add.memoHint' : 'add.hint')}</Text>
    </ScrollView>
    <View style={[styles.saveFooter, { backgroundColor: palette.background, paddingBottom: Math.max(16, insets.bottom) }]}>
      <Button testID="add-save" size="lg" disabled={!canSave || saving || Boolean(smart.pending) || smart.status === 'reading'} onPress={handleSave}>
        {t(saving ? 'add.saving' : mode === 'note' ? 'add.saveMemo' : mode === 'image' ? 'add.saveImage' : 'add.save')}
      </Button>
    </View>
  </>;

  // The Stack header is hidden for this screen, so Add supplies its own header
  // row (title + close) for both layouts — matching Settings/Report/Review.
  const header = (
    <View style={[styles.header, { paddingTop: insets.top + 12, borderBottomColor: palette.border }]}>
      <Text style={[styles.headerTitle, { color: palette.text }]}>{t('nav.addBookmark')}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('common.close')}
        disabled={saving} accessibilityState={{ disabled: saving }}
        onPress={requestDismiss}
        hitSlop={8}
        style={({ pressed }) => [styles.headerClose, pressed && { opacity: 0.6 }]}
      >
        <Ionicons name="close" size={24} color={palette.text} />
      </Pressable>
    </View>
  );

  // KeyboardAvoidingScreen wraps only `content` (not the pinned-height root
  // above): its `flex: 1` needs to sit *inside* the fixed-height box so its
  // bottom padding actually shrinks the visible form when the keyboard opens.
  // Wrapping the whole root would pin `flex: 1` and an explicit `height` on
  // the same node, so the padding couldn't reduce anything — the note field
  // would end up under the keyboard instead.
  return asSheet ? (
    <View style={[styles.sheetOverlay, { height }]}>
      <Pressable
        testID="add-sheet-backdrop"
        style={styles.sheetBackdrop}
        accessibilityRole="button"
        accessibilityLabel={t('common.close')}
        disabled={saving} accessibilityState={{ disabled: saving }}
        onPress={requestDismiss}
      />
      <View ref={pasteRoot} style={[styles.sheetPanel, { backgroundColor: palette.background }]}>
        {header}
        <KeyboardAvoidingScreen>{content}</KeyboardAvoidingScreen>
      </View>
    </View>
  ) : (
    <View ref={pasteRoot} testID="add-fullscreen" style={[styles.fullScreen, { backgroundColor: palette.background, height }]}>
      {header}
      <KeyboardAvoidingScreen>{content}</KeyboardAvoidingScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  modeRow: { flexDirection: 'row', gap: 8 },
  saveFooter: { paddingHorizontal: 16, paddingTop: 12 },
  fullScreen: {
    flex: 1,
  },
  sheetOverlay: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.24)',
  },
  sheetBackdrop: {
    ...StyleSheet.absoluteFill,
  },
  sheetPanel: {
    width: '100%',
    maxWidth: SHEET_PANEL_MAX_WIDTH,
    height: '100%',
    shadowColor: '#000000',
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: -4, height: 0 },
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
  },
  headerClose: {
    padding: 4,
  },
  container: {
    flexGrow: 1,
    padding: 16,
    gap: 14,
  },
  scroll: {
    flex: 1,
  },
  capturing: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  capturingLabel: {
    fontSize: 15,
  },
  captureCard: {
    borderRadius: 16,
    padding: 16,
    gap: 10,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 8,
  },
  input: {
    borderRadius: 16,
    borderWidth: 1,
    minHeight: 48,
    padding: 14,
    fontSize: 16,
  },
  error: {
    fontSize: 13,
  },
  hint: {
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
  },
});
