
// Lógica para mudar a cor do header ao scroll
const supabaseConfigValida =
    Boolean(window.SUPABASE_URL && window.SUPABASE_ANON_KEY) &&
    !String(window.SUPABASE_URL).includes('SEU-PROJECT-REF') &&
    !String(window.SUPABASE_ANON_KEY).includes('SUA_ANON_PUBLIC_KEY');

const supabaseClient =
    window.supabase && supabaseConfigValida
        ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY)
        : null;

const ITU_LAT = -23.2637;
const ITU_LON = -47.2995;
const NOME_ARQUIVO_BOLETIM = 'relatorio-noticia-crime-voz-animal.pdf';
const BUCKET_FOTOS_DENUNCIA = 'denuncia-fotos';
const LIMITE_FOTOS_DENUNCIA = 5;
const TAMANHO_MAXIMO_FOTO = 10 * 1024 * 1024;
const TIPOS_FOTO_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp'];

let fotosSelecionadasDenuncia = [];
let denunciaRegistradaAtual = null;

function formatarDenunciaParaMapa(denuncia) {
    return {
        id: denuncia.id,
        tipo: denuncia.tipo,
        tipos: denuncia.tipos,
        descricao: denuncia.descricao_publica || 'Registro recebido pela plataforma. Dados sensíveis preservados.',
        endereco: denuncia.bairro ? `${denuncia.bairro} - Itu/SP` : 'Região de Itu/SP',
        dataRegistro: (denuncia.data_registro || denuncia.created_at)
            ? new Date(denuncia.data_registro || denuncia.created_at).toLocaleDateString('pt-BR')
            : new Date().toLocaleDateString('pt-BR'),
        latitude: Number(denuncia.latitude_publica ?? denuncia.latitude),
        longitude: Number(denuncia.longitude_publica ?? denuncia.longitude),
        status: denuncia.status || 'recebida'
    };
}

function escaparHTML(valor) {
    return String(valor ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function normalizarTipoParaMapa(tiposArray) {
    if (tiposArray.includes('Abandono')) return 'Abandono';
    if (tiposArray.includes('Agressão física')) return 'Agressao';
    if (tiposArray.includes('Negligência')) return 'Negligencia';
    if (tiposArray.includes('Sem água ou comida')) return 'Negligencia';
    if (tiposArray.includes('Animal preso constantemente')) return 'Negligencia';
    return 'Outros';
}

function normalizarCategoriaDenuncia(valor) {
    const texto = String(valor || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    if (texto.includes('abandono')) return 'Abandono';
    if (texto.includes('agressao') || texto.includes('maus-tratos') || texto.includes('maus tratos')) return 'Agressao';
    if (
        texto.includes('negligencia') ||
        texto.includes('sem agua') ||
        texto.includes('sem comida') ||
        texto.includes('preso constantemente')
    ) return 'Negligencia';

    return 'Outros';
}

function obterCategoriasDaDenuncia(denuncia) {
    if (denuncia?.tipos) {
        return Array.from(new Set(
            String(denuncia.tipos)
                .split('/')
                .map(item => normalizarCategoriaDenuncia(item.trim()))
                .filter(Boolean)
        ));
    }

    return [normalizarCategoriaDenuncia(denuncia?.tipo)];
}

async function geocodificarEndereco(endereco) {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('format', 'json');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', '1');
    url.searchParams.set('countrycodes', 'br');
    url.searchParams.set('q', `${endereco}, Itu, SP, Brasil`);

    const res = await fetch(url.toString(), {
        headers: { Accept: 'application/json' }
    });

    if (!res.ok) {
        throw new Error('O serviço de geocodificação não respondeu corretamente. Tente novamente em alguns instantes.');
    }

    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error('Não foi possível localizar esse endereço. Confira se ele está em Itu/SP e tente informar rua, número e bairro.');
    }

    const item = data[0];
    const latitude = Number(item.lat);
    const longitude = Number(item.lon);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new Error('O endereço foi encontrado, mas as coordenadas retornadas são inválidas.');
    }

    const enderecoDetalhado = item.address || {};
    const bairro =
        enderecoDetalhado.suburb ||
        enderecoDetalhado.neighbourhood ||
        enderecoDetalhado.city_district ||
        enderecoDetalhado.village ||
        enderecoDetalhado.town ||
        enderecoDetalhado.city ||
        'Itu';

    return { latitude, longitude, bairro };
}

function obterMensagemErroDenuncia(error) {
    if (error?.name === 'TypeError' || String(error?.message || '').includes('Failed to fetch')) {
        return 'Não foi possível conectar ao Supabase. Verifique se a URL do projeto e a chave pública estão corretas.';
    }

    if (error?.code === 'PGRST202' || String(error?.message || '').includes('criar_denuncia')) {
        return 'A função criar_denuncia ainda não existe ou o cache do Supabase não foi atualizado. Execute a migration 002_fix_criar_denuncia_rpc.sql no SQL Editor do Supabase.';
    }

    if (error?.code === 'PGRST205' || String(error?.message || '').includes('denuncias_mapa')) {
        return 'A view denuncias_mapa ainda não existe no Supabase. Execute a migration 002_fix_criar_denuncia_rpc.sql no SQL Editor.';
    }

    return error?.message || 'erro desconhecido';
}

function registrarErroSupabase(contexto, error) {
    console.warn(contexto, {
        code: error?.code,
        name: error?.name,
        message: error?.message,
        details: error?.details,
        hint: error?.hint
    });
}

function formatarTamanhoArquivo(bytes) {
    if (!Number.isFinite(bytes)) return 'tamanho desconhecido';
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

function obterExtensaoFoto(file) {
    const nome = file.name || '';
    const extensaoNome = nome.split('.').pop()?.toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp'].includes(extensaoNome)) return extensaoNome;
    if (file.type === 'image/png') return 'png';
    if (file.type === 'image/webp') return 'webp';
    return 'jpg';
}

function limparNomeArquivo(nome) {
    return String(nome || 'foto')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80) || 'foto';
}

function gerarIdentificadorArquivo() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function atualizarFeedbackFotos(mensagem, tipo = 'info') {
    const feedback = document.getElementById('fotos-feedback');
    if (!feedback) return;
    feedback.textContent = mensagem || '';
    feedback.dataset.tipo = tipo;
}

function atualizarPreviewFotos() {
    const preview = document.getElementById('fotos-preview');
    if (!preview) return;

    preview.innerHTML = '';

    fotosSelecionadasDenuncia.forEach((item, index) => {
        const card = document.createElement('article');
        card.className = 'foto-preview-card';

        const img = document.createElement('img');
        img.src = item.previewUrl;
        img.alt = `Pré-visualização da fotografia ${String(index + 1).padStart(2, '0')}`;

        const info = document.createElement('div');
        info.innerHTML = `
            <strong>Fotografia ${String(index + 1).padStart(2, '0')}</strong>
            <span>${escaparHTML(item.file.name)}</span>
            <small>${formatarTamanhoArquivo(item.file.size)}</small>
        `;

        const remover = document.createElement('button');
        remover.type = 'button';
        remover.className = 'btn-remover-foto';
        remover.textContent = 'Remover';
        remover.addEventListener('click', () => {
            URL.revokeObjectURL(item.previewUrl);
            fotosSelecionadasDenuncia.splice(index, 1);
            atualizarPreviewFotos();
            atualizarFeedbackFotos(
                fotosSelecionadasDenuncia.length
                    ? `${fotosSelecionadasDenuncia.length} fotografia(s) selecionada(s).`
                    : ''
            );
        });

        card.append(img, info, remover);
        preview.appendChild(card);
    });
}

function adicionarFotosSelecionadas(files) {
    const erros = [];

    Array.from(files || []).forEach(file => {
        if (fotosSelecionadasDenuncia.length >= LIMITE_FOTOS_DENUNCIA) {
            erros.push(`Limite de ${LIMITE_FOTOS_DENUNCIA} fotografias atingido.`);
            return;
        }

        if (!TIPOS_FOTO_PERMITIDOS.includes(file.type)) {
            erros.push(`${file.name}: formato não permitido. Use JPG, JPEG, PNG ou WEBP.`);
            return;
        }

        if (file.size > TAMANHO_MAXIMO_FOTO) {
            erros.push(`${file.name}: arquivo maior que 10 MB.`);
            return;
        }

        fotosSelecionadasDenuncia.push({
            file,
            previewUrl: URL.createObjectURL(file)
        });
    });

    atualizarPreviewFotos();

    if (erros.length) {
        atualizarFeedbackFotos(erros.join(' '), 'erro');
    } else if (fotosSelecionadasDenuncia.length) {
        atualizarFeedbackFotos(`${fotosSelecionadasDenuncia.length} fotografia(s) selecionada(s).`, 'sucesso');
    } else {
        atualizarFeedbackFotos('');
    }
}

function resetarFotosSelecionadas() {
    fotosSelecionadasDenuncia.forEach(item => URL.revokeObjectURL(item.previewUrl));
    fotosSelecionadasDenuncia = [];
    const inputFotos = document.getElementById('fotos-denuncia');
    const progresso = document.getElementById('fotos-progresso');
    if (inputFotos) inputFotos.value = '';
    if (progresso) progresso.textContent = '';
    atualizarFeedbackFotos('');
    atualizarPreviewFotos();
}

async function lerArquivoComoDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('Não foi possível ler a fotografia.'));
        reader.readAsDataURL(file);
    });
}

async function prepararImagemParaPdf(file) {
    const dataUrl = await lerArquivoComoDataURL(file);

    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
            const maxWidth = 1200;
            const scale = Math.min(1, maxWidth / image.width);
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(image.width * scale);
            canvas.height = Math.round(image.height * scale);
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        image.onerror = () => reject(new Error(`Não foi possível preparar a fotografia ${file.name} para o PDF.`));
        image.src = dataUrl;
    });
}

async function enviarFotosDenuncia(denunciaId) {
    if (!fotosSelecionadasDenuncia.length) return [];

    const progresso = document.getElementById('fotos-progresso');
    const registros = [];
    const pathsEnviados = [];

    for (let index = 0; index < fotosSelecionadasDenuncia.length; index++) {
        const { file } = fotosSelecionadasDenuncia[index];
        const ordem = index + 1;
        const extensao = obterExtensaoFoto(file);
        const nomeSeguro = limparNomeArquivo(file.name).replace(/\.[^.]+$/, '');
        const storagePath = `${denunciaId}/${Date.now()}-${ordem}-${gerarIdentificadorArquivo()}.${extensao}`;

        if (progresso) {
            progresso.textContent = `Enviando fotografia ${ordem} de ${fotosSelecionadasDenuncia.length}...`;
        }

        const { error: uploadError } = await supabaseClient.storage
            .from(BUCKET_FOTOS_DENUNCIA)
            .upload(storagePath, file, {
                contentType: file.type,
                cacheControl: '3600',
                upsert: false
            });

        if (uploadError) {
            throw uploadError;
        }

        pathsEnviados.push(storagePath);
        registros.push({
            denuncia_id: denunciaId,
            storage_path: storagePath,
            nome_original: file.name,
            nome_exibicao: `${nomeSeguro || 'fotografia'}-${String(ordem).padStart(2, '0')}.${extensao}`,
            mime_type: file.type,
            tamanho_bytes: file.size,
            ordem
        });
    }

    const { error } = await supabaseClient
        .from('denuncia_fotos')
        .insert(registros);

    if (error) {
        await supabaseClient.storage.from(BUCKET_FOTOS_DENUNCIA).remove(pathsEnviados);
        throw error;
    }

    if (progresso) progresso.textContent = 'Fotografias anexadas ao relatório.';
    return registros;
}

function gerarTextoRelatorioDenuncia(dados) {
    const identificacao = dados.isAnonimo
        ? 'O denunciante optou por realizar a comunicação de forma anônima.'
        : `Nome: ${dados.nome || 'Não informado'}\nE-mail: ${dados.email || 'Não informado'}\nTelefone: ${dados.telefone || 'Não informado'}`;

    const fotosTexto = dados.fotos?.length
        ? dados.fotos.map((foto, index) => `Fotografia ${String(index + 1).padStart(2, '0')}: ${foto.nome_original || foto.nome_exibicao || 'arquivo anexado'}`).join('\n')
        : 'Não foram anexadas fotografias ao registro.';

    return `VOZ ANIMAL

RELATÓRIO DE COMUNICAÇÃO DE POSSÍVEL CRIME DE MAUS-TRATOS CONTRA ANIMAIS (NOTÍCIA-CRIME)

Os dados e relatos registrados neste formulário serão compilados em documento próprio e apresentados às autoridades policiais competentes para apuração dos fatos.

1. IDENTIFICAÇÃO DO REGISTRO
Identificador do registro: ${dados.id || 'Não informado'}
Data e horário do registro: ${dados.dataRegistro || 'Não informado'}

2. TIPO DE OCORRÊNCIA
${dados.tiposMarcados || dados.tipo || 'Não informado'}

3. ENDEREÇO OU LOCALIZAÇÃO INFORMADA
${dados.endereco || 'Não informado'}
${dados.bairro ? `Bairro/região identificado(a): ${dados.bairro}` : ''}

4. DESCRIÇÃO DETALHADA DOS FATOS RELATADOS
${dados.relato || 'Não informado'}

5. IDENTIFICAÇÃO DO DENUNCIANTE
${identificacao}

6. INFORMAÇÃO SOBRE ANONIMATO
${dados.isAnonimo ? 'Comunicação registrada como anônima.' : 'Comunicação registrada com identificação voluntária do denunciante.'}

7. ANEXOS — REGISTROS FOTOGRÁFICOS
${fotosTexto}

8. OBSERVAÇÕES COMPLEMENTARES
As informações foram fornecidas voluntariamente pelo usuário do sistema Voz Animal. A possível prática de maus-tratos contra animais é tratada no artigo 32 da Lei nº 9.605/1998.

DECLARAÇÃO FINAL
Este documento constitui um relatório particular de comunicação de possível crime, elaborado a partir das informações voluntariamente fornecidas pelo denunciante. Não possui natureza de Boletim de Ocorrência oficial e não substitui o registro formal perante os órgãos competentes. Seu objetivo é reunir informações e eventuais elementos de prova para subsidiar a comunicação dos fatos às autoridades responsáveis pela análise e eventual apuração.`;
}

function atualizarRevisaoFotos(fotos) {
    const container = document.getElementById('fotos-anexadas-revisao');
    const btnBaixarFotos = document.getElementById('btn-baixar-fotos');
    if (!container) return;

    if (!fotosSelecionadasDenuncia.length) {
        container.innerHTML = '<p class="fotos-sem-anexo">Nenhuma fotografia foi anexada a este relatório.</p>';
        if (btnBaixarFotos) btnBaixarFotos.style.display = 'none';
        return;
    }

    container.innerHTML = `
        <h4>Anexos — registros fotográficos</h4>
        <div class="fotos-preview fotos-preview-revisao">
            ${fotosSelecionadasDenuncia.map((item, index) => `
                <article class="foto-preview-card">
                    <img src="${item.previewUrl}" alt="Fotografia ${String(index + 1).padStart(2, '0')} anexada">
                    <div>
                        <strong>Fotografia ${String(index + 1).padStart(2, '0')}</strong>
                        <span>${escaparHTML(fotos?.[index]?.nome_original || item.file.name)}</span>
                        <small>${formatarTamanhoArquivo(item.file.size)}</small>
                    </div>
                </article>
            `).join('')}
        </div>
    `;

    if (btnBaixarFotos) btnBaixarFotos.style.display = '';
}

async function copiarTextoParaAreaTransferencia(texto) {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(texto);
        } else {
            const inputTemporario = document.createElement('textarea');
            inputTemporario.value = texto;
            inputTemporario.setAttribute('readonly', '');
            inputTemporario.style.position = 'fixed';
            inputTemporario.style.opacity = '0';
            document.body.appendChild(inputTemporario);
            inputTemporario.select();
            document.execCommand('copy');
            document.body.removeChild(inputTemporario);
        }

        alert(`E-mail copiado: ${texto}`);
    } catch (error) {
        console.error('Não foi possível copiar o e-mail:', error);
        alert(`Não foi possível copiar automaticamente. Copie manualmente: ${texto}`);
    }
}

const header = document.getElementById('main-header');
const sections = document.querySelectorAll('section');
const navLinks = document.querySelectorAll('.nav-menu a');
const menuToggle = document.querySelector('.menu-toggle');
const navMenu = document.querySelector('.nav-menu');

function fecharMenuMobile() {
    if (!menuToggle || !navMenu) return;
    menuToggle.classList.remove('active');
    navMenu.classList.remove('active');
    document.body.classList.remove('menu-open');
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', 'Abrir menu');
}

if (menuToggle && navMenu) {
    menuToggle.addEventListener('click', () => {
        const menuAberto = navMenu.classList.toggle('active');
        menuToggle.classList.toggle('active', menuAberto);
        document.body.classList.toggle('menu-open', menuAberto);
        menuToggle.setAttribute('aria-expanded', String(menuAberto));
        menuToggle.setAttribute('aria-label', menuAberto ? 'Fechar menu' : 'Abrir menu');
    });

    navLinks.forEach(link => {
        link.addEventListener('click', fecharMenuMobile);
    });

    window.addEventListener('resize', () => {
        if (window.innerWidth > 768) fecharMenuMobile();
    });
}

// Lógica de Revelação ao Rolar (Intersection Observer)
const revealElements = document.querySelectorAll('[data-reveal]');
const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('active');
        }
    });
}, { threshold: 0.1 });

revealElements.forEach(el => revealObserver.observe(el));

window.addEventListener('scroll', () => {
    if (!header) return;
    // Header Color Change
    if (window.scrollY > 50) {
        header.classList.add('scrolled');
    } else {
        header.classList.remove('scrolled');
    }

    // ScrollSpy - Active Link & Adaptive Header
    let current = "";
    let currentTheme = "dark";
    sections.forEach(section => {
        const sectionTop = section.offsetTop;
        const sectionHeight = section.clientHeight;
        if (pageYOffset >= (sectionTop - 150)) {
            current = section.getAttribute('id');
            currentTheme = section.getAttribute('data-theme') || "light";
        }
    });

    // Update Header Theme based on Section
    if (window.scrollY > 50) {
        header.classList.add('scrolled');
        header.setAttribute('data-header-theme', 'light');
    } else {
        header.classList.remove('scrolled');
        header.setAttribute('data-header-theme', currentTheme);
    }

    // Update Active Link
    navLinks.forEach(link => {
        link.classList.remove('active');
        if (link.getAttribute('href').includes(current)) {
            link.classList.add('active');
        }
    });
});

// Smooth Scroll para os links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const targetId = this.getAttribute('href');
        const targetElement = document.querySelector(targetId);
        
        if (targetElement) {
            window.scrollTo({
                top: targetElement.offsetTop - 80, // Offset for header
                behavior: 'smooth'
            });
        }
    });
});

// Lógica do Formulário de Denúncia
const denunciaOverlay = document.getElementById('form-denuncia-overlay');
const btnAbrirForm = document.querySelector('.btn-register');
const btnFecharForm = document.querySelector('.form-overlay .close-btn');
const formSteps = document.querySelectorAll('.form-step');
const btnNext = document.querySelectorAll('.btn-next');
const btnPrev = document.querySelectorAll('.btn-prev');
const identificacaoRadios = document.querySelectorAll('input[name="identificacao"]');
const identificacaoFields = document.getElementById('identificacao-fields');
const formDenuncia = document.getElementById('denuncia-form');
const inputFotosDenuncia = document.getElementById('fotos-denuncia');

let currentStep = 0;

function showStep(step) {
    formSteps.forEach((s, index) => {
        s.classList.remove('active');
        if (index === step) {
            s.classList.add('active');
        }
    });
}

function updateIdentificacaoFields() {
    const selectedValue = document.querySelector('input[name="identificacao"]:checked').value;
    if (selectedValue === 'identificar') {
        identificacaoFields.style.display = 'block';
        identificacaoFields.querySelectorAll('input').forEach(input => input.setAttribute('required', 'true'));
    } else {
        identificacaoFields.style.display = 'none';
        identificacaoFields.querySelectorAll('input').forEach(input => input.removeAttribute('required'));
    }
}

// Abrir formulário
if (btnAbrirForm) {
    btnAbrirForm.addEventListener('click', () => {
        if (denunciaOverlay) {
            denunciaOverlay.classList.add('active');
            document.body.style.overflow = 'hidden'; // Bloqueia o scroll do fundo
            currentStep = 0;
            showStep(currentStep);
            updateIdentificacaoFields();
            resetarFotosSelecionadas();
            denunciaRegistradaAtual = null;
            if (formDenuncia) formDenuncia.style.display = 'block';
            const boletimRevisao = document.getElementById('boletim-revisao');
            if (boletimRevisao) boletimRevisao.style.display = 'none';
        }
    });
}

// Fechar formulário
if (btnFecharForm) {
    btnFecharForm.addEventListener('click', () => {
        if (denunciaOverlay) {
            denunciaOverlay.classList.remove('active');
            document.body.style.overflow = ''; // Restaura o scroll do fundo
            if (formDenuncia) formDenuncia.reset();
            resetarFotosSelecionadas();
            denunciaRegistradaAtual = null;
            if (formDenuncia) formDenuncia.style.display = 'block';
            const boletimRevisao = document.getElementById('boletim-revisao');
            if (boletimRevisao) boletimRevisao.style.display = 'none';
        }
    });
}

// Navegação Próximo
if (btnNext) {
    btnNext.forEach(button => {
        button.addEventListener('click', () => {
            const currentActiveStep = formSteps[currentStep];
            const inputs = currentActiveStep.querySelectorAll('input[required], textarea[required]');
            let allValid = true;

            inputs.forEach(input => {
                if (!input.value.trim()) {
                    allValid = false;
                    input.classList.add('invalid');
                } else {
                    input.classList.remove('invalid');
                }
            });

            if (currentStep === 1) {
                const checkboxes = currentActiveStep.querySelectorAll('input[type="checkbox"][name="presenciou"]');
                const anyChecked = Array.from(checkboxes).some(checkbox => checkbox.checked);
                if (!anyChecked) {
                    allValid = false;
                    alert('Por favor, selecione pelo menos uma opção do que você presenciou.');
                }
            }

            if (allValid) {
                if (currentStep < formSteps.length - 1) {
                    currentStep++;
                    showStep(currentStep);
                }
            } else {
                alert('Por favor, preencha todos os campos obrigatórios.');
            }
        });
    });
}

// Navegação Voltar
if (btnPrev) {
    btnPrev.forEach(button => {
        button.addEventListener('click', () => {
            if (currentStep > 0) {
                currentStep--;
                showStep(currentStep);
            }
        });
    });
}

// Lógica para mostrar/esconder campos de identificação
if (identificacaoRadios) {
    identificacaoRadios.forEach(radio => {
        radio.addEventListener('change', updateIdentificacaoFields);
    });
}

if (inputFotosDenuncia) {
    inputFotosDenuncia.addEventListener('change', event => {
        adicionarFotosSelecionadas(event.target.files);
        event.target.value = '';
    });
}

// Submissão do formulário
if (formDenuncia) {
    formDenuncia.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        if (formDenuncia.dataset.submitting === 'true') return;
        formDenuncia.dataset.submitting = 'true';

        const submitButton = formDenuncia.querySelector('.btn-submit');
        if (submitButton) {
            submitButton.disabled = true;
            submitButton.textContent = 'Salvando...';
        }

        const endereco = document.getElementById('endereco').value;
        const tiposArray = Array.from(document.querySelectorAll('input[name="presenciou"]:checked')).map(cb => cb.value);
        const tiposMarcados = tiposArray.join(' / ');
        const relato = document.getElementById('descricao').value;
        const isAnonimo = document.querySelector('input[name="identificacao"]:checked').value === 'anonima';
        const nome = isAnonimo ? null : document.getElementById('nome').value;
        const email = isAnonimo ? null : document.getElementById('email').value;
        const telefone = isAnonimo ? null : document.getElementById('telefone').value;

        // Prepara a revisão; a troca de tela acontece depois que banco e fotos confirmarem.
        const boletimTexto = document.getElementById('boletim-texto');
        const boletimRevisao = document.getElementById('boletim-revisao');

        const tipoParaMapa = normalizarTipoParaMapa(tiposArray);
        let registroPrincipalCriado = false;

        try {
            if (!supabaseClient) {
                throw new Error('A configuração do Supabase está ausente ou inválida. Atualize o arquivo supabase-config.js com a Project URL e a anon public key do seu projeto ativo.');
            }

            const geo = await geocodificarEndereco(endereco);

            const { data: denunciaSalva, error } = await supabaseClient
                .rpc('criar_denuncia', {
                    p_endereco: endereco,
                    p_tipo: tipoParaMapa,
                    p_tipos: tiposMarcados,
                    p_descricao: relato,
                    p_is_anonimo: isAnonimo,
                    p_nome: nome,
                    p_email: email,
                    p_telefone: telefone,
                    p_latitude: geo.latitude,
                    p_longitude: geo.longitude,
                    p_bairro: geo.bairro
                });

            if (error) throw error;

            const denunciaPublica = Array.isArray(denunciaSalva) ? denunciaSalva[0] : denunciaSalva;
            registroPrincipalCriado = true;
            const denunciaMapa = formatarDenunciaParaMapa(denunciaPublica);
            const fotosEnviadas = await enviarFotosDenuncia(denunciaPublica.id);
            const dataRegistroRelatorio = denunciaPublica.data_registro
                ? new Date(denunciaPublica.data_registro).toLocaleString('pt-BR')
                : new Date().toLocaleString('pt-BR');

            denunciaRegistradaAtual = {
                id: denunciaPublica.id,
                dataRegistro: dataRegistroRelatorio,
                tipo: tipoParaMapa,
                tiposMarcados,
                endereco,
                bairro: denunciaPublica.bairro || geo.bairro,
                relato,
                isAnonimo,
                nome,
                email,
                telefone,
                fotos: fotosEnviadas
            };

            if (boletimTexto) {
                boletimTexto.innerText = gerarTextoRelatorioDenuncia(denunciaRegistradaAtual);
            }

            atualizarRevisaoFotos(fotosEnviadas);

            if (window.__vozAnimalMapa?.adicionarDenuncia) {
                window.__vozAnimalMapa.adicionarDenuncia(denunciaMapa);
            }

            if (boletimRevisao) boletimRevisao.style.display = 'block';
            formDenuncia.style.display = 'none';

            alert(`Seu relato foi registrado com sucesso!

As informações fornecidas foram organizadas em um Relatório de Comunicação de Possível Crime (Notícia-Crime).

Você poderá baixar o documento e encaminhá-lo às autoridades competentes para conhecimento e análise dos fatos.

Lembre-se: este relatório não substitui um Boletim de Ocorrência oficial.`);
        } catch (error) {
            console.error('Erro ao registrar denúncia:', error);
            if (registroPrincipalCriado) {
                alert(`O relato principal foi salvo, mas não foi possível anexar as fotografias. Detalhes: ${obterMensagemErroDenuncia(error)}

Verifique a configuração do bucket denuncia-fotos no Supabase e tente novamente. Para evitar duplicidade, confira o painel do Supabase antes de reenviar o formulário.`);
            } else {
                alert(`Não foi possível registrar a denúncia no banco de dados. Detalhes: ${obterMensagemErroDenuncia(error)}`);
            }
        } finally {
            formDenuncia.dataset.submitting = 'false';
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.textContent = 'Gerar relatório';
            }
        }
    });
}

// Botão Editar na revisão
const btnEditarDenuncia = document.getElementById('btn-editar-denuncia');
if (btnEditarDenuncia) {
    btnEditarDenuncia.addEventListener('click', () => {
        const boletimRevisao = document.getElementById('boletim-revisao');
        if (boletimRevisao) boletimRevisao.style.display = 'none';
        if (formDenuncia) formDenuncia.style.display = 'block';
    });
}

// Botão Baixar PDF
const btnBaixarPdf = document.getElementById('btn-baixar-pdf');
if (btnBaixarPdf) {
    btnBaixarPdf.addEventListener('click', async () => {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        
        const boletimTexto = document.getElementById('boletim-texto');
        if (!boletimTexto) return;
        
        const textoBoletim = boletimTexto.innerText;
        const margin = 20;
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const maxLineWidth = pageWidth - (margin * 2);
        let cursorY = margin;
        
        doc.setFont("helvetica", "normal");
        doc.setFontSize(12);
        
        const lines = doc.splitTextToSize(textoBoletim, maxLineWidth);
        lines.forEach(line => {
            if (cursorY > pageHeight - margin) {
                doc.addPage();
                cursorY = margin;
            }
            doc.text(line, margin, cursorY);
            cursorY += 7;
        });

        if (fotosSelecionadasDenuncia.length) {
            doc.addPage();
            cursorY = margin;
            doc.setFont("helvetica", "bold");
            doc.setFontSize(14);
            doc.text('ANEXOS — REGISTROS FOTOGRÁFICOS', margin, cursorY);
            cursorY += 12;
            doc.setFont("helvetica", "normal");
            doc.setFontSize(11);

            for (let index = 0; index < fotosSelecionadasDenuncia.length; index++) {
                const { file } = fotosSelecionadasDenuncia[index];
                try {
                    const dataUrl = await prepararImagemParaPdf(file);
                    const props = doc.getImageProperties(dataUrl);
                    const imageWidth = maxLineWidth;
                    const imageHeight = Math.min((props.height * imageWidth) / props.width, 120);

                    if (cursorY + imageHeight + 18 > pageHeight - margin) {
                        doc.addPage();
                        cursorY = margin;
                    }

                    doc.text(`Fotografia ${String(index + 1).padStart(2, '0')} - ${file.name}`, margin, cursorY);
                    cursorY += 6;
                    doc.addImage(dataUrl, 'JPEG', margin, cursorY, imageWidth, imageHeight);
                    cursorY += imageHeight + 12;
                } catch (error) {
                    console.warn('Não foi possível inserir fotografia no PDF:', {
                        name: file.name,
                        message: error?.message
                    });
                }
            }
        }

        doc.save(NOME_ARQUIVO_BOLETIM);
    });
}
        
const btnBaixarFotos = document.getElementById('btn-baixar-fotos');
if (btnBaixarFotos) {
    btnBaixarFotos.addEventListener('click', () => {
        if (!fotosSelecionadasDenuncia.length) {
            alert('Nenhuma fotografia foi anexada a este relatório.');
            return;
        }
        
        fotosSelecionadasDenuncia.forEach((item, index) => {
            const link = document.createElement('a');
            link.href = item.previewUrl;
            link.download = `foto-denuncia-${String(index + 1).padStart(2, '0')}-${limparNomeArquivo(item.file.name)}`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        });
    });
}

// Cópia dos contatos de encaminhamento.
document.querySelectorAll('.btn-copy-email').forEach(button => {
    button.addEventListener('click', function () {
        copiarTextoParaAreaTransferencia(this.getAttribute('data-email'));
    });
});

// Inicialização Geral
document.addEventListener('DOMContentLoaded', async () => {
    // Inicializar ícones Lucide
    if (window.lucide) {
        lucide.createIcons();
    }

    // Lógica para Revelar Conteúdo Sensível (usando delegação de evento para maior robustez)
    document.addEventListener('click', function(e) {
        if (e.target && e.target.classList.contains('btn-reveal-images')) {
            const container = e.target.closest('.story-images');
            if (container) {
                container.classList.add('revealed');
            }
        }
    });

    // =========================================================
    // SEÇÃO: MAPA DE DENÚNCIAS (HOME)
    // =========================================================
    // Verifica se o container do mapa existe nesta página (evita erros em outras páginas)
    const mapContainer = document.getElementById('map-container');
    if (mapContainer && window.L) {
        if (!supabaseClient) {
            console.warn('Supabase não carregou. O mapa exibirá apenas dados de exemplo até a configuração ser corrigida.');
        }

        // ---------------------------------------------------------------------
        // DADOS DE DENÚNCIAS (MOCK - substituir por integração com BD futuramente)
        // Estrutura preparada para receber dados de uma API / banco:
        //   id, tipo, descricao, endereco, dataRegistro, latitude, longitude
        // ---------------------------------------------------------------------
        const denunciasMock = [
            {
                id: 1,
                tipo: 'Abandono',
                descricao: 'Cão sem raça definida (SRD) encontrado amarrado em frente a residência desocupada há mais de 3 dias, sem água e alimento.',
                endereco: 'Rua Barão de Teffé, 500 - Centro, Itu - SP',
                dataRegistro: '22/08/2026',
                latitude: -23.2638,
                longitude: -47.2992
            },
            {
                id: 2,
                tipo: 'Agressao',
                descricao: 'Morador relata agressões físicas frequentes a um gato de rua por parte de um adolescente da vizinhança.',
                endereco: 'Av. Dr. Erasmo, 820 - Vila Bela, Itu - SP',
                dataRegistro: '21/08/2026',
                latitude: -23.2715,
                longitude: -47.2910
            },
            {
                id: 3,
                tipo: 'Negligencia',
                descricao: 'Cavalos mantidos em pasto sem cobertura vegetal, sem água potável e com sinais de desnutrição.',
                endereco: 'Estrada do Varadouro, km 3,5 - Itu - SP',
                dataRegistro: '20/08/2026',
                latitude: -23.2520,
                longitude: -47.3150
            },
            {
                id: 4,
                tipo: 'Outros',
                descricao: 'Comércio local mantendo pássaros em gaiolas superlotadas e sem ventilação adequada.',
                endereco: 'Rua XV de Novembro, 275 - Centro, Itu - SP',
                dataRegistro: '19/08/2026',
                latitude: -23.2650,
                longitude: -47.3040
            },
            {
                id: 5,
                tipo: 'Abandono',
                descricao: 'Ninhada de 4 filhotes de cachorro encontrados dentro de uma caixa de papelão na calçada.',
                endereco: 'Rua Prudente de Morais, 1100 - Jardim Regina, Itu - SP',
                dataRegistro: '18/08/2026',
                latitude: -23.2580,
                longitude: -47.2870
            },
            {
                id: 6,
                tipo: 'Negligencia',
                descricao: 'Cão da raça Pastor Alemão preso em corrente curta há meses, sem higiene e com feridas aparentes.',
                endereco: 'Rua das Flores, 180 - Jardim Europa, Itu - SP',
                dataRegistro: '17/08/2026',
                latitude: -23.2800,
                longitude: -47.2965
            },
            {
                id: 7,
                tipo: 'Agressao',
                descricao: 'Testemunhou vizinho envenenando cães de rua perto da praça.',
                endereco: 'Praça da Matriz, s/n - Centro, Itu - SP',
                dataRegistro: '16/08/2026',
                latitude: -23.2645,
                longitude: -47.3008
            },
            {
                id: 8,
                tipo: 'Abandono',
                descricao: 'Gata preta com filhotes abandonada dentro do campus universitário.',
                endereco: 'Av. Três de Março, 1500 - Parque Industrial, Itu - SP',
                dataRegistro: '15/08/2026',
                latitude: -23.2480,
                longitude: -47.3100
            }
        ];

        let supabaseLoadError = null;
        let supabaseLoadSource = null;

        async function buscarDenunciasDoSupabase() {
            if (!supabaseClient) return null;

            try {
                const consultaMapa = await supabaseClient
                    .from('denuncias_mapa')
                    .select('id, data_registro, tipo, bairro, status, latitude_publica, longitude_publica')
                    .order('data_registro', { ascending: false })
                    .limit(500);

                if (!consultaMapa.error) {
                    supabaseLoadSource = 'denuncias_mapa';
                    return (consultaMapa.data || []).map(formatarDenunciaParaMapa);
                }

                registrarErroSupabase('Falha ao carregar a view pública denuncias_mapa:', consultaMapa.error);

                const consultaTabela = await supabaseClient
                    .from('denuncias')
                    .select('id, data_registro, created_at, tipo, bairro, status, latitude_publica, longitude_publica, latitude, longitude')
                    .order('data_registro', { ascending: false, nullsFirst: false })
                    .limit(500);

                if (!consultaTabela.error) {
                    supabaseLoadSource = 'denuncias';
                    return (consultaTabela.data || []).map(formatarDenunciaParaMapa);
                }

                registrarErroSupabase('Falha ao carregar a tabela denuncias com campos atuais:', consultaTabela.error);

                const consultaTabelaLegada = await supabaseClient
                    .from('denuncias')
                    .select('id, created_at, tipo, latitude, longitude')
                    .order('created_at', { ascending: false })
                    .limit(500);

                if (!consultaTabelaLegada.error) {
                    supabaseLoadSource = 'denuncias';
                    return (consultaTabelaLegada.data || []).map(formatarDenunciaParaMapa);
                }

                supabaseLoadError = consultaTabelaLegada.error || consultaTabela.error || consultaMapa.error;
                registrarErroSupabase('Falha ao carregar a tabela denuncias com campos legados:', supabaseLoadError);
            } catch (error) {
                supabaseLoadError = error;
                registrarErroSupabase('Erro de rede ao carregar denúncias do Supabase:', error);
            }

            return null;
        }

        const denunciasDb = await buscarDenunciasDoSupabase();

        if (supabaseLoadError) {
            registrarErroSupabase('Falha ao carregar denúncias do Supabase:', supabaseLoadError);
        } else if (supabaseClient && denunciasDb && denunciasDb.length === 0) {
            console.info(`Nenhuma denúncia encontrada no Supabase pela fonte ${supabaseLoadSource || 'indefinida'}.`);
        } else if (supabaseClient && denunciasDb) {
            console.info(`Denúncias carregadas do Supabase pela fonte ${supabaseLoadSource}: ${denunciasDb.length}.`);
        }

        const denuncias = denunciasDb || (!supabaseClient ? denunciasMock : []);

        // ---------------------------------------------------------------------
        // FUNÇÃO AUXILIAR: Criar ícone de marcador customizado
        // Recebe o tipo da denúncia e retorna ícone HTML + CSS estilizado
        // ---------------------------------------------------------------------
        function criarIconeDenuncia(tipo) {
            const iconeMap = {
                'Abandono':   { classe: 'pin-abandono',   icone: 'home'              },
                'Agressao':   { classe: 'pin-agressao',   icone: 'fist'              },
                'Negligencia':{ classe: 'pin-negligencia',icone: 'alert-circle'      },
                'Outros':     { classe: 'pin-outros',     icone: 'info'              }
            };
            const config = iconeMap[tipo] || iconeMap['Outros'];

            return L.divIcon({
                className: 'custom-pin',
                html: `<div class="custom-pin-inner ${config.classe}"><i data-lucide="${config.icone}"></i></div>`,
                iconSize: [32, 32],
                iconAnchor: [16, 32],
                popupAnchor: [0, -30]
            });
        }

        // ---------------------------------------------------------------------
        // FUNÇÃO AUXILIAR: HTML do popup de cada denúncia
        // ---------------------------------------------------------------------
        function criarPopupHTML(denuncia) {
            const traduzirTipo = {
                'Abandono': 'Abandono',
                'Agressao': 'Agressão',
                'Negligencia': 'Negligência',
                'Outros': 'Outros'
            };
            const tipoAmigavel = traduzirTipo[denuncia.tipo] || denuncia.tipo;
            const classeBadge = 'popup-tipo-' + denuncia.tipo;
            const status = denuncia.status === 'verificada' ? 'Verificada' : 'Recebida';

            return `
                <div class="popup-denuncia">
                    <div class="popup-denuncia-header">
                        <span class="popup-tipo-badge ${classeBadge}">${escaparHTML(tipoAmigavel)}</span>
                        <span class="popup-data">${escaparHTML(denuncia.dataRegistro)}</span>
                    </div>
                    <p>${escaparHTML(denuncia.descricao)}</p>
                    <div class="popup-endereco">
                        <i data-lucide="map-pin"></i>
                        <span>${escaparHTML(denuncia.endereco)}</span>
                    </div>
                    <small>Status: ${escaparHTML(status)}</small>
                </div>
            `;
        }

        // ---------------------------------------------------------------------
        // INICIALIZAÇÃO DO MAPA (Leaflet)
        // Coordenadas centrais: Itu-SP, Brasil
        // ---------------------------------------------------------------------
        const mapaDenuncias = L.map('map-container', {
            center: [ITU_LAT, ITU_LON],
            zoom: 14,
            scrollWheelZoom: false, /* Evita zoom acidental durante scroll da página */
            zoomControl: true
        });

        // Camada base urbana sem chave de API. OpenTopoMap gerava tiles de aviso
        // "max zoom layer = 17", e provedores como CARTO podem exigir chave.
        const camadaBaseMapa = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 19,
            attribution: 'Tiles &copy; Esri &mdash; Source: Esri, HERE, Garmin, FAO, NOAA, USGS, &copy; OpenStreetMap contributors'
        });

        camadaBaseMapa.on('tileerror', (event) => {
            console.warn('Falha ao carregar tile do mapa:', event?.tile?.src || event);
        });

        camadaBaseMapa.addTo(mapaDenuncias);

        setTimeout(() => {
            mapaDenuncias.invalidateSize();
        }, 250);

        // Reativa o zoom com roda do mouse SOMENTE quando usuário clicar no mapa
        mapaDenuncias.on('click', function () {
            if (!mapaDenuncias.scrollWheelZoom.enabled()) {
                mapaDenuncias.scrollWheelZoom.enable();
            }
        });
        mapaDenuncias.on('mouseout', function () {
            mapaDenuncias.scrollWheelZoom.disable();
        });

        // ---------------------------------------------------------------------
        // RENDERIZAÇÃO DOS MARCADORES
        // Futuramente: substitua `denunciasMock` por dados vindos do banco
        // Ex.: fetch('/api/denuncias').then(res => res.json()).then(renderizarMarcadores)
        // ---------------------------------------------------------------------
        const marcadores = [];
        const camadaMarcadores = window.L.markerClusterGroup
            ? L.markerClusterGroup({
                showCoverageOnHover: false,
                spiderfyOnMaxZoom: true,
                disableClusteringAtZoom: 17
            })
            : L.layerGroup();

        camadaMarcadores.addTo(mapaDenuncias);
        const denunciasRenderizadas = [];
        const idsRenderizados = new Set();
        const denunciasIndicadores = denunciasDb ? [...denunciasDb] : [];
        const indicadorTotal = document.getElementById('stat-total-denuncias');
        const indicadorAbandono = document.getElementById('stat-abandono');
        const indicadorAgressao = document.getElementById('stat-agressao');
        const indicadorNegligencia = document.getElementById('stat-negligencia');
        const indicadorOutros = document.getElementById('stat-outros');
        const indicadorFeedback = document.getElementById('indicadores-feedback');

        function calcularIndicadoresDenuncias(denunciasParaContar) {
            const idsUnicos = new Set();
            const idsPorCategoria = {
                Abandono: new Set(),
                Agressao: new Set(),
                Negligencia: new Set(),
                Outros: new Set()
            };

            denunciasParaContar.forEach((denuncia, index) => {
                const id = String(denuncia.id || `sem-id-${index}`);
                idsUnicos.add(id);

                obterCategoriasDaDenuncia(denuncia).forEach(categoria => {
                    if (idsPorCategoria[categoria]) {
                        idsPorCategoria[categoria].add(id);
                    }
                });
            });

            return {
                total: idsUnicos.size,
                abandono: idsPorCategoria.Abandono.size,
                agressao: idsPorCategoria.Agressao.size,
                negligencia: idsPorCategoria.Negligencia.size,
                outros: idsPorCategoria.Outros.size
            };
        }

        function atualizarIndicadoresDenuncias() {
            if (supabaseLoadError || !supabaseClient || !denunciasDb) {
                [indicadorTotal, indicadorAbandono, indicadorAgressao, indicadorNegligencia, indicadorOutros].forEach(elemento => {
                    if (elemento) elemento.textContent = '--';
                });
                if (indicadorFeedback) {
                    indicadorFeedback.textContent = supabaseClient
                        ? obterMensagemErroDenuncia(supabaseLoadError)
                        : 'A configuração do Supabase está ausente ou inválida.';
                }
                return;
            }

            const estatisticas = calcularIndicadoresDenuncias(denunciasIndicadores);

            if (indicadorTotal) indicadorTotal.textContent = estatisticas.total;
            if (indicadorAbandono) indicadorAbandono.textContent = estatisticas.abandono;
            if (indicadorAgressao) indicadorAgressao.textContent = estatisticas.agressao;
            if (indicadorNegligencia) indicadorNegligencia.textContent = estatisticas.negligencia;
            if (indicadorOutros) indicadorOutros.textContent = estatisticas.outros;
            if (indicadorFeedback) {
                indicadorFeedback.textContent = estatisticas.total === 0
                    ? 'Nenhuma denúncia encontrada no banco de dados conectado.'
                    : '';
            }
        }

        function adicionarDenunciaAoMapa(denuncia) {
            if (idsRenderizados.has(String(denuncia.id))) return null;
            if (!Number.isFinite(denuncia.latitude) || !Number.isFinite(denuncia.longitude)) return null;

            const marcador = L.marker(
                [denuncia.latitude, denuncia.longitude],
                { icon: criarIconeDenuncia(denuncia.tipo) }
            )
                .bindPopup(criarPopupHTML(denuncia), {
                    maxWidth: 280,
                    className: 'popup-voz-animal'
                });

            marcador.on('popupopen', () => {
                if (window.lucide) lucide.createIcons();
            });
            camadaMarcadores.addLayer(marcador);
            marcadores.push(marcador);
            denunciasRenderizadas.push(denuncia);
            idsRenderizados.add(String(denuncia.id));
            return marcador;
        }

        denuncias.forEach(denuncia => {
            adicionarDenunciaAoMapa(denuncia);
        });

        window.__vozAnimalMapa = {
            adicionarDenuncia: (denuncia) => {
                const marcador = adicionarDenunciaAoMapa(denuncia);
                if (!marcador) return;
                if (!denunciasIndicadores.some(item => String(item.id) === String(denuncia.id))) {
                    denunciasIndicadores.unshift(denuncia);
                    atualizarIndicadoresDenuncias();
                }
                const grupo = L.featureGroup(marcadores);
                mapaDenuncias.fitBounds(grupo.getBounds().pad(0.2));
                marcador.openPopup();
            }
        };

        // Ajusta o mapa para mostrar TODOS os marcadores
        if (marcadores.length > 0) {
            const grupo = L.featureGroup(marcadores);
            mapaDenuncias.fitBounds(grupo.getBounds().pad(0.2));
        }

        // Renderiza novamente ícones Lucide (para os pins customizados do mapa)
        if (window.lucide) lucide.createIcons();

        atualizarIndicadoresDenuncias();
    }
});

