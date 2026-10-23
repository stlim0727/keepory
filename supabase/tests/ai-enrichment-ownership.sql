-- Run against the target DB as postgres. All fixtures and quota use roll back.
-- This verifies real policies/RPC grants under both account claim shapes;
-- it does NOT verify JWT signatures, expiry, or the deployed HTTP handler.
begin;
select set_config('keepory.verify_owner', gen_random_uuid()::text, true);
select set_config('keepory.verify_other', gen_random_uuid()::text, true);
select set_config('keepory.verify_bookmark', gen_random_uuid()::text, true);
select set_config('keepory.verify_foreign_bookmark', gen_random_uuid()::text, true);
insert into auth.users(id, is_anonymous) values
  (current_setting('keepory.verify_owner')::uuid, true),
  (current_setting('keepory.verify_other')::uuid, false);
-- pending metadata prevents a background model dispatch, even before rollback.
insert into public.bookmarks(id, user_id, title, metadata_status) values
  (current_setting('keepory.verify_bookmark')::uuid, current_setting('keepory.verify_owner')::uuid, 'ownership verification', 'pending'),
  (current_setting('keepory.verify_foreign_bookmark')::uuid, current_setting('keepory.verify_other')::uuid, 'ownership verification', 'pending');
select set_config('request.jwt.claim.sub', current_setting('keepory.verify_owner'), true);
set local role authenticated;
do $$
declare
  anonymous boolean;
begin
  foreach anonymous in array array[true, false] loop
    perform set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('keepory.verify_owner'), 'role', 'authenticated', 'is_anonymous', anonymous)::text, true);
    if (select count(*) from public.bookmarks where id in (current_setting('keepory.verify_bookmark')::uuid, current_setting('keepory.verify_foreign_bookmark')::uuid)) <> 1 then
      raise exception 'FAIL: bookmark ownership isolation';
    end if;
    insert into public.ai_enrichments(bookmark_id, user_id, status)
      values (current_setting('keepory.verify_bookmark')::uuid, current_setting('keepory.verify_owner')::uuid, 'complete')
      on conflict (bookmark_id) do update set status = excluded.status;
    begin
      insert into public.ai_enrichments(bookmark_id, user_id, status)
        values (current_setting('keepory.verify_foreign_bookmark')::uuid, current_setting('keepory.verify_owner')::uuid, 'complete');
      raise exception 'FAIL: can write enrichment for foreign parent';
    exception when insufficient_privilege then null; end;
    begin
      update public.ai_enrichments set bookmark_id = current_setting('keepory.verify_foreign_bookmark')::uuid
        where bookmark_id = current_setting('keepory.verify_bookmark')::uuid;
      raise exception 'FAIL: can reassign enrichment to foreign parent';
    exception when insufficient_privilege then null; end;
    if public.request_ai_enrichment_slot()->>'allowed' <> 'true' then
      raise exception 'FAIL: self quota rejected';
    end if;
    if has_function_privilege(current_user, 'public.claim_pending_ai_enrichment_batch(integer)', 'EXECUTE')
      or has_function_privilege(current_user, 'public.reserve_ai_enrichment_budget()', 'EXECUTE')
      or has_function_privilege(current_user, 'public.request_ai_enrichment_slot_for(uuid)', 'EXECUTE')
      or has_function_privilege(current_user, 'public.refund_ai_enrichment_slot_for(uuid)', 'EXECUTE') then
      raise exception 'FAIL: privileged AI RPC reachable by client';
    end if;
  end loop;
end $$;
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
set local role anon;
do $$
begin
  if exists (select 1 from public.bookmarks where id = current_setting('keepory.verify_bookmark')::uuid)
    or exists (select 1 from public.ai_enrichments where bookmark_id = current_setting('keepory.verify_bookmark')::uuid) then
    raise exception 'FAIL: unauthenticated read';
  end if;
  if public.request_ai_enrichment_slot()->>'allowed' <> 'false' then
    raise exception 'FAIL: unauthenticated quota allowed';
  end if;
  if has_function_privilege(current_user, 'public.claim_pending_ai_enrichment_batch(integer)', 'EXECUTE')
    or has_function_privilege(current_user, 'public.reserve_ai_enrichment_budget()', 'EXECUTE') then
    raise exception 'FAIL: anonymous privileged RPC access';
  end if;
end $$;
reset role;
set local role service_role;
do $$
begin
  if (select count(*) from public.bookmarks where id in (current_setting('keepory.verify_bookmark')::uuid, current_setting('keepory.verify_foreign_bookmark')::uuid)) <> 2 then
    raise exception 'FAIL: server cannot read fixture owners';
  end if;
  if not has_function_privilege(current_user, 'public.claim_pending_ai_enrichment_batch(integer)', 'EXECUTE')
    or not has_function_privilege(current_user, 'public.reserve_ai_enrichment_budget()', 'EXECUTE') then
    raise exception 'FAIL: server RPC access missing';
  end if;
end $$;
reset role;
rollback;
select 'PASS: AI ownership, own upsert, foreign-parent denial, self quota and server-only RPC grants (fixtures rolled back)' as result;
