-- Offline regression fixture: the chat quota RPC stays server-only.
--
-- request_chat_slot_for(uuid) is security definer as postgres and trusts its
-- p_user_id argument, because its only legitimate caller resolves that id from a
-- stash_ API key rather than from a JWT. Row-level security on public.chat_requests
-- is the other half of that arrangement and a security definer function walks past
-- it, so the EXECUTE grant is the entire control. Supabase's default privileges hand
-- that grant to anon and authenticated to every function postgres creates, and
-- `revoke ... from public` does not take it back, which is how the original migration
-- silently missed its own stated design.
--
-- Fixture users exist so that a missing revoke fails with the FAIL message below: the
-- call would then succeed, or hit the auth.users foreign key, instead of surfacing as
-- an unrelated privilege error.
begin;
insert into auth.users(id, is_anonymous) values
  ('00000000-0000-4000-8000-000000000021', false),
  ('00000000-0000-4000-8000-000000000022', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000021', true);
select set_config('request.jwt.claims', '{"is_anonymous":false}', true);
set local role authenticated;
do $$
begin
  begin
    perform public.request_chat_slot_for('00000000-0000-4000-8000-000000000021'::uuid);
    raise exception 'FAIL: client can consume chat quota';
  exception when insufficient_privilege then null; end;
  begin
    perform public.request_chat_slot_for('00000000-0000-4000-8000-000000000022'::uuid);
    raise exception 'FAIL: client can consume foreign chat quota';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
set local role anon;
do $$
begin
  begin
    perform public.request_chat_slot_for('00000000-0000-4000-8000-000000000021'::uuid);
    raise exception 'FAIL: unauthenticated chat quota consume';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$
begin
  if (select count(*) from public.chat_requests) <> 0 then
    raise exception 'FAIL: denied calls wrote the chat ledger';
  end if;
end $$;
-- Catalog state, not another execution: service_role is the only role that should
-- hold this grant, and asserting it here keeps the revoke from being widened past
-- the client roles into the server path.
do $$
begin
  if has_function_privilege('anon', 'public.request_chat_slot_for(uuid)', 'EXECUTE') then
    raise exception 'FAIL: anon retains chat quota execute';
  end if;
  if has_function_privilege('authenticated', 'public.request_chat_slot_for(uuid)', 'EXECUTE') then
    raise exception 'FAIL: authenticated retains chat quota execute';
  end if;
  if not has_function_privilege('service_role', 'public.request_chat_slot_for(uuid)', 'EXECUTE') then
    raise exception 'FAIL: server lost chat quota access';
  end if;
end $$;
rollback;
select 'PASS: chat quota RPC denied to client roles, retained for service_role (fixtures rolled back)' as result;
