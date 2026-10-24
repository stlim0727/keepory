-- #1000: exercise real owner policies and the metadata-ready import transition.
-- No HTTP/model dispatch: every bookmark is either metadata-pending or trickle.
-- The overflow worker cannot see uncommitted fixture rows. All changes roll back.
-- This proves the DB path, not device sign-in, JWT validation, or HTML parsing.
begin;
select set_config('keepory.verify_owner', gen_random_uuid()::text, true);
select set_config('keepory.verify_other', gen_random_uuid()::text, true);
select set_config('keepory.verify_import', gen_random_uuid()::text, true);
insert into auth.users(id, is_anonymous) values
  (current_setting('keepory.verify_owner')::uuid, false),
  (current_setting('keepory.verify_other')::uuid, false);
insert into public.user_preferences(user_id, locale, preference)
  values (current_setting('keepory.verify_other')::uuid, 'en', 'foreign fixture');
select set_config('request.jwt.claim.sub', current_setting('keepory.verify_owner'), true);
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('keepory.verify_owner'),
  'role', 'authenticated', 'is_anonymous', false
)::text, true);
set local role authenticated;
insert into public.user_preferences(user_id, locale, preference)
  values (current_setting('keepory.verify_owner')::uuid, 'en', 'initial')
  on conflict (user_id) do update set locale=excluded.locale, preference=excluded.preference;
update public.user_preferences set locale='ko', preference='verification'
  where user_id=current_setting('keepory.verify_owner')::uuid;
do $$
begin
  if not exists (select 1 from public.user_preferences
    where user_id=current_setting('keepory.verify_owner')::uuid
      and locale='ko' and preference='verification') then
    raise exception 'FAIL: own preference insert/update/read';
  end if;
  if exists (select 1 from public.user_preferences
    where user_id=current_setting('keepory.verify_other')::uuid) then
    raise exception 'FAIL: foreign preferences visible';
  end if;
  update public.user_preferences set locale='ko'
    where user_id=current_setting('keepory.verify_other')::uuid;
  if found then raise exception 'FAIL: foreign preferences writable'; end if;
  begin
    insert into public.user_preferences(user_id, locale)
      values (current_setting('keepory.verify_other')::uuid, 'ko');
    raise exception 'FAIL: foreign preference insert allowed';
  exception when insufficient_privilege then null; end;
end $$;
insert into public.bookmarks(id, user_id, title, metadata_status, enrichment_policy)
  values (current_setting('keepory.verify_import')::uuid,
    current_setting('keepory.verify_owner')::uuid,
    'transactional import verification', 'pending', 'trickle');
reset role;
do $$
begin
  if exists (select 1 from public.pending_ai_enrichment
    where bookmark_id=current_setting('keepory.verify_import')::uuid) then
    raise exception 'FAIL: import queued before metadata was ready';
  end if;
end $$;
set local role authenticated;
update public.bookmarks set metadata_status='complete'
  where id=current_setting('keepory.verify_import')::uuid;
reset role;
do $$
begin
  if (select count(*) from public.pending_ai_enrichment
    where bookmark_id=current_setting('keepory.verify_import')::uuid
      and user_id=current_setting('keepory.verify_owner')::uuid
      and status='pending' and priority=50 and locale='ko') <> 1 then
    raise exception 'FAIL: metadata-ready trickle import missing low-priority localized queue row';
  end if;
end $$;
-- A retry/ordinary edit must not add a second queued job.
set local role authenticated;
update public.bookmarks set title='retry verification', metadata_status='complete'
  where id=current_setting('keepory.verify_import')::uuid;
reset role;
do $$
begin
  if (select count(*) from public.pending_ai_enrichment
    where bookmark_id=current_setting('keepory.verify_import')::uuid) <> 1 then
    raise exception 'FAIL: repeated import update duplicated queue work';
  end if;
end $$;
rollback;
select 'PASS: preference ownership and metadata-ready trickle import (fixtures rolled back)' as result;
