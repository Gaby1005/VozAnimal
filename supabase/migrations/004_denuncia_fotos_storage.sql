-- Voz Animal - Storage e metadados para fotografias de denuncias.
-- Execute este arquivo no SQL Editor do Supabase do projeto correto.
-- Ele nao apaga dados existentes e nao recria a tabela public.denuncias.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'denuncia-fotos',
  'denuncia-fotos',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.denuncia_fotos (
  id uuid primary key default gen_random_uuid(),
  denuncia_id uuid not null references public.denuncias(id) on delete cascade,
  storage_path text not null unique,
  nome_original text not null,
  nome_exibicao text,
  mime_type text not null,
  tamanho_bytes integer not null,
  ordem integer not null default 1,
  created_at timestamptz not null default now(),
  constraint denuncia_fotos_mime_check
    check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  constraint denuncia_fotos_tamanho_check
    check (tamanho_bytes > 0 and tamanho_bytes <= 10485760),
  constraint denuncia_fotos_ordem_check
    check (ordem between 1 and 5),
  constraint denuncia_fotos_limite_unique
    unique (denuncia_id, ordem)
);

create index if not exists idx_denuncia_fotos_denuncia_id
  on public.denuncia_fotos (denuncia_id);

alter table public.denuncia_fotos enable row level security;

drop policy if exists "denuncia_fotos anon insert" on public.denuncia_fotos;
create policy "denuncia_fotos anon insert"
  on public.denuncia_fotos
  for insert
  to anon
  with check (
    denuncia_id is not null
    and storage_path is not null
    and mime_type in ('image/jpeg', 'image/png', 'image/webp')
    and tamanho_bytes > 0
    and tamanho_bytes <= 10485760
    and ordem between 1 and 5
  );

drop policy if exists "denuncia_fotos service read" on public.denuncia_fotos;
create policy "denuncia_fotos service read"
  on public.denuncia_fotos
  for select
  to service_role
  using (true);

drop policy if exists "denuncia_fotos service manage" on public.denuncia_fotos;
create policy "denuncia_fotos service manage"
  on public.denuncia_fotos
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "denuncia_fotos storage anon upload" on storage.objects;
create policy "denuncia_fotos storage anon upload"
  on storage.objects
  for insert
  to anon
  with check (
    bucket_id = 'denuncia-fotos'
    and lower((storage.extension(name))) in ('jpg', 'jpeg', 'png', 'webp')
  );

drop policy if exists "denuncia_fotos storage service manage" on storage.objects;
create policy "denuncia_fotos storage service manage"
  on storage.objects
  for all
  to service_role
  using (bucket_id = 'denuncia-fotos')
  with check (bucket_id = 'denuncia-fotos');

notify pgrst, 'reload schema';
