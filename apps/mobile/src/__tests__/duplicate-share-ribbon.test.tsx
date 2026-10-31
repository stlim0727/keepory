import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);
const mockRouter = { push: jest.fn(), replace: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

import { DuplicateShareRibbon } from '@/features/inbox/DuplicateShareRibbon';
import {
  DUPLICATE_SHARE_NOTICE_KEY,
  dismissDuplicateShareNotice,
  recordDuplicateShareNotice,
  refreshDuplicateShareNotice,
} from '@/share/duplicate-notice';
import type { FakeRepositoryModule } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
const getBookmark = (id: string) => id === 'existing' ? { id } : undefined;
const ribbon = <DuplicateShareRibbon getBookmark={getBookmark} ready maxWidth={600} />;

beforeEach(async () => {
  await fakeRepo.repository.setMeta(DUPLICATE_SHARE_NOTICE_KEY, '');
  await refreshDuplicateShareNotice();
  mockRouter.push.mockClear();
});

test('duplicate confirmation survives a restart and stays until closed', async () => {
  await recordDuplicateShareNotice('existing');
  const first = await render(ribbon);
  await first.findByText('Already in Keepory');
  expect(mockRouter.push).not.toHaveBeenCalled();
  await first.unmount();

  const reopened = await render(ribbon);
  await reopened.findByText('Already in Keepory');
  await fireEvent.press(reopened.getByTestId('duplicate-share-ribbon-close'));
  await waitFor(() => expect(reopened.queryByTestId('duplicate-share-ribbon')).toBeNull());
  expect(await fakeRepo.repository.getMeta(DUPLICATE_SHARE_NOTICE_KEY)).toBe('');
  await reopened.unmount();

  const afterDismiss = await render(ribbon);
  await act(async () => { await refreshDuplicateShareNotice(); });
  expect(afterDismiss.queryByTestId('duplicate-share-ribbon')).toBeNull();
});

test('View opens the existing item only on a tap and acknowledges the ribbon', async () => {
  const screen = await render(ribbon);
  await act(async () => { await recordDuplicateShareNotice('existing'); });
  await fireEvent.press(await screen.findByText('View'));
  expect(mockRouter.push).toHaveBeenCalledWith('/bookmark/existing');
  await waitFor(() => expect(screen.queryByTestId('duplicate-share-ribbon')).toBeNull());
});

test('closing a stale notice cannot erase a newer duplicate', async () => {
  await recordDuplicateShareNotice('old');
  const old = JSON.parse((await fakeRepo.repository.getMeta(DUPLICATE_SHARE_NOTICE_KEY))!);
  // Queue a new share before a delayed press on the previously rendered ribbon.
  const saving = recordDuplicateShareNotice('existing');
  const dismissing = dismissDuplicateShareNotice(old.id);
  await saving;
  await dismissing;
  const screen = await render(ribbon);
  await screen.findByText('Already in Keepory');
  const stored = JSON.parse((await fakeRepo.repository.getMeta(DUPLICATE_SHARE_NOTICE_KEY))!);
  expect(stored.bookmarkId).toBe('existing');
});

test('hides inaccessible items and waits for account hydration', async () => {
  await recordDuplicateShareNotice('other-account');
  const screen = await render(ribbon);
  await act(async () => { await refreshDuplicateShareNotice(); });
  expect(screen.queryByTestId('duplicate-share-ribbon')).toBeNull();
  await screen.rerender(<DuplicateShareRibbon getBookmark={getBookmark} ready={false} maxWidth={600} />);
  // Startup preferences can become readable only after the library finishes
  // hydrating, without a foreground transition or an in-process notification.
  await fakeRepo.repository.setMeta(DUPLICATE_SHARE_NOTICE_KEY,
    JSON.stringify({ id: 'loaded-after-hydration', bookmarkId: 'existing' }));
  expect(screen.queryByTestId('duplicate-share-ribbon')).toBeNull();
  await screen.rerender(ribbon);
  await screen.findByText('Already in Keepory');
});

test('a failed preference write still shows a dismissible session confirmation', async () => {
  const screen = await render(ribbon);
  await act(async () => { await refreshDuplicateShareNotice(); });
  const setMeta = jest.spyOn(fakeRepo.repository, 'setMeta').mockRejectedValueOnce(new Error('disk full'));
  try {
    await act(async () => { await recordDuplicateShareNotice('existing'); });
    await screen.findByText('Already in Keepory');
    await fireEvent.press(screen.getByTestId('duplicate-share-ribbon-close'));
    await waitFor(() => expect(screen.queryByTestId('duplicate-share-ribbon')).toBeNull());
  } finally {
    setMeta.mockRestore();
  }
});
