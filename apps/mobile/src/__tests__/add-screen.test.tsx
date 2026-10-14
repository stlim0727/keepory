import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

const mockReadClipboard = jest.fn();
const mockCopyImage = jest.fn(async (..._args: unknown[]) => 'file:///durable/image.png');
jest.mock('@/share/smart-clipboard', () => ({ readSmartClipboard: () => mockReadClipboard() }));
jest.mock('@/storage/image-store', () => ({
  copyImageToLibrary: (...args: unknown[]) => mockCopyImage(...args),
  localFileSizeBytes: () => 1, uploadImageFile: jest.fn(),
}));

// Native focus is imperative; record it while preserving real input rendering.
const mockInputFocus = jest.fn();
jest.mock('react-native', () => {
  const native = jest.requireActual('react-native');
  const React = require('react');
  const module = Object.create(native);
  Object.defineProperty(module, 'TextInput', {
    value: React.forwardRef((props: { accessibilityLabel?: string }, ref: unknown) => {
      React.useImperativeHandle(ref, () => ({ focus: () => mockInputFocus(props.accessibilityLabel) }));
      return React.createElement(native.TextInput, props);
    }),
  });
  return module;
});

jest.mock('react-native-safe-area-context' , () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);
jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: 'not_configured',
    session: null,
    userId: null,
    message: 'not configured',
    ensureAnonymousSession: async () => null,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));
const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockRemovalPrevented = false;
let mockPreventedRemoval: ((options: { repeat: () => void }) => void) | undefined;
const mockAllowRemoval = jest.fn(() => { mockRemovalPrevented = false; });
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: mockReplace, back: mockBack }),
  useLocalSearchParams: () => mockParams,
  usePreventRemove: (prevent: boolean, callback?: (options: { repeat: () => void }) => void) => {
    mockRemovalPrevented = prevent; mockPreventedRemoval = callback; return mockAllowRemoval;
  },
}));

// Drive the responsive sheet rule off a controllable viewport.
const mockWindowSize = { width: 390, height: 844, scale: 2, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockWindowSize,
}));

import AddBookmarkScreen from '@/app/add';
import { en } from '@/i18n/messages';
import { BookmarksProvider } from '@/store/bookmarks';
import { CaptureToastProvider } from '@/ui/capture-toast';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

async function renderAddScreen() {
  return render(
    <BookmarksProvider>
      <CaptureToastProvider>
        <AddBookmarkScreen />
      </CaptureToastProvider>
    </BookmarksProvider>,
  );
}

beforeEach(() => {
  mockBack.mockClear();
  mockReplace.mockClear();
  mockAllowRemoval.mockClear();
  mockRemovalPrevented = false;
  mockPreventedRemoval = undefined;
  mockParams = {};
  mockWindowSize.width = 390;
  mockWindowSize.height = 844;
});

describe('AddBookmarkScreen duplicate UX', () => {
  it('shows "Already in Keepory" when adding a URL already stashed', async () => {
    fakeRepo.__reset([makeStoredBookmark({ url: 'https://example.com/stored' })]);
    const { findByText, getByPlaceholderText, unmount } = await renderAddScreen();
    // Let the store finish loading so the in-memory dedupe sees the stored row.
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(0));

    await act(async () => {
      fireEvent.changeText(getByPlaceholderText('https://'), 'https://example.com/stored');
    });
    await act(async () => {
      fireEvent.press(await findByText('Save bookmark'));
    });

    await findByText('Already in Keepory');
    expect(mockBack).toHaveBeenCalled();
    // Dedupe held: no new create was enqueued.
    expect(fakeRepo.__queue()).toHaveLength(0);
    unmount();
  });

  it('renders the capture hint wired to the add.hint message key', async () => {
    fakeRepo.__reset([]);
    const { findByText, unmount } = await renderAddScreen();
    await findByText(en['add.hint'] as string);
    unmount();
  });

  it('shows "Saved to Keepory" for a genuinely new URL', async () => {
    fakeRepo.__reset([makeStoredBookmark({ url: 'https://example.com/stored' })]);
    const { findByText, getByPlaceholderText, unmount } = await renderAddScreen();
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(0));

    await act(async () => {
      fireEvent.changeText(getByPlaceholderText('https://'), 'https://example.com/fresh');
    });
    await act(async () => {
      fireEvent.press(await findByText('Save bookmark'));
    });

    await findByText('Saved to Keepory');
    expect(mockBack).toHaveBeenCalled();
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
    unmount();
  });

  it('advances focus to the title input instead of saving when submitting the URL field', async () => {
    fakeRepo.__reset([]);
    const { getByPlaceholderText, unmount } = await renderAddScreen();

    await act(async () => {
      fireEvent.changeText(getByPlaceholderText('https://'), 'https://example.com/fresh');
      fireEvent(getByPlaceholderText('https://'), 'submitEditing');
    });

    expect(mockBack).not.toHaveBeenCalled();
    expect(fakeRepo.__queue()).toHaveLength(0);
    unmount();
  });

  it('updates title and notes when re-saving an already stashed URL with custom title and notes', async () => {
    fakeRepo.__reset([makeStoredBookmark({
      id: 'existing-1',
      url: 'https://example.com/stored',
      title: 'Original Title',
      title_is_derived: false,
    })]);
    const { findByText, findByLabelText, getByPlaceholderText, unmount } = await renderAddScreen();
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(0));

    await fireEvent.press(await findByText('Add details'));
    await act(async () => {
      fireEvent.changeText(getByPlaceholderText('https://'), 'https://example.com/stored');
      fireEvent.changeText(await findByLabelText('Title (optional)'), 'Updated Title');
      fireEvent.changeText(await findByLabelText('Note'), 'Updated Notes');
    });
    await act(async () => {
      fireEvent.press(await findByText('Save bookmark'));
    });

    await findByText('Already in Keepory');
    expect(mockBack).toHaveBeenCalled();
    const stored = fakeRepo.__bookmarks().find((b) => b.url === 'https://example.com/stored');
    expect(stored?.title).toBe('Updated Title');
    expect(stored?.notes).toBe('Updated Notes');
    unmount();
  });
});

describe('AddBookmarkScreen memo formats', () => {
  it('defaults new memos to plain text and preserves literal Markdown syntax', async () => {
    const source = '  # literal heading\n*literal*\n';
    fakeRepo.__reset([]);
    const screen = await renderAddScreen();
    await fireEvent.press(screen.getByTestId('add-mode-note'));
    await fireEvent.changeText(screen.getByLabelText('Note'), source);
    expect(screen.queryByText('Preview')).toBeNull();
    await fireEvent.press(screen.getByText('Save note'));
    await waitFor(() => expect(fakeRepo.__bookmarks()[0]).toMatchObject({
      description: source,
      description_format: 'plain',
    }));
  });

  it('saves bookmark notes with the chosen Markdown format and original whitespace', async () => {
    const source = '    note code\n\n# Remember\n';
    fakeRepo.__reset([]);
    const screen = await renderAddScreen();
    await fireEvent.changeText(screen.getByPlaceholderText('https://'), 'https://example.com/note-format');
    await fireEvent.press(screen.getByText('Add details'));
    await fireEvent.changeText(screen.getByLabelText('Note'), source);
    await fireEvent.press(screen.getByLabelText('Format for Note'));
    await fireEvent.press(screen.getByRole('radio', { name: 'Markdown' }));
    await fireEvent.press(screen.getByText('Save bookmark'));
    await waitFor(() => expect(fakeRepo.__bookmarks()[0]).toMatchObject({
      url: 'https://example.com/note-format',
      notes: source,
      notes_format: 'markdown',
    }));
  });

  it('saves a URL-less memo with its raw Markdown and stable client id', async () => {
    const markdown = '    const priority = 1;\n\n# Priorities\n';
    fakeRepo.__reset([]);
    const { findByText, findByLabelText, unmount } = await renderAddScreen();
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(0));

    await fireEvent.press(await findByText('Note'));
    fireEvent.changeText(await findByLabelText('Title (optional)'), 'Weekly plan');
    await fireEvent.changeText(await findByLabelText('Note'), markdown);
    await fireEvent.press(await findByLabelText('Format for Note'));
    await fireEvent.press(await findByText('Markdown'));
    await fireEvent.press(await findByText('Preview'));
    await fireEvent.press(await findByText('Write'));
    fireEvent.press(await findByText('Save note'));

    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
    const saved = fakeRepo.__bookmarks()[0];
    expect(saved).toMatchObject({
      url: null,
      title: 'Weekly plan',
      description: markdown,
      description_format: 'markdown',
      content_type: 'text',
    });
    expect(saved.client_id).toBeTruthy();
    expect(fakeRepo.__queue()[0]?.payload).toMatchObject({
      title: 'Weekly plan',
      shared_text: markdown,
      description_format: 'markdown',
      client_id: saved.client_id,
    });
    expect(mockBack).toHaveBeenCalled();
    unmount();
  });

  it('saves URL, custom title, and memo together', async () => {
    fakeRepo.__reset([]);
    const { findByText, findByLabelText, getByPlaceholderText, unmount } = await renderAddScreen();
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(0));

    fireEvent.changeText(getByPlaceholderText('https://'), 'https://example.com/full');
    await fireEvent.press(await findByText('Add details'));
      fireEvent.changeText(await findByLabelText('Title (optional)'), 'Custom Title');
    fireEvent.changeText(await findByLabelText('Note'), 'My notes on this link');
    fireEvent.press(await findByText('Save bookmark'));

    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
    const saved = fakeRepo.__bookmarks()[0];
    expect(saved).toMatchObject({
      url: 'https://example.com/full',
      title: 'Custom Title',
      notes: 'My notes on this link',
      content_type: 'url',
    });
    expect(mockBack).toHaveBeenCalled();
    unmount();
  });

  it('keeps an empty memo open and shows a validation message', async () => {
    fakeRepo.__reset([]);
    const { findByText, unmount } = await renderAddScreen();

    fireEvent.press(await findByText('Save bookmark'));

    expect(fakeRepo.__bookmarks()).toHaveLength(0);
    expect(fakeRepo.__queue()).toHaveLength(0);
    expect(mockBack).not.toHaveBeenCalled();
    unmount();
  });
});

describe('AddBookmarkScreen web capture endpoint', () => {
  it('auto-saves a url passed via query params and lands on the Inbox', async () => {
    // The bookmarklet / PWA share target / deep link opens /add?url=…; the
    // screen skips the manual editor and captures immediately.
    fakeRepo.__reset([]);
    mockParams = { url: 'https://example.com/from-bookmarklet', title: 'From bookmarklet' };
    const { findByText, queryByPlaceholderText, unmount } = await renderAddScreen();

    // Confirms with the shared capture toast and never shows the manual form.
    await findByText('Saved to Keepory');
    expect(queryByPlaceholderText('https://')).toBeNull();
    // Landed the freshly stashed item by replacing to the Inbox.
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
    expect(fakeRepo.__bookmarks()[0]).toMatchObject({
      title: 'From bookmarklet',
      title_is_derived: true,
    });
    unmount();
  });

  it('preserves accompanying text as the note when a url is also present', async () => {
    // A PWA share / rich bookmarklet sends url + a selected quote; the quote
    // must not be dropped just because there is a valid URL.
    fakeRepo.__reset([]);
    mockParams = { url: 'https://example.com/article', text: 'a selected quote' };
    const { findByText, unmount } = await renderAddScreen();

    await findByText('Saved to Keepory');
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
    const saved = fakeRepo
      .__bookmarks()
      .find((b) => b.url === 'https://example.com/article');
    expect(saved?.notes).toBe('a selected quote');
    unmount();
  });

  it('saves a no-link share as a text note via the text param', async () => {
    fakeRepo.__reset([]);
    mockParams = { text: 'a shared message with no link' };
    const { findByText, unmount } = await renderAddScreen();

    await findByText('Saved to Keepory');
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
    unmount();
  });
});

describe('AddBookmarkScreen sheet layout', () => {
  it('wide viewport renders the side-sheet backdrop', async () => {
    fakeRepo.__reset([]);
    mockWindowSize.width = 1280;

    const { findByTestId, unmount } = await renderAddScreen();

    await findByTestId('add-sheet-backdrop');
    unmount();
  });

  it('phone viewport renders full-screen with no backdrop', async () => {
    fakeRepo.__reset([]);
    mockWindowSize.width = 390;

    const { findByTestId, queryByTestId, unmount } = await renderAddScreen();

    await findByTestId('add-fullscreen');
    expect(queryByTestId('add-sheet-backdrop')).toBeNull();
    unmount();
  });

  it('bounds the form scroll view to the available viewport height', async () => {
    fakeRepo.__reset([]);
    const { findByTestId, unmount } = await renderAddScreen();

    const scroll = await findByTestId('add-scroll');
    const flat = Array.isArray(scroll.props.style)
      ? Object.assign({}, ...scroll.props.style.flat())
      : scroll.props.style;
    expect(flat.flex).toBe(1);
    unmount();
  });

  // Add is a transparentModal with the Inbox mounted behind it. On web the
  // modal container sizes to content, so a `flex: 1` root collapses and the
  // Inbox bleeds through below Add. Pinning the root to the viewport height
  // keeps the opaque background covering the full screen.
  it('phone viewport pins the full-screen root to the viewport height', async () => {
    fakeRepo.__reset([]);
    mockWindowSize.width = 390;
    mockWindowSize.height = 844;

    const { findByTestId, unmount } = await renderAddScreen();

    const root = await findByTestId('add-fullscreen');
    const flat = Array.isArray(root.props.style)
      ? Object.assign({}, ...root.props.style.flat())
      : root.props.style;
    expect(flat.height).toBe(844);
    unmount();
  });
});

test('manual modes preserve drafts and save only the active Note payload once', async () => {
  fakeRepo.__reset([]);
  const screen = await renderAddScreen();
  expect(screen.getByTestId('add-mode-link').props.accessibilityState.selected).toBe(true);
  expect(screen.getByTestId('add-save').props.accessibilityState.disabled).toBe(true);
  await fireEvent.changeText(screen.getByPlaceholderText('https://'), 'https://example.com/inactive');
  await fireEvent.press(screen.getByTestId('add-mode-note'));
  await fireEvent.changeText(screen.getByLabelText('Title (optional)'), 'Only a title');
  expect(screen.getByTestId('add-save').props.accessibilityState.disabled).toBe(true);
  await fireEvent.changeText(screen.getByLabelText('Note'), '  A note with https://example.com/body  ');
  await fireEvent.press(screen.getByTestId('add-mode-link'));
  expect(screen.getByPlaceholderText('https://').props.value).toBe('https://example.com/inactive');
  await fireEvent.press(screen.getByTestId('add-mode-note'));
  expect(screen.getByLabelText('Note').props.value).toBe('  A note with https://example.com/body  ');
  await waitFor(() => expect(screen.getByTestId('add-save').props.accessibilityState.disabled).toBe(false));
  const onPress = screen.getByTestId('add-save').props.onClick ?? screen.getByTestId('add-save').props.onPress;
  await act(async () => { onPress(); onPress(); });
  await waitFor(() => expect(fakeRepo.__bookmarks()).toHaveLength(1));
  expect(fakeRepo.__bookmarks()[0]).toMatchObject({ url: null, content_type: 'text', description: '  A note with https://example.com/body  ' });
  expect(mockBack).toHaveBeenCalledTimes(1);
});

test('manual Link mode rejects invalid and oversized URLs even with note content', async () => {
  fakeRepo.__reset([]);
  const screen = await renderAddScreen();
  await fireEvent.press(screen.getByText('Add details'));
  await fireEvent.changeText(screen.getByLabelText('Note'), 'A valid note draft');
  for (const value of ['not a url', 'ftp://example.com', `https://example.com/${'a'.repeat(20000)}`]) {
    await fireEvent.changeText(screen.getByPlaceholderText('https://'), value);
    expect(screen.getByTestId('add-save').props.accessibilityState.disabled).toBe(true);
  }
  expect(fakeRepo.__bookmarks()).toHaveLength(0);
});

test('keyboard Next focuses the title after mounting collapsed link details and when already open', async () => {
  fakeRepo.__reset([]);
  const screen = await renderAddScreen();
  const urlInput = screen.getByPlaceholderText('https://');
  expect(screen.queryByLabelText('Title (optional)')).toBeNull();
  await fireEvent(urlInput, 'submitEditing');
  expect(screen.getByLabelText('Title (optional)')).toBeTruthy();
  expect(mockInputFocus).toHaveBeenLastCalledWith('Title (optional)');
  expect(mockInputFocus).toHaveBeenCalledTimes(1);
  await fireEvent(urlInput, 'submitEditing');
  expect(mockInputFocus).toHaveBeenCalledTimes(2);
});


describe('smart Add capture', () => {
  beforeEach(() => { fakeRepo.__reset([]); mockReadClipboard.mockReset(); mockCopyImage.mockReset(); mockCopyImage.mockResolvedValue('file:///durable/image.png'); });
  it('separates commerce text pasted into the URL and persists reviewed fields', async () => {
    const screen = await renderAddScreen();
    await fireEvent.changeText(screen.getByPlaceholderText('https://'), '[특가] 낫또 https://example.com/item?sku=42\n가격 6,990원');
    expect(screen.getByPlaceholderText('https://').props.value).toBe('https://example.com/item?sku=42');
    expect(screen.getByLabelText('Title (optional)').props.value).toBe('[특가] 낫또');
    expect(screen.getByLabelText('Note').props.value).toBe('가격 6,990원');
    await fireEvent.press(screen.getByTestId('add-save'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(fakeRepo.__bookmarks()[0]).toMatchObject({title:'[특가] 낫또', notes:'가격 6,990원'});
  });
  it('previews replacement and keeps user-authored details when declined', async () => {
    const screen = await renderAddScreen();
    await fireEvent.changeText(screen.getByPlaceholderText('https://'), 'https://example.com/draft');
    await fireEvent.press(screen.getByText('Add details'));
    await fireEvent.changeText(screen.getByLabelText('Title (optional)'), 'My title');
    mockReadClipboard.mockResolvedValue({ text:'Replacement https://example.org/new' });
    await fireEvent.press(screen.getByTestId('add-paste'));
    await screen.findByText('Replace draft');
    expect(screen.getByLabelText('Title (optional)').props.value).toBe('My title');
    await fireEvent.press(screen.getByText('Keep editing'));
    expect(screen.getByPlaceholderText('https://').props.value).toBe('https://example.com/draft');
  });
  it('declining mixed text pasted into the URL preserves every existing field', async () => {
    const screen = await renderAddScreen();
    await fireEvent.changeText(screen.getByTestId('add-url'), 'https://example.com/original');
    await fireEvent.press(screen.getByText('Add details'));
    await fireEvent.changeText(screen.getByLabelText('Title (optional)'), 'Original title');
    await fireEvent.changeText(screen.getByLabelText('Note'), 'Original notes');
    await fireEvent.changeText(screen.getByTestId('add-url'), 'Replacement https://example.org/new\nReplacement notes');
    await screen.findByText('Replace draft');
    await fireEvent.press(screen.getByText('Keep editing'));
    expect(screen.getByTestId('add-url').props.value).toBe('https://example.com/original');
    expect(screen.getByLabelText('Title (optional)').props.value).toBe('Original title');
    expect(screen.getByLabelText('Note').props.value).toBe('Original notes');
    await fireEvent.changeText(screen.getByTestId('add-url'), 'https://example.com/originalx');
    expect(screen.getByTestId('add-url').props.value).toBe('https://example.com/originalx');
    expect(screen.queryByText('Replace draft')).toBeNull();
  });
  it('ignores clipboard reads that finish after a mode change', async () => {
    let resolve!: (value: {text:string}) => void;
    mockReadClipboard.mockImplementation(() => new Promise((done) => {resolve=done;}));
    const screen = await renderAddScreen();
    await act(async () => { void (screen.getByTestId('add-paste').props.onClick ?? screen.getByTestId('add-paste').props.onPress)(); });
    await fireEvent.press(screen.getByTestId('add-mode-note'));
    await fireEvent.changeText(screen.getByLabelText('Note'), 'Newer draft');
    await act(async () => resolve({text:'Stale https://example.com'}));
    expect(screen.getByTestId('add-mode-note').props.accessibilityState.selected).toBe(true);
    expect(screen.getByLabelText('Note').props.value).toBe('Newer draft');
  });
  it('image save waits for the durable copy and retains notes', async () => {
    let resolve!: (value:string) => void;
    mockCopyImage.mockImplementationOnce(() => new Promise((done) => {resolve=done;}));
    mockReadClipboard.mockResolvedValue({text:'Caption',image:{uri:'file:///temp.png',mimeType:'image/png',fileName:null}});
    const screen = await renderAddScreen();
    await fireEvent.press(screen.getByTestId('add-paste'));
    await screen.findByText('Save image');
    await fireEvent.changeText(screen.getByLabelText('Title (optional)'), 'Screenshot');
    await act(async () => { void (screen.getByTestId('add-save').props.onClick ?? screen.getByTestId('add-save').props.onPress)(); });
    expect(mockBack).not.toHaveBeenCalled();
    expect(fakeRepo.__bookmarks()).toHaveLength(0);
    await act(async () => resolve('file:///durable/image.png'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(fakeRepo.__bookmarks()[0]).toMatchObject({content_type:'image',title:'Screenshot',notes:'Caption',local_image_uri:'file:///durable/image.png'});
    expect(fakeRepo.__queue()[0].payload.content_type).toBe('image');
  });
  it('failed image copy retries the same capture without acknowledging failed persistence', async () => {
    mockCopyImage.mockRejectedValueOnce(new Error('Disk full'));
    mockReadClipboard.mockResolvedValue({text:'',image:{uri:'file:///temp.png',mimeType:'image/png',fileName:null}});
    const screen = await renderAddScreen();
    await fireEvent.press(screen.getByTestId('add-paste'));
    await screen.findByText('Save image');
    await fireEvent.press(screen.getByTestId('add-save'));
    await screen.findByText(en['add.saveFailed'] as string);
    expect(mockBack).not.toHaveBeenCalled();
    expect(fakeRepo.__bookmarks()).toHaveLength(0);
    await fireEvent.press(screen.getByTestId('add-save'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(mockCopyImage).toHaveBeenCalledTimes(2);
    expect(fakeRepo.__bookmarks()).toHaveLength(1);
    expect(fakeRepo.__queue()).toHaveLength(1);
  });
  it('protects navigation while saving, retains a failed draft, and permits durable dismissal', async () => {
    let failCopy!: (reason: Error) => void;
    mockCopyImage.mockImplementationOnce(() => new Promise((_resolve, reject) => { failCopy = reject; }));
    mockReadClipboard.mockResolvedValue({text:'Retained caption',image:{uri:'file:///temp.png',mimeType:'image/png',fileName:null}});
    const screen = await renderAddScreen();
    await fireEvent.press(screen.getByTestId('add-paste'));
    await screen.findByText('Save image');
    await act(async () => { void (screen.getByTestId('add-save').props.onClick ?? screen.getByTestId('add-save').props.onPress)(); });
    expect(mockRemovalPrevented).toBe(true);
    expect(mockAllowRemoval).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
    await act(async () => failCopy(new Error('disk full')));
    await screen.findByText(en['add.saveFailed'] as string);
    expect(mockRemovalPrevented).toBe(true);
    expect(screen.getByLabelText('Note').props.value).toBe('Retained caption');
    expect(mockBack).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('add-save'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(mockAllowRemoval).toHaveBeenCalledTimes(1);
    expect(mockAllowRemoval.mock.invocationCallOrder[0]).toBeLessThan(mockBack.mock.invocationCallOrder[0]);
    expect(fakeRepo.__bookmarks()[0].notes).toBe('Retained caption');
    expect(fakeRepo.__queue()).toHaveLength(1);
  });
  it('does not navigate after unmount while a save finishes', async () => {
    let resolve!: (value:string) => void;
    mockCopyImage.mockImplementationOnce(() => new Promise((done) => {resolve=done;}));
    mockReadClipboard.mockResolvedValue({text:'',image:{uri:'file:///temp.png',mimeType:'image/png',fileName:null}});
    const screen = await renderAddScreen();
    await fireEvent.press(screen.getByTestId('add-paste'));
    await screen.findByText('Save image');
    await act(async () => { void (screen.getByTestId('add-save').props.onClick ?? screen.getByTestId('add-save').props.onPress)(); });
    await screen.unmount();
    await act(async () => resolve('file:///durable/image.png'));
    expect(mockBack).not.toHaveBeenCalled();
    expect(fakeRepo.__bookmarks()).toHaveLength(1);
  });
  it('image removal retains text and independent mode drafts', async () => {
    mockReadClipboard.mockResolvedValue({text:'Image notes',image:{uri:'file:///temp.png',mimeType:'image/png',fileName:null}});
    const screen = await renderAddScreen();
    await fireEvent.press(screen.getByTestId('add-paste'));
    await screen.findByText('Save image');
    await fireEvent.changeText(screen.getByLabelText('Title (optional)'), 'Caption');
    await fireEvent.press(screen.getByTestId('add-mode-note'));
    await fireEvent.changeText(screen.getByLabelText('Note'), 'Independent note');
    await fireEvent.press(screen.getByTestId('add-mode-image'));
    await fireEvent.press(screen.getByTestId('add-remove-image'));
    expect(screen.getByLabelText('Title (optional)').props.value).toBe('Caption');
    expect(screen.getByLabelText('Note').props.value).toBe('Image notes');
    expect(screen.getByTestId('add-save').props.accessibilityState.disabled).toBe(true);
  });
});

describe('capture persistence recovery after editing', () => {
  beforeEach(() => {
    fakeRepo.__reset([]);
    mockCopyImage.mockReset();
    mockCopyImage.mockResolvedValue('file:///durable/image.png');
    mockReadClipboard.mockReset();
  });
  afterEach(() => jest.restoreAllMocks());
  it.each(['link', 'note', 'image'] as const)('keeps a failed %s capture reachable until that mode is retried', async (mode) => {
    const screen = await renderAddScreen();
    if (mode === 'image') {
      mockReadClipboard.mockResolvedValue({text:'Original image caption',image:{uri:'file:///temp.png',mimeType:'image/png',fileName:'image.png'}});
      await fireEvent.press(screen.getByTestId('add-paste'));
      await screen.findByText('Save image');
    } else if (mode === 'note') {
      await fireEvent.press(screen.getByTestId('add-mode-note'));
      await fireEvent.changeText(screen.getByLabelText('Note'), 'Original note');
    } else {
      await fireEvent.changeText(screen.getByPlaceholderText('https://'), 'https://example.com/failed-mode');
    }
    jest.spyOn(fakeRepo.repository, 'insertBookmark').mockRejectedValueOnce(new Error('Storage unavailable'));
    await fireEvent.press(screen.getByTestId('add-save'));
    await screen.findByText(en['add.saveFailed'] as string);
    const other = mode === 'note' ? 'image' : 'note';
    expect(screen.getByTestId(`add-mode-${other}`).props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByTestId(`add-mode-${other}`));
    mockReadClipboard.mockResolvedValue(mode === 'image' ? {text:'https://example.com/other'} :
      {text:'Another capture',image:{uri:'file:///other.png',mimeType:'image/png',fileName:null}});
    await fireEvent.press(screen.getByTestId('add-paste'));
    expect(screen.getByTestId(`add-mode-${mode}`).props.accessibilityState.selected).toBe(true);
    expect(mockBack).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('add-save'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(fakeRepo.__bookmarks()).toHaveLength(1);
    expect(fakeRepo.__bookmarks()[0].content_type).toBe(mode === 'link' ? 'url' : mode === 'note' ? 'text' : 'image');
    expect(fakeRepo.__queue()).toHaveLength(1);
  });
  it('lets an explicit title clear survive an image-save failure and retry', async () => {
    mockReadClipboard.mockResolvedValue({text:'',image:{uri:'file:///temp.png',mimeType:'image/png',fileName:'photo.png'}});
    const screen = await renderAddScreen();
    await fireEvent.press(screen.getByTestId('add-paste'));
    await screen.findByText('Save image');
    await fireEvent.changeText(screen.getByLabelText('Title (optional)'), 'Title to clear');
    jest.spyOn(fakeRepo.repository, 'insertBookmark').mockRejectedValueOnce(new Error('Storage unavailable'));
    await fireEvent.press(screen.getByTestId('add-save'));
    await screen.findByText(en['add.saveFailed'] as string);
    await fireEvent.changeText(screen.getByLabelText('Title (optional)'), '');
    await fireEvent.press(screen.getByTestId('add-save'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(fakeRepo.__bookmarks()[0].title).toBeNull();
    expect(fakeRepo.__queue()[0].payload.title).toBeNull();
  });
  it('requires explicit abandonment after a failed save before Close or system Back can remove the draft', async () => {
    const screen = await renderAddScreen();
    await fireEvent.press(screen.getByTestId('add-mode-note'));
    await fireEvent.changeText(screen.getByLabelText('Note'), 'Unfinished capture');
    jest.spyOn(fakeRepo.repository, 'insertBookmark').mockRejectedValueOnce(new Error('Storage unavailable'));
    await fireEvent.press(screen.getByTestId('add-save'));
    await screen.findByText(en['add.saveFailed'] as string);
    expect(mockRemovalPrevented).toBe(true);
    await fireEvent.press(screen.getByLabelText('Close'));
    await screen.findByText(en['add.discardPrompt'] as string);
    expect(mockBack).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText('Keep editing'));
    expect(screen.getByLabelText('Note').props.value).toBe('Unfinished capture');
    const repeat = jest.fn();
    await act(async () => { mockPreventedRemoval?.({ repeat }); });
    await screen.findByText(en['add.discardPrompt'] as string);
    expect(repeat).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText(en['add.discardDraft'] as string));
    expect(repeat).toHaveBeenCalledTimes(1);
    expect(mockRemovalPrevented).toBe(false);
  });
  for (const mode of ['link', 'note', 'image'] as const) {
    for (const stage of ['insertBookmark', 'enqueue'] as const) {
      it(`${mode} keeps one edited capture and required queue after ${stage} fails`, async () => {
        const screen = await renderAddScreen();
        if (mode === 'image') {
          mockReadClipboard.mockResolvedValue({text:'Image body',image:{uri:'file:///temp.png',mimeType:'image/png',fileName:null}});
          await fireEvent.press(screen.getByTestId('add-paste'));
          await screen.findByText('Save image');
        } else if (mode === 'note') {
          await fireEvent.press(screen.getByTestId('add-mode-note'));
          await fireEvent.changeText(screen.getByLabelText('Note'), 'Note body');
        } else {
          await fireEvent.changeText(screen.getByPlaceholderText('https://'), 'https://example.com/recovery');
          await fireEvent.press(screen.getByText('Add details'));
        }
        await fireEvent.changeText(screen.getByLabelText('Title (optional)'), 'Before failure');
        jest.spyOn(fakeRepo.repository, stage).mockRejectedValueOnce(new Error('Storage unavailable'));
        await fireEvent.press(screen.getByTestId('add-save'));
        await screen.findByText(en['add.saveFailed'] as string);
        expect(mockBack).not.toHaveBeenCalled();
        const insertedId = fakeRepo.__bookmarks()[0]?.id;
        await fireEvent.changeText(screen.getByLabelText('Title (optional)'), 'After failure');
        await fireEvent.press(screen.getByTestId('add-save'));
        await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
        expect(fakeRepo.__bookmarks()).toHaveLength(1);
        expect(fakeRepo.__bookmarks()[0].title).toBe('After failure');
        if (insertedId) expect(fakeRepo.__bookmarks()[0].id).toBe(insertedId);
        expect(fakeRepo.__queue()).toHaveLength(1);
        expect(fakeRepo.__queue()[0].payload.title).toBe('After failure');
        if (mode === 'image') expect(mockCopyImage).toHaveBeenCalledTimes(1);
      });
    }
  }
  it('retries a failed duplicate row update with the latest user-authored details', async () => {
    fakeRepo.__reset([makeStoredBookmark({title:'A book already saved',title_is_derived:false})]);
    const screen = await renderAddScreen();
    await fireEvent.changeText(screen.getByPlaceholderText('https://'), 'https://example.com/stored');
    await fireEvent.press(screen.getByText('Add details'));
    await fireEvent.changeText(screen.getByLabelText('Title (optional)'), 'Before failure');
    jest.spyOn(fakeRepo.repository,'updateBookmark').mockRejectedValueOnce(new Error('Storage unavailable'));
    await fireEvent.press(screen.getByTestId('add-save'));
    await screen.findByText(en['add.saveFailed'] as string);
    expect(mockBack).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByLabelText('Title (optional)'), 'After failure');
    await fireEvent.press(screen.getByTestId('add-save'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(fakeRepo.__bookmarks()).toHaveLength(1);
    expect(fakeRepo.__bookmarks()[0].title).toBe('After failure');
  });
  it('queues newly edited fields when retrying a failed timestamp-only duplicate save', async () => {
    fakeRepo.__reset([makeStoredBookmark({title:'A book already saved',title_is_derived:false})]);
    const screen = await renderAddScreen();
    await fireEvent.changeText(screen.getByPlaceholderText('https://'), 'https://example.com/stored');
    await fireEvent.press(screen.getByText('Add details'));
    jest.spyOn(fakeRepo.repository,'updateBookmark').mockRejectedValueOnce(new Error('Storage unavailable'));
    await fireEvent.press(screen.getByTestId('add-save'));
    await screen.findByText(en['add.saveFailed'] as string);
    expect(mockBack).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByLabelText('Title (optional)'), 'After failure');
    await fireEvent.press(screen.getByTestId('add-save'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(fakeRepo.__bookmarks()).toHaveLength(1);
    expect(fakeRepo.__bookmarks()[0].title).toBe('After failure');
    expect(fakeRepo.__queue().some((entry) => entry.operation === 'update')).toBe(true);
  });
});


test('changing URL after a failed duplicate save never changes the existing bookmark address', async () => {
  fakeRepo.__reset([makeStoredBookmark({title:'Original saved item',title_is_derived:false})]);
  const screen = await renderAddScreen();
  await fireEvent.changeText(screen.getByPlaceholderText('https://'), 'https://example.com/stored');
  const spy = jest.spyOn(fakeRepo.repository,'updateBookmark').mockRejectedValueOnce(new Error('Storage unavailable'));
  try {
    await fireEvent.press(screen.getByTestId('add-save'));
    await screen.findByText(en['add.saveFailed'] as string);
    await fireEvent.changeText(screen.getByPlaceholderText('https://'), 'https://example.com/different');
    await fireEvent.press(screen.getByTestId('add-save'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(fakeRepo.__bookmarks()).toHaveLength(2);
    expect(fakeRepo.__bookmarks().find((row) => row.id === '7e64cf1e-0000-4000-8000-000000000001')?.url).toBe('https://example.com/stored');
    expect(fakeRepo.__bookmarks().some((row) => row.url === 'https://example.com/different')).toBe(true);
  } finally {spy.mockRestore();}
});
