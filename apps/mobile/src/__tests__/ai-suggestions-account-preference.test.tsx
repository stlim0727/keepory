import { StrictMode, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AI_SUGGESTIONS_MODE_PREF_KEY as KEY } from '@/domain/ai-suggestions-pref';
import type { SupabaseAuthSession } from '@/supabase/types';
import { SupabaseRequestError } from '@/supabase/client';

jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);
const mockCloudModes: Record<string, string> = {};
const mockGetUser = jest.fn();
let mockOnForeground: (() => void) | undefined;
jest.mock('@/storage/sqlite-app-lifecycle', () => ({
  registerForBackgroundClose: () => {},
  registerForForegroundState: (handler: { onForeground?: () => void }) => {
    mockOnForeground = handler.onForeground;
    return () => { mockOnForeground = undefined; };
  },
}));
const mockPublish = jest.fn(async (_token: string, _data: { ai_suggestions_mode: string }) => ({}));
jest.mock('@/supabase/client', () => ({
  ...jest.requireActual('@/supabase/client'),
  createSupabaseClient: () => ({ updateUserMetadata: mockPublish, getUser: mockGetUser }),
}));
jest.mock('@/store/bookmarks/helpers', () => ({ logStorageError: jest.fn() }));

import { useAiSuggestionsPreference } from '@/store/bookmarks/use-ai-suggestions-preference';
import type { FakeRepositoryModule } from './helpers/fake-repository';
const fake = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
const accountKey = (id: string) => `${KEY}.account.${id}`;
function auth(id: string, mode?: string, status = 'authenticated') {
  if (mode) mockCloudModes[id] = mode;
  const session = {
    access_token: `token-${id}`,
    user: { id, is_anonymous: status === 'anonymous', user_metadata: mode ? { ai_suggestions_mode: mode } : {} },
  } as SupabaseAuthSession;
  return { userId: id, status, session, credentialRecoveryVersion: 0 };
}
beforeEach(() => {
  fake.__reset([]);
  for (const id of Object.keys(mockCloudModes)) delete mockCloudModes[id];
  mockPublish.mockReset().mockImplementation(async (token: string, data: { ai_suggestions_mode: string }) => {
    mockCloudModes[token.replace('token-', '')] = data.ai_suggestions_mode;
    return {};
  });
  mockGetUser.mockReset().mockImplementation(async (token: string) => ({
    id: token.replace('token-', ''),
    user_metadata: { ai_suggestions_mode: mockCloudModes[token.replace('token-', '')] },
  }));
});

test('guest OFF becomes automatic recommendations and application at first login, including linking the same anonymous ID', async () => {
  await fake.repository.setMeta(KEY, 'off');
  const { result, rerender } = await renderHook(useAiSuggestionsPreference, {
    initialProps: auth('A', undefined, 'anonymous'),
  });
  await waitFor(() => expect(fake.__meta(KEY)).toBe('off'));
  await rerender(auth('A'));
  await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('auto_accept'));
  await waitFor(() => expect(mockPublish).toHaveBeenCalledWith('token-A', { ai_suggestions_mode: 'auto_accept' }));
  expect(fake.__meta(KEY)).toBe('off');
});

test('each account restores its own saved preference after switching and relaunching', async () => {
  const { result, rerender, unmount } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A') });
  await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('auto_accept'));
  await act(() => result.current.setAiSuggestionsMode('off'));
  await waitFor(() => expect(fake.__meta(accountKey('A'))).toBe('off'));
  await rerender(auth('B'));
  await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('auto_accept'));
  await act(() => result.current.setAiSuggestionsMode('auto_accept'));
  await waitFor(() => expect(fake.__meta(accountKey('B'))).toBe('auto_accept'));
  await rerender(auth('A'));
  await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('off'));
  await unmount();
  const again = await renderHook(useAiSuggestionsPreference, { initialProps: auth('B') });
  await waitFor(() => expect(again.result.current.aiSuggestionsMode).toBe('auto_accept'));
});

test('login restores the cloud preference on another device', async () => {
  const { result } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A', 'off') });
  await waitFor(() => expect(fake.__meta(accountKey('A'))).toBe('off'));
  expect(result.current.aiSuggestionsMode).toBe('off');
  expect(mockPublish).not.toHaveBeenCalled();
});

test('offline changes are retried on login and take priority over old cloud data', async () => {
  mockPublish.mockRejectedValue(new Error('offline'));
  const first = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A', 'confirm') });
  await waitFor(() => expect(first.result.current.aiSuggestionsMode).toBe('confirm'));
  await act(() => first.result.current.setAiSuggestionsMode('off'));
  await waitFor(() => expect(fake.__meta(`${accountKey('A')}.pending`)).toBe('off'));
  await first.unmount();
  mockPublish.mockResolvedValue({});
  const next = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A', 'confirm') });
  await waitFor(() => expect(next.result.current.aiSuggestionsMode).toBe('off'));
  await waitFor(() => expect(fake.__meta(`${accountKey('A')}.pending`)).toBe(''));
});

test('rapid toggles publish in order and finish with the latest setting', async () => {
  const { result } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A', 'confirm') });
  await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('confirm'));
  await act(() => {
    result.current.setAiSuggestionsMode('off');
    result.current.setAiSuggestionsMode('auto_accept');
  });
  await waitFor(() => expect(mockPublish).toHaveBeenCalledTimes(2));
  expect(mockPublish.mock.calls.map((call) => call)).toEqual([
    ['token-A', { ai_suggestions_mode: 'off' }],
    ['token-A', { ai_suggestions_mode: 'auto_accept' }],
  ]);
  expect(fake.__meta(accountKey('A'))).toBe('auto_accept');
});

test('an edit during hydration cannot be overwritten by the older stored value', async () => {
  let release!: (value: string | null) => void;
  const read = jest.spyOn(fake.repository, 'getMeta').mockImplementationOnce(
    () => new Promise((resolve) => { release = resolve; }),
  );
  const { result } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A', 'confirm') });
  await waitFor(() => expect(release).toBeDefined());
  await act(() => result.current.setAiSuggestionsMode('off'));
  await act(async () => { release('auto_accept'); });
  expect(result.current.aiSuggestionsMode).toBe('off');
  await waitFor(() => expect(fake.__meta(accountKey('A'))).toBe('off'));
  read.mockRestore();
});

test('an in-flight account write retains its original account when login changes', async () => {
  let complete!: () => void;
  mockPublish.mockImplementationOnce(() => new Promise((resolve) => {
    complete = () => resolve({});
  }));
  const { result, rerender } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A', 'confirm') });
  await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('confirm'));
  await act(() => result.current.setAiSuggestionsMode('off'));
  await waitFor(() => expect(complete).toBeDefined());
  await rerender(auth('B', 'auto_accept'));
  await act(async () => { complete(); });
  await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('auto_accept'));
  expect(mockPublish).toHaveBeenCalledWith('token-A', { ai_suggestions_mode: 'off' });
  expect(fake.__meta(accountKey('A'))).toBe('off');
  expect(fake.__meta(accountKey('B'))).toBe('auto_accept');
});


test('fresh server metadata wins over a stale cached session and local cache', async () => {
  await fake.repository.setMeta(accountKey('A'), 'confirm');
  mockGetUser.mockResolvedValue({ id: 'A', user_metadata: { ai_suggestions_mode: 'off' } });
  const { result } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A', 'confirm') });
  await waitFor(() => expect(fake.__meta(accountKey('A'))).toBe('off'));
  expect(result.current.aiSuggestionsMode).toBe('off');
  expect(mockGetUser).toHaveBeenCalledWith('token-A');
  expect(mockPublish).not.toHaveBeenCalled();
});


test('a slow cloud write does not delay durability of the next choice or clear it early', async () => {
  let complete!: () => void;
  mockPublish.mockImplementationOnce(() => new Promise((resolve) => {
    complete = () => resolve({});
  }));
  const { result } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A', 'confirm') });
  await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('confirm'));
  await act(() => result.current.setAiSuggestionsMode('off'));
  await waitFor(() => expect(complete).toBeDefined());
  await act(() => result.current.setAiSuggestionsMode('auto_accept'));
  await waitFor(() => expect(fake.__meta(accountKey('A'))).toBe('auto_accept'));
  expect(fake.__meta(`${accountKey('A')}.pending`)).toBe('auto_accept');
  expect(mockPublish).toHaveBeenCalledTimes(1);
  let completeLatest!: () => void;
  mockPublish.mockImplementationOnce(() => new Promise((resolve) => {
    completeLatest = () => resolve({});
  }));
  await act(async () => { complete(); });
  await waitFor(() => expect(completeLatest).toBeDefined());
  expect(fake.__meta(`${accountKey('A')}.pending`)).toBe('auto_accept');
  await act(async () => { completeLatest(); });
  await waitFor(() => expect(fake.__meta(`${accountKey('A')}.pending`)).toBe(''));
});

test('an unknown cloud setting stays OFF and is never published as a first-login default', async () => {
  mockCloudModes.A = 'off';
  mockGetUser.mockRejectedValue(new Error('offline'));
  const first = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A') });
  await act(async () => { await first.result.current.awaitAiSuggestionsPreference(); });
  expect(first.result.current.aiSuggestionsMode).toBe('off');
  expect(fake.__meta(accountKey('A'))).toBeNull();
  expect(fake.__meta(`${accountKey('A')}.pending`)).toBeNull();
  expect(mockPublish).not.toHaveBeenCalled();
  await first.unmount();
  mockGetUser.mockResolvedValue({ id: 'A', user_metadata: { ai_suggestions_mode: 'off' } });
  const again = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A') });
  await act(async () => { await again.result.current.awaitAiSuggestionsPreference(); });
  expect(again.result.current.aiSuggestionsMode).toBe('off');
  expect(mockPublish).not.toHaveBeenCalled();
});

test('a retained real session keeps its account OFF throughout a refresh', async () => {
  await fake.repository.setMeta(KEY, 'auto_accept');
  const { result, rerender } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A', 'off') });
  await act(async () => { await result.current.awaitAiSuggestionsPreference(); });
  const reads = mockGetUser.mock.calls.length;
  await rerender({ ...auth('A', 'off'), status: 'loading' });
  await act(async () => { await result.current.awaitAiSuggestionsPreference(); });
  expect(result.current.aiSuggestionsMode).toBe('off');
  expect(result.current.aiSuggestionsModeRef.current).toBe('off');
  expect(mockGetUser).toHaveBeenCalledTimes(reads);
  expect(fake.__meta(KEY)).toBe('auto_accept');
});

test('the pending edit survives a crash before its account cache write', async () => {
  const original = fake.repository.setMeta.bind(fake.repository);
  const write = jest.spyOn(fake.repository, 'setMeta');
  const first = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A', 'confirm') });
  await act(async () => { await first.result.current.awaitAiSuggestionsPreference(); });
  write.mockImplementation(async (key, value) => {
    if (key === accountKey('A') && value === 'off') throw new Error('app stopped before cache write');
    await original(key, value);
  });
  await act(() => first.result.current.setAiSuggestionsMode('off'));
  await waitFor(() => expect(fake.__meta(`${accountKey('A')}.pending`)).toBe('off'));
  await waitFor(() => expect(write).toHaveBeenCalledWith(accountKey('A'), 'off'));
  await first.unmount();
  write.mockRestore();
  const again = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A', 'confirm') });
  await waitFor(() => expect(again.result.current.aiSuggestionsMode).toBe('off'));
  await waitFor(() => expect(mockPublish).toHaveBeenCalledWith('token-A', { ai_suggestions_mode: 'off' }));
});

test.each(['off', 'confirm'])('an authenticated upgrade preserves its legacy %s setting', async (mode) => {
  await fake.repository.setMeta(KEY, mode);
  await fake.repository.setMeta('bookmark_cache_owner', JSON.stringify({ id: 'A', isAnonymous: false }));
  const { result } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A') });
  await waitFor(() => expect(result.current.aiSuggestionsMode).toBe(mode));
  await waitFor(() => expect(mockPublish).toHaveBeenCalledWith('token-A', { ai_suggestions_mode: mode }));
});

test('an anonymous owner with the same linked ID does not migrate its legacy OFF', async () => {
  await fake.repository.setMeta(KEY, 'off');
  await fake.repository.setMeta('bookmark_cache_owner', JSON.stringify({ id: 'A', isAnonymous: true }));
  const { result } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A') });
  await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('auto_accept'));
});

test('preference readiness waits for the account metadata before permitting a pull', async () => {
  let complete!: (user: unknown) => void;
  mockGetUser.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  const { result } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A') });
  await waitFor(() => expect(complete).toBeDefined());
  let ready = false;
  const waiting = result.current.awaitAiSuggestionsPreference().then(() => { ready = true; });
  await act(async () => { await Promise.resolve(); });
  expect(ready).toBe(false);
  await act(async () => { complete({ id: 'A', user_metadata: {} }); await waiting; });
  expect(ready).toBe(true);
  expect(result.current.aiSuggestionsModeRef.current).toBe('auto_accept');
});

test('a failed read ignores stale cached session auto_accept without a durable account preference', async () => {
  const session = auth('A', 'auto_accept');
  mockCloudModes.A = 'off';
  mockGetUser.mockRejectedValue(new Error('offline'));
  const { result } = await renderHook(useAiSuggestionsPreference, { initialProps: session });
  await act(async () => { await result.current.awaitAiSuggestionsPreference(); });
  expect(result.current.aiSuggestionsMode).toBe('off');
  expect(result.current.aiSuggestionsReadyRef.current).toBe(false);
  expect(fake.__meta(accountKey('A'))).toBeNull();
  expect(mockPublish).not.toHaveBeenCalled();
});

test.each(['token', 'recovery'])('%s recovery retries a failed pending edit without switching accounts', async (change) => {
  mockPublish.mockRejectedValueOnce(new Error('expired token'));
  const original = auth('A', 'confirm');
  const { result, rerender } = await renderHook(useAiSuggestionsPreference, { initialProps: original });
  await act(async () => { await result.current.awaitAiSuggestionsPreference(); });
  await act(() => result.current.setAiSuggestionsMode('off'));
  await waitFor(() => expect(mockPublish).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(fake.__meta(`${accountKey('A')}.pending`)).toBe('off'));
  const reads = mockGetUser.mock.calls.length;
  const token = change === 'token' ? 'fresh-A' : original.session.access_token;
  await rerender({ ...original, session: { ...original.session, access_token: token }, credentialRecoveryVersion: 1 });
  await waitFor(() => expect(mockPublish).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(mockPublish).toHaveBeenLastCalledWith(token, { ai_suggestions_mode: 'off' }));
  await waitFor(() => expect(fake.__meta(`${accountKey('A')}.pending`)).toBe(''));
  expect(result.current.aiSuggestionsMode).toBe('off');
  expect(mockGetUser).toHaveBeenCalledTimes(reads);
});

test('reconnect publishes an offline edit for the same account and bearer', async () => {
  const original = auth('A', 'confirm');
  await fake.repository.setMeta(accountKey('A'), 'confirm');
  const { result, rerender } = await renderHook(
    ({ account, offline }: { account: ReturnType<typeof auth>; offline: boolean }) => useAiSuggestionsPreference(account, offline),
    { initialProps: { account: original, offline: true } },
  );
  await act(async () => { await result.current.awaitAiSuggestionsPreference(); });
  await act(() => result.current.setAiSuggestionsMode('off'));
  await waitFor(() => expect(fake.__meta(`${accountKey('A')}.pending`)).toBe('off'));
  expect(mockPublish).not.toHaveBeenCalled();
  await rerender({ account: original, offline: false });
  await waitFor(() => expect(mockPublish).toHaveBeenCalledWith('token-A', { ai_suggestions_mode: 'off' }));
  await waitFor(() => expect(fake.__meta(`${accountKey('A')}.pending`)).toBe(''));
});

test('local ownership readiness completes while the remote mode read is still stalled', async () => {
  let finish!: (user: unknown) => void;
  mockGetUser.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await fake.repository.setMeta('bookmark_cache_owner', JSON.stringify({ id: 'A', isAnonymous: false }));
  const { result } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A') });
  await act(async () => { await result.current.awaitAiSuggestionsLocalReady(); });
  await waitFor(() => expect(finish).toBeDefined());
  expect(result.current.aiSuggestionsReadyRef.current).toBe(false);
  await act(async () => { finish({ id: 'A', user_metadata: {} }); await result.current.awaitAiSuggestionsPreference(); });
  expect(result.current.aiSuggestionsMode).toBe('auto_accept');
});

test('an online transient read failure retries safely without a token or connectivity change', async () => {
  jest.useFakeTimers();
  try {
    mockGetUser.mockRejectedValueOnce(new Error('temporary server error'));
    const { result } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A') });
    await act(async () => { await result.current.awaitAiSuggestionsPreference(); });
    expect(result.current.aiSuggestionsMode).toBe('off');
    expect(mockGetUser).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(29_999); });
    expect(mockGetUser).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(1); });
    await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('auto_accept'));
    expect(mockGetUser).toHaveBeenCalledTimes(2);
  } finally { jest.useRealTimers(); }
});

test('an imperative fresh session hydrates its mode before React commits the new bearer', async () => {
  const original = auth('A', 'auto_accept');
  const { result, rerender } = await renderHook(useAiSuggestionsPreference, { initialProps: original });
  await act(async () => { await result.current.awaitAiSuggestionsPreference(); });
  mockGetUser.mockResolvedValue({ id: 'A', user_metadata: { ai_suggestions_mode: 'off' } });
  const fresh = { ...original.session, access_token: 'fresh-before-render' };
  await act(async () => { await result.current.awaitAiSuggestionsPreference(fresh); });
  expect(mockGetUser).toHaveBeenLastCalledWith('fresh-before-render');
  expect(result.current.aiSuggestionsMode).toBe('off');
  const reads = mockGetUser.mock.calls.length;
  await rerender({ ...original, session: fresh, credentialRecoveryVersion: 1 });
  await act(async () => { await result.current.awaitAiSuggestionsPreference(); });
  expect(result.current.aiSuggestionsMode).toBe('off');
  expect(mockGetUser).toHaveBeenCalledTimes(reads);
});

test('a rejected settings write forces same-account credential recovery and retries once while idle', async () => {
  const original = auth('A', 'confirm');
  const fresh = { ...original.session, access_token: 'recovered-A' };
  const recover = jest.fn(async () => fresh);
  mockPublish.mockRejectedValueOnce(new SupabaseRequestError('expired', 401));
  const { result } = await renderHook(useAiSuggestionsPreference, {
    initialProps: { ...original, ensureAnonymousSession: recover },
  });
  await act(async () => { await result.current.awaitAiSuggestionsPreference(); });
  await act(() => result.current.setAiSuggestionsMode('off'));
  await waitFor(() => expect(mockPublish).toHaveBeenCalledTimes(2));
  expect(recover).toHaveBeenCalledWith(true);
  expect(mockPublish).toHaveBeenLastCalledWith('recovered-A', { ai_suggestions_mode: 'off' });
  await waitFor(() => expect(fake.__meta(`${accountKey('A')}.pending`)).toBe(''));
});

test('credential recovery returning another account does not publish the pending edit there', async () => {
  const original = auth('A', 'confirm');
  const recover = jest.fn(async () => auth('B').session);
  mockPublish.mockRejectedValueOnce(new SupabaseRequestError('expired', 401));
  const { result } = await renderHook(useAiSuggestionsPreference, {
    initialProps: { ...original, ensureAnonymousSession: recover },
  });
  await act(async () => { await result.current.awaitAiSuggestionsPreference(); });
  await act(() => result.current.setAiSuggestionsMode('off'));
  await waitFor(() => expect(recover).toHaveBeenCalledTimes(1));
  expect(mockPublish).toHaveBeenCalledTimes(1);
  expect(fake.__meta(`${accountKey('A')}.pending`)).toBe('off');
});

test('a settings callback from the departed account cannot alter or publish the active account mode', async () => {
  const { result, rerender } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A') });
  await act(async () => { await result.current.awaitAiSuggestionsPreference(); });
  await waitFor(() => expect(fake.__meta(`${accountKey('A')}.pending`)).toBe(''));
  const staleSetter = result.current.setAiSuggestionsMode;
  await rerender(auth('B', 'off'));
  await act(async () => { await result.current.awaitAiSuggestionsPreference(); });
  const publications = mockPublish.mock.calls.length;
  await act(() => staleSetter('confirm'));
  expect(result.current.aiSuggestionsMode).toBe('off');
  expect(mockPublish).toHaveBeenCalledTimes(publications);
  expect(fake.__meta(accountKey('A'))).toBe('auto_accept');
  expect(fake.__meta(accountKey('B'))).toBe('off');
});

test('a metadata response for another user cannot initialize or publish this account preference', async () => {
  mockGetUser.mockResolvedValue({ id: 'B', user_metadata: { ai_suggestions_mode: 'auto_accept' } });
  const { result } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A') });
  await act(async () => { await result.current.awaitAiSuggestionsPreference(); });
  expect(result.current.aiSuggestionsMode).toBe('off');
  expect(mockPublish).not.toHaveBeenCalled();
  expect(fake.__meta(accountKey('A'))).toBeNull();
});

test.each(['network', '401'])('a late %s publication failure after unmount does not restart background preference requests', async (failure) => {
  jest.useFakeTimers();
  try {
    let rejectPublication!: (error: Error) => void;
    mockPublish.mockImplementationOnce(() => new Promise((_, reject) => { rejectPublication = reject; }));
    const original = auth('A', 'confirm');
    const recover = jest.fn(async () => original.session);
    const { result, unmount } = await renderHook(useAiSuggestionsPreference, { initialProps: { ...original, ensureAnonymousSession: recover } });
    await act(async () => { await result.current.awaitAiSuggestionsPreference(); });
    await act(() => result.current.setAiSuggestionsMode('off'));
    await waitFor(() => expect(rejectPublication).toBeDefined());
    await unmount();
    await act(async () => { rejectPublication(failure === '401' ? new SupabaseRequestError('late expiry', 401) : new Error('late network failure')); });
    await act(async () => { jest.advanceTimersByTime(30_000); });
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockGetUser).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
    expect(fake.__meta(`${accountKey('A')}.pending`)).toBe('off');
  } finally { jest.useRealTimers(); }
});


test('StrictMode effect replay still initializes the first-login account mode', async () => {
  const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
  const { result } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A'), wrapper });
  await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('auto_accept'));
  expect(result.current.aiSuggestionsReady).toBe(true);
});

test('an old provider acknowledgement cannot clear a new provider pending setting', async () => {
  let acknowledge!: () => void;
  mockPublish.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = () => resolve({}); }));
  const { result, unmount } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A', 'confirm') });
  await act(async () => { await result.current.awaitAiSuggestionsPreference(); });
  await act(() => result.current.setAiSuggestionsMode('off'));
  await waitFor(() => expect(acknowledge).toBeDefined());
  await unmount();
  await fake.repository.setMeta(`${accountKey('A')}.pending`, 'auto_accept');
  await act(async () => { acknowledge(); });
  expect(fake.__meta(`${accountKey('A')}.pending`)).toBe('auto_accept');
});


test.each(['off', 'confirm'])('an ownership read failure retries without replacing legacy %s', async (mode) => {
  jest.useFakeTimers();
  const getMeta = jest.spyOn(fake.repository, 'getMeta');
  try {
    await fake.repository.setMeta(KEY, mode);
    await fake.repository.setMeta('bookmark_cache_owner', JSON.stringify({ id: 'A', isAnonymous: false }));
    getMeta.mockRejectedValueOnce(new Error('temporary disk read failure'));
    const { result } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A') });
    await act(async () => { await expect(result.current.awaitAiSuggestionsLocalReady()).rejects.toThrow('temporary disk read failure'); });
    expect(result.current.aiSuggestionsReady).toBe(false);
    expect(mockPublish).not.toHaveBeenCalled();
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await waitFor(() => expect(result.current.aiSuggestionsMode).toBe(mode));
    await waitFor(() => expect(mockPublish).toHaveBeenCalledWith('token-A', { ai_suggestions_mode: mode }));
  } finally { getMeta.mockRestore(); jest.useRealTimers(); }
});

test('an offline owner read failure retries locally without publishing a default', async () => {
  jest.useFakeTimers();
  const getMeta = jest.spyOn(fake.repository, 'getMeta');
  try {
    await fake.repository.setMeta('bookmark_cache_owner', JSON.stringify({ id: 'A', isAnonymous: false }));
    await fake.repository.setMeta(accountKey('A'), 'off');
    getMeta.mockRejectedValueOnce(new Error('offline disk read error'));
    const { result } = await renderHook(
      (props: { auth: ReturnType<typeof auth>; offline: boolean }) => useAiSuggestionsPreference(props.auth, props.offline),
      { initialProps: { auth: auth('A'), offline: true } }
    );
    await act(async () => { await expect(result.current.awaitAiSuggestionsLocalReady()).rejects.toThrow('offline disk read error'); });
    expect(result.current.aiSuggestionsReady).toBe(false);
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await waitFor(() => expect(result.current.aiSuggestionsReady).toBe(true));
    expect(result.current.aiSuggestionsMode).toBe('off');
    expect(result.current.localRecoveryVersion).toBe(1);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  } finally { getMeta.mockRestore(); jest.useRealTimers(); }
});

test('a preference read 401 retries upon credential recovery for the same permanent account', async () => {
  const original = auth('A');
  const fresh = { ...original.session, access_token: 'recovered-A' };
  mockGetUser.mockRejectedValueOnce(new SupabaseRequestError('expired', 401));
  mockGetUser.mockResolvedValueOnce({ id: 'A', user_metadata: { ai_suggestions_mode: 'confirm' } });
  const { result, rerender } = await renderHook(useAiSuggestionsPreference, {
    initialProps: original,
  });
  await act(async () => { await result.current.awaitAiSuggestionsPreference(); });
  expect(result.current.aiSuggestionsReady).toBe(false);
  await rerender({ ...original, session: fresh, credentialRecoveryVersion: 1 });
  await act(async () => { await result.current.awaitAiSuggestionsPreference(); });
  expect(result.current.aiSuggestionsMode).toBe('confirm');
  expect(mockGetUser).toHaveBeenLastCalledWith('recovered-A');
  expect(result.current.aiSuggestionsReady).toBe(true);
});

test.each(['off', 'confirm'])('interrupted anonymous linking never migrates guest %s on relaunch', async (mode) => {
  await fake.repository.setMeta(KEY, mode);
  await fake.repository.setMeta('bookmark_cache_owner', JSON.stringify({ id: 'A', isAnonymous: true }));
  let finish!: (value: unknown) => void;
  mockGetUser.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const first = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A') });
  await act(async () => { await first.result.current.awaitAiSuggestionsLocalReady(); });
  await fake.repository.setMeta('bookmark_cache_owner', JSON.stringify({ id: 'A', isAnonymous: false }));
  await first.unmount();
  const next = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A') });
  await waitFor(() => expect(next.result.current.aiSuggestionsMode).toBe('auto_accept'));
  await waitFor(() => expect(mockPublish).toHaveBeenCalledWith('token-A', { ai_suggestions_mode: 'auto_accept' }));
  await act(async () => { finish({ id: 'A', user_metadata: {} }); });
});

test('account switch hides the departed mode during loading but token refresh preserves it', async () => {
  const { result, rerender } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A', 'auto_accept') });
  await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('auto_accept'));
  let finishA!: (value: unknown) => void;
  mockGetUser.mockImplementationOnce(() => new Promise((resolve) => { finishA = resolve; }));
  const freshA = auth('A');
  freshA.session.access_token = 'fresh-A';
  await rerender(freshA);
  expect(result.current.aiSuggestionsMode).toBe('auto_accept');
  await act(async () => { finishA({ id: 'A', user_metadata: { ai_suggestions_mode: 'auto_accept' } }); });
  let finishB!: (value: unknown) => void;
  mockGetUser.mockImplementationOnce(() => new Promise((resolve) => { finishB = resolve; }));
  await rerender(auth('B'));
  expect(result.current.aiSuggestionsMode).toBe('off');
  expect(result.current.aiSuggestionsReady).toBe(false);
  await act(async () => { finishB({ id: 'B', user_metadata: { ai_suggestions_mode: 'off' } }); });
  expect(result.current.aiSuggestionsMode).toBe('off');
});


test.each(['off', 'confirm'])('cold auth restoration preserves legacy %s without guest provenance', async (mode) => {
  await fake.repository.setMeta(KEY, mode);
  await fake.repository.setMeta('bookmark_cache_owner', JSON.stringify({ id: 'A', isAnonymous: false }));
  const { result, rerender } = await renderHook(
    (value: Parameters<typeof useAiSuggestionsPreference>[0]) => useAiSuggestionsPreference(value),
    { initialProps: { status: 'loading', session: null, userId: null } as Parameters<typeof useAiSuggestionsPreference>[0] },
  );
  await act(async () => { await result.current.awaitAiSuggestionsLocalReady(); });
  expect(fake.__meta(`${KEY}.legacy_guest`)).toBeNull();
  await rerender(auth('A'));
  await waitFor(() => expect(result.current.aiSuggestionsMode).toBe(mode));
  await waitFor(() => expect(mockPublish).toHaveBeenCalledWith('token-A', { ai_suggestions_mode: mode }));
});

test('a late guest session cannot replace the linked permanent account OFF policy', async () => {
  await fake.repository.setMeta(KEY, 'auto_accept');
  const guest = auth('A', undefined, 'anonymous');
  const { result, rerender } = await renderHook(useAiSuggestionsPreference, { initialProps: guest });
  await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('auto_accept'));
  await rerender(auth('A', 'off'));
  await waitFor(() => expect(result.current.aiSuggestionsReady).toBe(true));
  await act(async () => { await result.current.awaitAiSuggestionsPreference(guest.session); });
  expect(result.current.aiSuggestionsModeRef.current).toBe('off');
  expect(result.current.aiSuggestionsReadyRef.current).toBe(true);
});

test('an old bearer cannot roll back an already refreshed policy', async () => {
  const original = auth('A', 'auto_accept');
  const { result, rerender } = await renderHook(useAiSuggestionsPreference, { initialProps: original });
  await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('auto_accept'));
  const fresh = { ...original.session, access_token: 'fresh-A' };
  mockGetUser.mockResolvedValue({ id: 'A', user_metadata: { ai_suggestions_mode: 'off' } });
  await act(async () => { await result.current.awaitAiSuggestionsPreference(fresh); });
  await rerender({ ...original, session: fresh });
  const reads = mockGetUser.mock.calls.length;
  await act(async () => { await result.current.awaitAiSuggestionsPreference(original.session); });
  expect(mockGetUser).toHaveBeenCalledTimes(reads);
  expect(result.current.aiSuggestionsModeRef.current).toBe('off');
});

test('an idle preference read 401 forces the central provider to recover the same account once', async () => {
  const original = auth('A');
  const fresh = { ...original.session, access_token: 'recovered-A' };
  const ensureAnonymousSession = jest.fn(async () => fresh);
  mockGetUser.mockRejectedValueOnce(new SupabaseRequestError('rejected', 401));
  mockGetUser.mockResolvedValueOnce({ id: 'A', user_metadata: { ai_suggestions_mode: 'off' } });
  const { result } = await renderHook(useAiSuggestionsPreference, { initialProps: { ...original, ensureAnonymousSession } });
  await waitFor(() => expect(result.current.aiSuggestionsReady).toBe(true));
  expect(ensureAnonymousSession).toHaveBeenCalledTimes(1);
  expect(ensureAnonymousSession).toHaveBeenCalledWith(true);
  expect(mockGetUser).toHaveBeenLastCalledWith('recovered-A');
  expect(result.current.aiSuggestionsMode).toBe('off');
});

test('read recovery cannot hydrate another account or publish its default', async () => {
  const ensureAnonymousSession = jest.fn(async () => auth('B').session);
  mockGetUser.mockRejectedValueOnce(new SupabaseRequestError('rejected', 401));
  const { result } = await renderHook(useAiSuggestionsPreference, { initialProps: { ...auth('A'), ensureAnonymousSession } });
  await act(async () => { await result.current.awaitAiSuggestionsPreference(); });
  expect(result.current.aiSuggestionsReady).toBe(false);
  expect(mockGetUser).toHaveBeenCalledTimes(1);
  expect(mockPublish).not.toHaveBeenCalled();
});

test('a failed pending-marker write retains the desired edit and retries durability before publication', async () => {
  jest.useFakeTimers();
  const setMeta = jest.spyOn(fake.repository, 'setMeta');
  try {
    const { result } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A', 'confirm') });
    await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('confirm'));
    setMeta.mockRejectedValueOnce(new Error('temporary write failure'));
    await act(async () => { result.current.setAiSuggestionsMode('off'); });
    expect(fake.__meta(`${accountKey('A')}.pending`)).toBeNull();
    expect(mockCloudModes.A).toBe('confirm');
    expect(result.current.aiSuggestionsMode).toBe('off');
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await waitFor(() => expect(mockCloudModes.A).toBe('off'));
    expect(fake.__meta(accountKey('A'))).toBe('off');
    expect(result.current.aiSuggestionsMode).toBe('off');
  } finally { setMeta.mockRestore(); jest.useRealTimers(); }
});

test('foreground refresh restores another device OFF choice after a successful hydration', async () => {
  const { result } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A', 'auto_accept') });
  await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('auto_accept'));
  mockCloudModes.A = 'off';
  await act(async () => { mockOnForeground?.(); await result.current.awaitAiSuggestionsPreference(); });
  expect(result.current.aiSuggestionsMode).toBe('off');
  expect(mockGetUser).toHaveBeenCalledTimes(2);
});


test('a failed account A write is retried durably after switching to B without foregrounding', async () => {
  jest.useFakeTimers();
  const setMeta = jest.spyOn(fake.repository, 'setMeta');
  try {
    const { result, rerender, unmount } = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A', 'confirm') });
    await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('confirm'));
    setMeta.mockRejectedValueOnce(new Error('temporary disk write failure'));
    await act(async () => { result.current.setAiSuggestionsMode('off'); });
    expect(fake.__meta(`${accountKey('A')}.pending`)).toBeNull();
    await rerender(auth('B', 'confirm'));
    await waitFor(() => expect(result.current.aiSuggestionsMode).toBe('confirm'));
    await act(async () => { result.current.setAiSuggestionsMode('auto_accept'); });
    await waitFor(() => expect(fake.__meta(accountKey('B'))).toBe('auto_accept'));
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await waitFor(() => expect(fake.__meta(accountKey('A'))).toBe('off'));
    await waitFor(() => expect(mockCloudModes.A).toBe('off'));
    expect(mockCloudModes.B).toBe('auto_accept');
    await unmount();
    const again = await renderHook(useAiSuggestionsPreference, { initialProps: auth('A') });
    await waitFor(() => expect(again.result.current.aiSuggestionsMode).toBe('off'));
  } finally { setMeta.mockRestore(); jest.useRealTimers(); }
});
