import { useCallback, useEffect, useRef, useState } from 'react';
import { AI_SUGGESTIONS_MODE_PREF_KEY, parseAiSuggestionsMode, type AiSuggestionsMode } from '@/domain/ai-suggestions-pref';
import { repository } from '@/storage/repository';
import { registerForForegroundState } from '@/storage/sqlite-app-lifecycle';
import { createSupabaseClient, SupabaseRequestError } from '@/supabase/client';
import type { SupabaseAuthSession } from '@/supabase/types';
import { readCacheOwner } from '@/sync/account-transition';
import { ensureRepositoryReady } from './repository-ready';
import { logStorageError } from './helpers';

const RETRY_DELAY_MS = 30_000;
const LEGACY_GUEST_PROVENANCE_KEY = `${AI_SUGGESTIONS_MODE_PREF_KEY}.legacy_guest`;
type Auth = {
  status: string;
  userId: string | null;
  session: SupabaseAuthSession | null;
  credentialRecoveryVersion?: number;
  ensureAnonymousSession?: (forceRefresh?: boolean) => Promise<SupabaseAuthSession | null>;
};
type Binding = { key: string; token: string | null; anonymous: boolean | undefined; applied: boolean; settled: boolean };

/** Account policy is bound to the session actually used, not a React commit's
 * timing. Guest choices never initialize a new permanent account. */
export function useAiSuggestionsPreference(auth: Auth, offline = false) {
  const accountId = auth.status === 'authenticated' ? auth.userId
    : auth.session?.user.is_anonymous === false ? auth.session.user.id : null;
  const key = accountId ? `${AI_SUGGESTIONS_MODE_PREF_KEY}.account.${accountId}` : AI_SUGGESTIONS_MODE_PREF_KEY;
  const authRef = useRef(auth);
  authRef.current = auth;
  const offlineRef = useRef(offline);
  offlineRef.current = offline;
  const sawGuest = useRef(false);
  if (auth.status === 'anonymous') sawGuest.current = true;
  const activeKey = useRef(key);
  const mounted = useRef(true);
  const revision = useRef(0);
  const hydration = useRef(Promise.resolve());
  const localHydration = useRef(Promise.resolve());
  const binding = useRef<Binding | null>(null);
  const preemptedSession = useRef<SupabaseAuthSession | null>(null);
  const aiSuggestionsReadyRef = useRef(false);
  const aiSuggestionsModeRef = useRef<AiSuggestionsMode>('off');
  const [aiSuggestionsReady, setReady] = useState(false);
  const [aiSuggestionsMode, setMode] = useState<AiSuggestionsMode>('off');
  const writes = useRef(Promise.resolve());
  const publications = useRef(Promise.resolve());
  const desiredEdits = useRef(new Map<string, { mode: AiSuggestionsMode; session: SupabaseAuthSession | null }>());
  const persistRef = useRef<((mode: AiSuggestionsMode, session: SupabaseAuthSession | null, targetKey: string) => void) | null>(null);
  const retiredTokens = useRef(new Set<string>());
  const localFailures = useRef(new Set<string>());
  const [localRecoveryVersion, setLocalRecoveryVersion] = useState(0);
  const writeVersions = useRef(new Map<string, number>());
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readyWaiters = useRef(new Set<(closed?: boolean) => void>());
  const refreshRef = useRef<((session?: SupabaseAuthSession | null, force?: boolean) => Promise<void>) | null>(null);
  const notifyReady = useCallback(() => { for (const check of [...readyWaiters.current]) check(); }, []);
  const clearRetry = useCallback(() => {
    if (retryTimer.current !== null) clearTimeout(retryTimer.current);
    retryTimer.current = null;
  }, []);
  const scheduleRetry = useCallback((localOnly = false) => {
    const timer = localOnly ? localRetryTimer : retryTimer;
    if (!mounted.current || (!localOnly && offlineRef.current) || timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      for (const [targetKey, edit] of [...desiredEdits.current]) {
        const live = authRef.current.session;
        persistRef.current?.(edit.mode, live?.user.id === edit.session?.user.id ? live : edit.session, targetKey);
      }
      void refreshRef.current?.(undefined, true);
    }, RETRY_DELAY_MS);
  }, []);

  const persist = useCallback((mode: AiSuggestionsMode, session: SupabaseAuthSession | null, targetKey = key) => {
    const version = (writeVersions.current.get(targetKey) ?? 0) + 1;
    writeVersions.current.set(targetKey, version);
    desiredEdits.current.set(targetKey, { mode, session });
    const durable = writes.current.catch(() => {}).then(async () => {
      await ensureRepositoryReady();
      // Pending first makes a crash before the cache write recoverable.
      if (session) await repository.setMeta(`${targetKey}.pending`, mode);
      await repository.setMeta(targetKey, mode);
      if (writeVersions.current.get(targetKey) === version) desiredEdits.current.delete(targetKey);
    });
    writes.current = durable.catch((error) => {
      logStorageError('ai suggestions mode', error);
      scheduleRetry(true);
    });
    if (!session || offlineRef.current) return;
    publications.current = publications.current.catch(() => {}).then(async () => {
      try {
        await durable;
        if (!mounted.current) return;
        const client = createSupabaseClient();
        try {
          await client.updateUserMetadata(session.access_token, { ai_suggestions_mode: mode });
        } catch (error) {
          if (!mounted.current || !(error instanceof SupabaseRequestError) || error.status !== 401 ||
            authRef.current.session?.user.id !== session.user.id) throw error;
          const fresh = await authRef.current.ensureAnonymousSession?.(true);
          // Credential recovery must never publish under another/anonymous account.
          if (!fresh || fresh.user.id !== session.user.id || fresh.user.is_anonymous !== false) throw error;
          await client.updateUserMetadata(fresh.access_token, { ai_suggestions_mode: mode });
        }
        writes.current = writes.current.catch(() => {}).then(async () => {
          if (mounted.current && writeVersions.current.get(targetKey) === version) await repository.setMeta(`${targetKey}.pending`, '');
        });
        await writes.current;
      } catch (error) {
        logStorageError('ai account preference publication', error);
        if (activeKey.current === targetKey && !desiredEdits.current.has(targetKey)) scheduleRetry();
      }
    });
  }, [key, scheduleRetry]);
  persistRef.current = persist;

  const beginLoad = useCallback((requested?: SupabaseAuthSession | null, force = false): Promise<void> => {
    if (!mounted.current) return Promise.resolve();
    const live = authRef.current.session;
    const session = requested === undefined
      ? (live && retiredTokens.current.has(live.access_token) && preemptedSession.current?.user.id === live.user.id ? preemptedSession.current : live)
      : requested;
    if (session && (retiredTokens.current.has(session.access_token) ||
      (requested && (live?.user.id !== session.user.id ||
        (live.user.is_anonymous === false && session.user.is_anonymous === true))))) return hydration.current;
    // Loading without a restored session is unknown, not a guest transition.
    if (!session && authRef.current.status === 'loading') return hydration.current;
    const permanent = session && (session.user.is_anonymous === false ||
      (session.user.is_anonymous !== true && authRef.current.status === 'authenticated'));
    const targetKey = permanent ? `${AI_SUGGESTIONS_MODE_PREF_KEY}.account.${session.user.id}` : AI_SUGGESTIONS_MODE_PREF_KEY;
    const accountSession = permanent ? session : null;
    const token = session?.access_token ?? null;
    const anonymous = session?.user.is_anonymous;
    const prior = binding.current;
    if (!force && prior?.key === targetKey && prior.token === token && prior.anonymous === anonymous &&
      (!prior.settled || prior.applied)) return hydration.current;
    if (prior?.key === targetKey && prior.token && prior.token !== token) retiredTokens.current.add(prior.token);
    clearRetry();
    const seq = ++revision.current;
    const currentBinding: Binding = { key: targetKey, token, anonymous, applied: false, settled: false };
    binding.current = currentBinding;
    activeKey.current = targetKey;
    aiSuggestionsReadyRef.current = false;
    aiSuggestionsModeRef.current = 'off';
    setReady(false);
    if (prior?.key !== targetKey) setMode('off');
    notifyReady();
    const local = (async () => {
      await ensureRepositoryReady();
      // Read failures mean unknown ownership, never permission to migrate or
      // initialize a default. Keep this snapshot ahead of reconciliation.
      const owner = accountSession ? await readCacheOwner(repository) : null;
      // Persist before local readiness lets reconciliation replace the owner.
      // A crash during linking must not turn the guest's legacy choice into
      // a permanent account choice on the next launch.
      if (session?.user.is_anonymous === true || authRef.current.status === 'anonymous' || sawGuest.current || owner?.isAnonymous) {
        await repository.setMeta(LEGACY_GUEST_PROVENANCE_KEY, 'true');
      }
      const legacyWasGuest = await repository.getMeta(LEGACY_GUEST_PROVENANCE_KEY);
      await writes.current;
      const cached = await repository.getMeta(targetKey);
      const pending = desiredEdits.current.get(targetKey)?.mode ||
        (accountSession ? await repository.getMeta(`${targetKey}.pending`) : null);
      const legacy = accountSession && !sawGuest.current && !legacyWasGuest && !cached && !pending &&
        owner?.id === accountSession.user.id && !owner.isAnonymous
        ? await repository.getMeta(AI_SUGGESTIONS_MODE_PREF_KEY) : null;
      if (revision.current === seq && localFailures.current.delete(targetKey)) setLocalRecoveryVersion((value) => value + 1);
      return { cached, pending, legacy };
    })();
    localHydration.current = local.then(() => {});
    // Reconciliation must not replace an owner whose snapshot could not be read.
    void localHydration.current.catch(() => {
      if (revision.current === seq) localFailures.current.add(targetKey);
    });
    hydration.current = (async () => {
      const { cached, pending, legacy } = await local;
      if (revision.current !== seq) return;
      let remote: string | null | undefined;
      let readSucceeded = false;
      if (accountSession && !pending && !offlineRef.current) {
        try {
          const client = createSupabaseClient();
          let user;
          try {
            user = await client.getUser(accountSession.access_token);
          } catch (error) {
            if (!(error instanceof SupabaseRequestError) || error.status !== 401 ||
              revision.current !== seq || !mounted.current || authRef.current.session?.user.id !== accountSession.user.id) throw error;
            const fresh = await authRef.current.ensureAnonymousSession?.(true);
            if (!fresh || fresh.user.id !== accountSession.user.id || fresh.user.is_anonymous !== false ||
              revision.current !== seq || !mounted.current || authRef.current.session?.user.id !== fresh.user.id) throw error;
            if (fresh.access_token !== accountSession.access_token) retiredTokens.current.add(accountSession.access_token);
            preemptedSession.current = fresh;
            currentBinding.token = fresh.access_token;
            user = await client.getUser(fresh.access_token);
          }
          if (user.id !== accountSession.user.id) throw new Error("Account preference response ownership mismatch.");
          remote = user.user_metadata?.ai_suggestions_mode;
          readSucceeded = true;
        } catch {
          // A cached session/JWT may predate another device's OFF choice.
          if (revision.current === seq) scheduleRetry();
        }
      }
      if (revision.current !== seq || (accountSession && authRef.current.session?.user.id !== accountSession.user.id)) return;
      const raw = pending || (readSucceeded ? remote || cached || legacy || 'auto_accept' : cached);
      const mode = parseAiSuggestionsMode(raw || (accountSession ? 'off' : null));
      const known = !accountSession || !!pending || !!cached || readSucceeded;
      currentBinding.applied = true;
      aiSuggestionsModeRef.current = mode;
      aiSuggestionsReadyRef.current = known;
      setMode(mode);
      setReady(known);
      notifyReady();
      if (accountSession && !offlineRef.current && (pending || (readSucceeded && !remote))) persist(mode, preemptedSession.current?.user.id === accountSession.user.id ? preemptedSession.current : accountSession, targetKey);
      else if (!accountSession || readSucceeded || cached) await repository.setMeta(targetKey, mode);
    })().catch((error) => {
      logStorageError('ai account preference hydration', error);
      if (revision.current === seq) scheduleRetry(true);
    }).finally(() => { currentBinding.settled = true; });
    return hydration.current;
  }, [accountId, clearRetry, notifyReady, persist, scheduleRetry]);
  refreshRef.current = beginLoad;

  const accessToken = auth.session?.access_token;
  const recoveryVersion = auth.credentialRecoveryVersion ?? 0;
  const lastRecovery = useRef(recoveryVersion);
  const lastOffline = useRef(offline);
  useEffect(() => {
    mounted.current = true;
    // An imperative refresh can land before React commits the returned session.
    // Do not invalidate that already-loaded policy when the commit catches up.
    const preempted = !!preemptedSession.current && preemptedSession.current.access_token === authRef.current.session?.access_token &&
      preemptedSession.current?.user.is_anonymous === authRef.current.session?.user.is_anonymous;
    const force = lastOffline.current !== offline || (!preempted && lastRecovery.current !== recoveryVersion);
    lastRecovery.current = recoveryVersion;
    lastOffline.current = offline;
    if (preempted) preemptedSession.current = null;
    void beginLoad(undefined, force);
  }, [beginLoad, key, accessToken, recoveryVersion, offline]);
  useEffect(() => {
    const unsubscribe = registerForForegroundState({ onForeground: () => {
      if (!offlineRef.current && (authRef.current.session?.user.is_anonymous === false ||
        authRef.current.status === 'authenticated' || retryTimer.current !== null || localRetryTimer.current !== null || desiredEdits.current.size > 0)) {
        for (const [targetKey, edit] of [...desiredEdits.current]) {
          const live = authRef.current.session;
          persistRef.current?.(edit.mode, live?.user.id === edit.session?.user.id ? live : edit.session, targetKey);
        }
        void refreshRef.current?.(undefined, true);
      }
    } });
    return () => {
      mounted.current = false;
      binding.current = null;
      revision.current += 1;
      clearRetry();
      if (localRetryTimer.current !== null) clearTimeout(localRetryTimer.current);
      localRetryTimer.current = null;
      unsubscribe();
      for (const check of [...readyWaiters.current]) check(true);
    };
  }, [clearRetry]);

  const setAiSuggestionsMode = useCallback((mode: AiSuggestionsMode) => {
    // Ignore a Settings callback retained from a departed account.
    if (!mounted.current || activeKey.current !== key || (accountId && authRef.current.session?.user.id !== accountId)) return;
    revision.current += 1;
    clearRetry();
    aiSuggestionsModeRef.current = mode;
    aiSuggestionsReadyRef.current = true;
    setMode(mode);
    setReady(true);
    notifyReady();
    persist(mode, accountId ? authRef.current.session : null);
  }, [accountId, key, clearRetry, notifyReady, persist]);

  const awaitAiSuggestionsPreference = useCallback(async (session?: SupabaseAuthSession | null) => {
    const permanent = session && (session.user.is_anonymous === false ||
      (session.user.is_anonymous !== true && authRef.current.status === 'authenticated'));
    const expectedKey = permanent ? `${AI_SUGGESTIONS_MODE_PREF_KEY}.account.${session.user.id}` : AI_SUGGESTIONS_MODE_PREF_KEY;
    const live = authRef.current.session;
    const stale = session && (live?.user.id !== session.user.id ||
      (live.user.is_anonymous === false && session.user.is_anonymous === true) || retiredTokens.current.has(session.access_token));
    if (session && !stale && (binding.current?.key !== expectedKey || binding.current?.token !== session.access_token ||
      binding.current?.anonymous !== session.user.is_anonymous)) {
      preemptedSession.current = session;
      void refreshRef.current?.(session);
    }
    let current: Promise<void>;
    do { current = hydration.current; await current; } while (current !== hydration.current);
  }, []);
  const awaitAiSuggestionsLocalReady = useCallback(async () => {
    let current: Promise<void>;
    do { current = localHydration.current; await current; } while (current !== localHydration.current);
  }, []);
  const waitForAiSuggestionsReady = useCallback((userId: string, cancelled: () => boolean): Promise<boolean> =>
    new Promise((resolve) => {
      const check = (closed = false) => {
        if (closed || !mounted.current || cancelled() || authRef.current.session?.user.id !== userId) {
          readyWaiters.current.delete(check); resolve(false);
        } else if (aiSuggestionsReadyRef.current) {
          readyWaiters.current.delete(check); resolve(true);
        }
      };
      readyWaiters.current.add(check);
      check();
    }), []);

  return { aiSuggestionsMode: binding.current?.key === key ? aiSuggestionsMode : 'off' as AiSuggestionsMode,
    aiSuggestionsModeRef, setAiSuggestionsMode,
    aiSuggestionsReady, aiSuggestionsReadyRef, awaitAiSuggestionsPreference,
    awaitAiSuggestionsLocalReady, waitForAiSuggestionsReady, localRecoveryVersion };
}
