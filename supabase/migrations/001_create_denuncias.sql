create extension if not exists pgcrypto;

create table if not exists public.denuncias (
  id uuid primary key default gen_random_uuid(),
  data_registro timestamptz not null default now(),
  created_at timestamptz not null default now(),
  tipo text not null check (tipo in ('Abandono', 'Agressao', 'Negligencia', 'Outros')),
  tipos text,
  descricao text not null,
  endereco text not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  latitude_publica double precision generated always as (round(latitude::numeric, 3)::double precision) stored,
  longitude_publica double precision generated always as (round(longitude::numeric, 3)::double precision) stored,
  bairro text,
  status text not null default 'recebida' check (status in ('recebida', 'em_analise', 'verificada', 'encaminhada', 'arquivada')),
  is_anonimo boolean not null default true,
  nome text,
  email text,
  telefone text
);

alter table public.denuncias
  add column if not exists data_registro timestamptz not null default now(),
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists tipos text,
  add column if not exists latitude double precision,
  add column if not exists longitude double precision,
  add column if not exists latitude_publica double precision generated always as (round(latitude::numeric, 3)::double precision) stored,
  add column if not exists longitude_publica double precision generated always as (round(longitude::numeric, 3)::double precision) stored,
  add column if not exists bairro text,
  add column if not exists status text not null default 'recebida',
  add column if not exists is_anonimo boolean not null default true,
  add column if not exists nome text,
  add column if not exists email text,
  add column if not exists telefone text;

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
drop policy if exists "denuncias service role full access" on public.denuncias;

create policy "denuncias anon insert"
  on public.denuncias
  for insert
  to anon
  with check (true);

create policy "denuncias service role full access"
  on public.denuncias
  for all
  to service_role
  using (true)
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

create or replace function public.criar_denuncia(
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
