-- Expand bookmarks.enrichment_policy check constraint to support 'trickle' (#940).
--
-- Background:
-- External bookmark imports (HTML, CSV, Pocket, Raindrop) can ingest hundreds
-- of links at once. Historically (#671), imported bookmarks were stamped with
-- 'skip' to prevent blowing through user daily quotas (500/day) and provider
-- rate limits. Issue #940 introduces a gradual background 'trickle' enrichment
-- mechanism that cures imported backlogs at a serene, low-priority pace while
-- strictly protecting interactive captures from quota starvation.

-- 1. Constraint expansion on public.bookmarks
alter table public.bookmarks
  drop constraint if exists bookmarks_enrichment_policy_check;

alter table public.bookmarks
  add constraint bookmarks_enrichment_policy_check
  check (enrichment_policy in ('auto', 'skip', 'trickle'));

-- 2. Add priority tier to public.pending_ai_enrichment
-- Priority 10 = interactive overflow (urgent, user-initiated or live save)
-- Priority 50 = archival trickle backlog (calm background curation)
alter table public.pending_ai_enrichment
  add column if not exists priority smallint not null default 10
    check (priority in (10, 50));

drop index if exists public.pending_ai_enrichment_status_created_idx;

create index if not exists pending_ai_enrichment_status_priority_created_idx
  on public.pending_ai_enrichment (status, priority asc, created_at asc)
  where status in ('pending', 'processing');

-- 3. Update dispatch_ai_enrichment() trigger function
create or replace function public.dispatch_ai_enrichment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
  v_locale text;
  v_pref_updated_at timestamptz;
  v_meta_locale text;
  v_meta_updated_at timestamptz;
begin
  -- Skip archived/trashed rows, ones whose metadata is still being fetched (the model
  -- would only see the bare URL), and rows whose owner explicitly opted this
  -- bookmark out of automatic AI ('skip').
  if new.is_archived or new.deleted_at is not null or new.metadata_status = 'pending' or new.enrichment_policy = 'skip' then
    return new;
  end if;

  -- On UPDATE, only react if metadata_status or enrichment_policy transitioned.
  if tg_op = 'UPDATE'
     and old.metadata_status is not distinct from new.metadata_status
     and old.enrichment_policy is not distinct from new.enrichment_policy then
    return new;
  end if;

  -- Already has suggestions: nothing to do.
  if exists (select 1 from public.ai_enrichments where bookmark_id = new.id) then
    return new;
  end if;

  -- Resolve user locale (from user_preferences or auth.users raw_user_meta_data)
  begin
    select locale, updated_at into v_locale, v_pref_updated_at
      from public.user_preferences where user_id = new.user_id;

    select raw_user_meta_data->>'locale', (raw_user_meta_data->>'locale_updated_at')::timestamptz
      into v_meta_locale, v_meta_updated_at
      from auth.users where id = new.user_id;

    if v_meta_locale is not null and (v_locale is null or v_pref_updated_at is null or v_meta_updated_at > v_pref_updated_at) then
      v_locale := v_meta_locale;
    end if;
  exception
    when others then
      v_locale := null;
  end;

  -- PATH A: Trickle enrichment -> enqueue into pending_ai_enrichment (priority 50)
  if new.enrichment_policy = 'trickle' then
    insert into public.pending_ai_enrichment (
      bookmark_id,
      user_id,
      locale,
      status,
      priority,
      created_at,
      updated_at
    ) values (
      new.id,
      new.user_id,
      v_locale,
      'pending',
      50, -- trickle priority
      now(),
      now()
    ) on conflict (bookmark_id) do update
      set priority = 50,
          locale = coalesce(excluded.locale, public.pending_ai_enrichment.locale),
          status = case when public.pending_ai_enrichment.status = 'failed' then 'pending' else public.pending_ai_enrichment.status end,
          updated_at = now();
    return new;
  end if;

  -- PATH B: Live 'auto' capture -> immediate asynchronous HTTP ping via pg_net
  begin
    select decrypted_secret into v_url
      from vault.decrypted_secrets where name = 'ai_enrich_url';
    select decrypted_secret into v_secret
      from vault.decrypted_secrets where name = 'ai_enrich_secret';

    if v_url is null or v_secret is null then
      return new;
    end if;

    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-ai-enrich-secret', v_secret
      ),
      body := jsonb_build_object(
        'bookmark_id', new.id,
        'user_id', new.user_id,
        'locale', v_locale
      )
    );
  exception
    when others then
      -- Capture is sacred: enrichment is fire-and-forget.
      null;
  end;

  return new;
end;
$$;

-- 4. Quota Gate with Headroom Reservation for Real-Time Captures
create or replace function public._ai_enrichment_slot(
  p_user_id uuid,
  p_is_anonymous boolean,
  p_is_trickle boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hour_limit int;
  v_day_limit int;
  v_hour_reserved_headroom int;
  v_day_reserved_headroom int;
  v_hour_count int;
  v_day_count int;
  v_oldest_in_hour timestamptz;
  v_retry_after int;
begin
  if p_user_id is null then
    return jsonb_build_object('allowed', false, 'reason', 'unauthenticated');
  end if;

  -- Serialize check-then-insert per user so concurrent calls cannot race past the limit
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  if p_is_anonymous then
    v_hour_limit := 10;
    v_day_limit := 50;
    v_hour_reserved_headroom := 6;   -- Trickle halts at 4/hour
    v_day_reserved_headroom := 25;   -- Trickle halts at 25/day
  else
    v_hour_limit := 30;
    v_day_limit := 500;
    v_hour_reserved_headroom := 15;  -- Trickle halts at 15/hour (reserves 15/hour for live captures)
    v_day_reserved_headroom := 100;  -- Trickle halts at 400/day (reserves 100/day for live captures)
  end if;

  -- Prune requests older than 1 day to keep ledger bounded
  delete from public.ai_enrichment_requests
   where user_id = p_user_id
     and created_at < now() - interval '1 day';

  select count(*) into v_day_count
    from public.ai_enrichment_requests
   where user_id = p_user_id
     and created_at >= now() - interval '1 day';

  select count(*), min(created_at) into v_hour_count, v_oldest_in_hour
    from public.ai_enrichment_requests
   where user_id = p_user_id
     and created_at >= now() - interval '1 hour';

  -- Trickle-specific headroom reservations: real-time captures always have reserved quota
  if p_is_trickle then
    if v_day_count >= (v_day_limit - v_day_reserved_headroom) then
      return jsonb_build_object(
        'allowed', false,
        'reason', 'trickle_daily_headroom_reached',
        'limit', v_day_limit - v_day_reserved_headroom,
        'window', 'day',
        'retry_after', 3600
      );
    end if;

    if v_hour_count >= (v_hour_limit - v_hour_reserved_headroom) then
      v_retry_after := greatest(
        60,
        ceil(extract(epoch from (v_oldest_in_hour + interval '1 hour' - now())))
      )::int;
      return jsonb_build_object(
        'allowed', false,
        'reason', 'trickle_hourly_headroom_reached',
        'limit', v_hour_limit - v_hour_reserved_headroom,
        'window', 'hour',
        'retry_after', v_retry_after
      );
    end if;
  end if;

  -- Absolute caps (applies to interactive captures and remaining unreserved trickle)
  if v_day_count >= v_day_limit then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'daily_limit',
      'limit', v_day_limit,
      'window', 'day',
      'retry_after', 3600
    );
  end if;

  if v_hour_count >= v_hour_limit then
    v_retry_after := greatest(
      1,
      ceil(extract(epoch from (v_oldest_in_hour + interval '1 hour' - now())))
    )::int;
    return jsonb_build_object(
      'allowed', false,
      'reason', 'hourly_limit',
      'limit', v_hour_limit,
      'window', 'hour',
      'retry_after', v_retry_after
    );
  end if;

  insert into public.ai_enrichment_requests (user_id) values (p_user_id);

  return jsonb_build_object(
    'allowed', true,
    'hour_limit', v_hour_limit,
    'hour_remaining', v_hour_limit - v_hour_count - 1,
    'day_limit', v_day_limit,
    'day_remaining', v_day_limit - v_day_count - 1
  );
end;
$$;

-- Overload backward-compatibility wrapper
create or replace function public._ai_enrichment_slot(p_user_id uuid, p_is_anonymous boolean)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public._ai_enrichment_slot(p_user_id, p_is_anonymous, false);
$$;

revoke all on function public._ai_enrichment_slot(uuid, boolean) from public;
revoke all on function public._ai_enrichment_slot(uuid, boolean, boolean) from public;

-- 5. Updated request_ai_enrichment_slot_for
create or replace function public.request_ai_enrichment_slot_for(
  p_user_id uuid,
  p_is_trickle boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_anonymous boolean;
begin
  select coalesce(is_anonymous, true) into v_is_anonymous
    from auth.users where id = p_user_id;
  return public._ai_enrichment_slot(p_user_id, coalesce(v_is_anonymous, true), p_is_trickle);
end;
$$;

create or replace function public.request_ai_enrichment_slot_for(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.request_ai_enrichment_slot_for(p_user_id, false);
$$;

revoke all on function public.request_ai_enrichment_slot_for(uuid) from public, anon, authenticated;
grant execute on function public.request_ai_enrichment_slot_for(uuid) to service_role;
revoke all on function public.request_ai_enrichment_slot_for(uuid, boolean) from public, anon, authenticated;
grant execute on function public.request_ai_enrichment_slot_for(uuid, boolean) to service_role;

-- 6. Updated claim_pending_ai_enrichment_batch
-- Prioritizes priority 10 (interactive overflow) over priority 50 (trickle backlog).
-- Clamps trickle items to max 2 items per user per tick for gentle, serene pacing.
create or replace function public.claim_pending_ai_enrichment_batch(p_limit int default 40)
returns setof public.pending_ai_enrichment
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('keepory:ai-queue-claim', 0));
  return query
    with ranked as (
      select id,
             priority,
             row_number() over (partition by user_id, priority order by created_at, id) as rn
      from public.pending_ai_enrichment
      where (retry_not_before is null or retry_not_before <= now())
        and (status = 'pending'
         or (status = 'processing' and updated_at < now() - interval '10 minutes'))
    ), selected as (
      select id from ranked
      where priority = 10 or (priority = 50 and rn <= 2)
      order by priority asc, rn asc, id asc
      limit least(greatest(coalesce(p_limit, 0), 0), 40)
    )
    update public.pending_ai_enrichment p
    set status = 'processing', updated_at = now(), retry_not_before = null
    from selected s
    where p.id = s.id
      and (p.retry_not_before is null or p.retry_not_before <= now())
      and (p.status = 'pending' or (p.status = 'processing' and p.updated_at < now() - interval '10 minutes'))
    returning p.*;
end;
$$;

revoke all on function public.claim_pending_ai_enrichment_batch(int) from public, anon, authenticated;
grant execute on function public.claim_pending_ai_enrichment_batch(int) to service_role;
