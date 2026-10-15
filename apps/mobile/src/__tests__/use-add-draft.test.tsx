import { act, renderHook } from '@testing-library/react-native';
import { MAX_ADD_MEMO_LENGTH } from '@/domain/add-draft';
import type { SharedImage } from '@/domain/image-share';
import { useAddDraft } from '@/features/add/use-add-draft';

const mockReadClipboard = jest.fn();
jest.mock('@/share/smart-clipboard', () => ({ readSmartClipboard: () => mockReadClipboard(), releaseOwnedClipboardImage: jest.fn() }));
const image: SharedImage = { uri: 'file:///clipboard.png', mimeType: 'image/png', fileName: null };
const text = 'x'.repeat(MAX_ADD_MEMO_LENGTH);

beforeEach(() => mockReadClipboard.mockReset());

it.each(['note', 'link', 'image'] as const)('accepts exactly 10,000 memo characters for %s', async (kind) => {
  const hook = await renderHook(() => useAddDraft());
  const content = kind === 'link' ? `Title https://example.com\n${text}` : text;
  await act(async () => hook.result.current.offer(content, kind === 'image' ? image : undefined));
  expect(hook.result.current.mode).toBe(kind);
  expect(hook.result.current.draft.memo).toBe(text);
  expect(hook.result.current.status).toBe('ready');
});

it.each(['note', 'link', 'image'] as const)('rejects 10,001 memo characters from clipboard for %s without replacing a draft', async (kind) => {
  const hook = await renderHook(() => useAddDraft());
  await act(async () => hook.result.current.update({ url: 'https://original.com', title: 'Original', memo: 'Keep this' }));
  const original = hook.result.current.draft;
  const content = kind === 'link' ? `Title https://example.com\n${text}x` : `${text}x`;
  mockReadClipboard.mockResolvedValue({ text: content, image: kind === 'image' ? image : undefined });
  await act(async () => hook.result.current.paste());
  expect(hook.result.current.status).toBe('textTooLong');
  expect(hook.result.current.pending).toBeNull();
  await act(async () => { hook.result.current.replace(); });
  expect(hook.result.current.draft).toBe(original);
  expect(hook.result.current.mode).toBe('link');
});

it('rejects an oversized DOM paste before offering replacement and preserves other mode drafts', async () => {
  const hook = await renderHook(() => useAddDraft());
  await act(async () => hook.result.current.changeMode('note'));
  await act(async () => hook.result.current.update({ memo: 'Existing note' }));
  await act(async () => hook.result.current.changeMode('link'));
  await act(async () => hook.result.current.offer(`${text}x`));
  expect(hook.result.current.status).toBe('textTooLong');
  expect(hook.result.current.pending).toBeNull();
  expect(hook.result.current.mode).toBe('link');
  expect(hook.result.current.draft.memo).toBe('');
  await act(async () => hook.result.current.changeMode('note'));
  expect(hook.result.current.draft.memo).toBe('Existing note');
});

it.each([MAX_ADD_MEMO_LENGTH, MAX_ADD_MEMO_LENGTH + 1])('validates image paste accompanying text at length %s', async (length) => {
  const hook = await renderHook(() => useAddDraft());
  await act(async () => hook.result.current.receiveImage(async () => image, 'x'.repeat(length)));
  if (length === MAX_ADD_MEMO_LENGTH) {
    expect(hook.result.current.draft).toMatchObject({ image, memo: text });
    expect(hook.result.current.status).toBe('ready');
  } else {
    expect(hook.result.current.draft.memo).toBe('');
    expect(hook.result.current.draft.image).toBeUndefined();
    expect(hook.result.current.status).toBe('textTooLong');
    expect(hook.result.current.pending).toBeNull();
  }
});

it('keeps an existing image and caption when a new image has an oversized caption', async () => {
  const hook = await renderHook(() => useAddDraft());
  await act(async () => hook.result.current.offer('Original caption', image));
  const original = hook.result.current.draft;
  await act(async () => hook.result.current.receiveImage(async () => ({ ...image, uri: 'file:///new.png' }), `${text}x`));
  expect(hook.result.current.draft).toBe(original);
  expect(hook.result.current.pending).toBeNull();
  expect(hook.result.current.status).toBe('textTooLong');
});
