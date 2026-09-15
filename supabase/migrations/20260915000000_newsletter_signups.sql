-- Newsletter signups from the marketing site (packages/site). The site posts straight to PostgREST with the
-- publishable key, so anon may INSERT an email and source and nothing else: no select, update or delete, so
-- the list can never be read back from a browser. Addresses are unique case-insensitively; a repeat signup
-- hits the index and PostgREST answers 409, which the site shows as success so it never reveals who is
-- already on the list.

create table public.newsletter_signups (
  id bigint generated always as identity primary key,
  email text not null
    check (char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  source text not null default 'site' check (char_length(source) <= 32),
  created_at timestamptz not null default now()
);

create unique index newsletter_signups_email_lower_key on public.newsletter_signups (lower(email));

alter table public.newsletter_signups enable row level security;

-- Scoped to the site's own source value rather than `with check (true)`, which the advisor flags.
create policy "Visitors can sign up from the site"
  on public.newsletter_signups for insert to anon, authenticated
  with check (source = 'site');

revoke all on public.newsletter_signups from anon, authenticated;
grant insert (email, source) on public.newsletter_signups to anon, authenticated;
