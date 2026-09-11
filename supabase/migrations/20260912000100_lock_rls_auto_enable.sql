-- New Supabase projects ship public.rls_auto_enable(), the event-trigger function behind `ensure_rls`. It is
-- SECURITY DEFINER and executable by anon/authenticated through /rest/v1/rpc, which the security advisor
-- flags. Only the event trigger needs it, and that does not go through EXECUTE grants.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;
