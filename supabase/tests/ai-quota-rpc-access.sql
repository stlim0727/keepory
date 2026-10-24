-- Offline regression fixture: callers cannot reserve/refund another user's quota.
-- UUID arguments are written as '...'::uuid on purpose. _ai_enrichment_slot and
-- request_ai_enrichment_slot_for each have a sibling overload whose extra argument
-- has a default, so an untyped literal is ambiguous and Postgres raises
-- "function is not unique" (42725) during resolution — before the privilege check
-- these statements exist to assert. PostgREST sends typed parameters, so this only
-- bites here.
begin;
insert into auth.users(id, is_anonymous) values
  ('00000000-0000-4000-8000-000000000011', true),
  ('00000000-0000-4000-8000-000000000012', false);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000011', true);
select set_config('request.jwt.claims', '{"is_anonymous":true}', true);
set local role authenticated;
do $$
begin
  if public.request_ai_enrichment_slot()->>'allowed' <> 'true' then
    raise exception 'FAIL: authenticated self quota stopped working';
  end if;
  begin
    perform public._ai_enrichment_slot('00000000-0000-4000-8000-000000000012'::uuid, false);
    raise exception 'FAIL: client can reserve foreign quota';
  exception when insufficient_privilege then null; end;
  begin
    perform public.request_ai_enrichment_slot_for('00000000-0000-4000-8000-000000000012'::uuid);
    raise exception 'FAIL: client can reserve foreign server quota';
  exception when insufficient_privilege then null; end;
  begin
    perform public.refund_ai_enrichment_slot_for('00000000-0000-4000-8000-000000000011'::uuid);
    raise exception 'FAIL: client can reset its own quota';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub', '', true);
set local role anon;
do $$
begin
  begin
    perform public._ai_enrichment_slot('00000000-0000-4000-8000-000000000012'::uuid, false);
    raise exception 'FAIL: unauthenticated foreign quota reserve';
  exception when insufficient_privilege then null; end;
  begin
    perform public.request_ai_enrichment_slot_for('00000000-0000-4000-8000-000000000012'::uuid);
    raise exception 'FAIL: unauthenticated server quota reserve';
  exception when insufficient_privilege then null; end;
  begin
    perform public.refund_ai_enrichment_slot_for('00000000-0000-4000-8000-000000000011'::uuid);
    raise exception 'FAIL: unauthenticated quota refund';
  exception when insufficient_privilege then null; end;
  if public.request_ai_enrichment_slot()->>'allowed' <> 'false' then
    raise exception 'FAIL: no-session self quota allowed';
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from public.ai_enrichment_requests) <> 1 then
    raise exception 'FAIL: denied calls changed quota ledger';
  end if;
end $$;
set local role service_role;
do $$
begin
  if public.request_ai_enrichment_slot_for('00000000-0000-4000-8000-000000000012'::uuid)->>'allowed' <> 'true' then
    raise exception 'FAIL: server reserve stopped working';
  end if;
  perform public.refund_ai_enrichment_slot_for('00000000-0000-4000-8000-000000000012'::uuid);
end $$;
reset role;
do $$
begin
  if (select count(*) from public.ai_enrichment_requests where user_id='00000000-0000-4000-8000-000000000012') <> 0 then
    raise exception 'FAIL: server refund stopped working';
  end if;
end $$;
rollback;
