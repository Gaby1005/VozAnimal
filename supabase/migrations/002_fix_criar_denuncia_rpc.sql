-- Correção da integração Supabase do Voz Animal.
-- Execute este arquivo no Supabase SQL Editor do projeto:
-- https://xgtqnkanwtecbbllrmjk.supabase.co
--
-- Este script é idempotente: ele preserva dados existentes,
-- adiciona apenas o que estiver faltando e recarrega o cache do PostgREST.

create extension if not exists pgcrypto;

create table if not exists public.denuncias (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  endereco text not null,
  tipo text not null,
  tipos text,
  descricao text not null,
  is_anonimo boolean not null default true,
  nome text,
  email text,
  telefone text,
  latitude double precision,
  longitude double precision
);

alter table public.denuncias
  add column if not exists data_registro timestamptz;

update public.denuncias
set data_registro = coalesce(data_registro, created_at, now())
where data_registro is null;

alter table public.denuncias
  alter column data_registro set default now(),
  alter column data_registro set not null;

alter table public.denuncias
  add column if not exists bairro text,
  add column if not exists status text not null default 'recebida';

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'denuncias'
      and column_name = 'latitude_publica'
  ) then
    alter table public.denuncias
      add column latitude_publica double precision
      generated always as (round(latitude::numeric, 3)::double precision) stored;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'denuncias'
      and column_name = 'longitude_publica'
  ) then
    alter table public.denuncias
      add column longitude_publica double precision
      generated always as (round(longitude::numeric, 3)::double precision) stored;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'denuncias_tipo_check'
      and conrelid = 'public.denuncias'::regclass
  ) then
    alter table public.denuncias
      add constraint denuncias_tipo_check
      check (tipo in ('Abandono', 'Agressao', 'Negligencia', 'Outros'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'denuncias_status_check'
      and conrelid = 'public.denuncias'::regclass
  ) then
    alter table public.denuncias
      add constraint denuncias_status_check
      check (status in ('recebida', 'em_analise', 'verificada', 'encaminhada', 'arquivada'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'denuncias_latitude_check'
      and conrelid = 'public.denuncias'::regclass
  ) then
    alter table public.denuncias
      add constraint denuncias_latitude_check
      check (latitude is null or latitude between -90 and 90);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'denuncias_longitude_check'
      and conrelid = 'public.denuncias'::regclass
  ) then
    alter table public.denuncias
      add constraint denuncias_longitude_check
      check (longitude is null or longitude between -180 and 180);
  end if;
end $$;

create index if not exists denuncias_data_registro_idx
  on public.denuncias (data_registro desc);

create index if not exists denuncias_tipo_idx
  on public.denuncias (tipo);

create index if not exists denuncias_bairro_idx
  on public.denuncias (bairro);

create index if not exists denuncias_lat_lon_publica_idx
  on public.denuncias (latitude_publica, longitude_publica);

alter table public.denuncias enable row level security;

drop policy if exists "public read" on public.denuncias;
drop policy if exists "public insert" on public.denuncias;
drop policy if exists "denuncias anon insert" on public.denuncias;

create policy "denuncias anon insert"
  on public.denuncias
  for insert
  to anon
  with check (true);

create or replace view public.denuncias_mapa as
select
  id,
  data_registro,
  tipo,
  bairro,
  status,
  latitude_publica,
  longitude_publica
from public.denuncias
where latitude_publica is not null
  and longitude_publica is not null;

grant select on public.denuncias_mapa to anon;
grant insert on public.denuncias to anon;

drop function if exists public.criar_denuncia(
  text,
  text,
  text,
  text,
  boolean,
  text,
  text,
  text,
  double precision,
  double precision,
  text
);

create function public.criar_denuncia(
  p_endereco text,
  p_tipo text,
  p_tipos text,
  p_descricao text,
  p_is_anonimo boolean,
  p_nome text,
  p_email text,
  p_telefone text,
  p_latitude double precision,
  p_longitude double precision,
  p_bairro text
)
returns table (
  id uuid,
  data_registro timestamptz,
  tipo text,
  bairro text,
  status text,
  latitude_publica double precision,
  longitude_publica double precision
)
language plpgsql
security invoker
set search_path = public
as $$
begin
  return query
  insert into public.denuncias (
    endereco,
    tipo,
    tipos,
    descricao,
    is_anonimo,
    nome,
    email,
    telefone,
    latitude,
    longitude,
    bairro
  )
  values (
    nullif(trim(p_endereco), ''),
    p_tipo,
    nullif(trim(p_tipos), ''),
    nullif(trim(p_descricao), ''),
    coalesce(p_is_anonimo, true),
    case when coalesce(p_is_anonimo, true) then null else nullif(trim(p_nome), '') end,
    case when coalesce(p_is_anonimo, true) then null else nullif(trim(p_email), '') end,
    case when coalesce(p_is_anonimo, true) then null else nullif(trim(p_telefone), '') end,
    p_latitude,
    p_longitude,
    nullif(trim(p_bairro), '')
  )
  returning
    denuncias.id,
    denuncias.data_registro,
    denuncias.tipo,
    denuncias.bairro,
    denuncias.status,
    denuncias.latitude_publica,
    denuncias.longitude_publica;
end;
$$;

grant execute on function public.criar_denuncia(
  text,
  text,
  text,
  text,
  boolean,
  text,
  text,
  text,
  double precision,
  double precision,
  text
) to anon;

notify pgrst, 'reload schema';

-- Conferencias opcionais apos executar:
-- select column_name, data_type
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'denuncias'
-- order by ordinal_position;
--
-- select routine_name, data_type
-- from information_schema.parameters
-- where specific_schema = 'public' and specific_name like 'criar_denuncia%'
-- order by ordinal_position;
--
-- select * from public.denuncias_mapa limit 5;
