-- Correção de RLS para a função public.criar_denuncia.
-- Execute no Supabase SQL Editor depois da migration 002.
--
-- Causa: a função já existe no cache do PostgREST, mas a inserção
-- está sendo bloqueada pela RLS da tabela public.denuncias.
-- Solução: manter RLS ativo e expor somente uma função controlada
-- SECURITY DEFINER para registrar denúncias anônimas pelo frontend.

alter table public.denuncias enable row level security;

drop policy if exists "denuncias anon insert" on public.denuncias;

create policy "denuncias anon insert"
  on public.denuncias
  for insert
  to anon
  with check (true);

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
security definer
set search_path = public
as $$
begin
  if nullif(trim(p_endereco), '') is null then
    raise exception 'Endereco obrigatorio';
  end if;

  if p_tipo not in ('Abandono', 'Agressao', 'Negligencia', 'Outros') then
    raise exception 'Tipo de denuncia invalido';
  end if;

  if nullif(trim(p_descricao), '') is null then
    raise exception 'Descricao obrigatoria';
  end if;

  if p_latitude is null or p_latitude < -90 or p_latitude > 90 then
    raise exception 'Latitude invalida';
  end if;

  if p_longitude is null or p_longitude < -180 or p_longitude > 180 then
    raise exception 'Longitude invalida';
  end if;

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

revoke all on function public.criar_denuncia(
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
) from public;

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

grant select on public.denuncias_mapa to anon;

notify pgrst, 'reload schema';
