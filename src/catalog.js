const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const haircutNames = new Set([
  'corte', 'cabelo', 'corte cabelo', 'corte de cabelo', 'corte masculino',
  'corte de cabelo masculino', 'corte masculino de cabelo',
]);

export function serviceMatchKey(name) {
  const normalized = normalize(name);
  return haircutNames.has(normalized.replace(/\bcore\b/g, 'corte'))
    ? 'generic:haircut'
    : `exact:${normalized}`;
}

// Descoberta de modalidades é mais ampla que equivalência para agendar.
// Um corte na tesoura aparece na vitrine, mas nunca vira corte comum na agenda.
function isHaircutOption(name) {
  const normalized = normalize(name);
  return /\b(?:corte|core)\b/.test(normalized)
    || /^(?:degrade|fade|navalhado|tesoura)(?:\s|$)/.test(normalized);
}

// Enriquece a leitura da IA; não altera nomes, preços, IDs ou o catálogo do site.
// Lista explícita evita confundir corte com coloração, combos e modalidades especiais.
export function enrichCatalog(catalog) {
  const options = [];
  const modalities = [];
  for (const barber of catalog.barbeiros ?? []) {
    for (const service of barber.servicos ?? []) {
      const original = normalize(service.nome);
      const corrected = original.replace(/\bcore\b/g, 'corte');
      const option = {
        barbeiro_id: barber.id, barbeiro: barber.nome,
        servico_id: service.id, servico: service.nome,
        preco: service.preco, duracao_minutos: service.duracao_minutos,
        possivel_erro_de_digitacao: corrected !== original,
      };
      if (haircutNames.has(corrected)) options.push(option);
      if (haircutNames.has(corrected) || isHaircutOption(service.nome)) modalities.push(option);
    }
  }
  return {
    ...catalog,
    comparacao_cortes: {
      intencao: 'corte de cabelo',
      orientacao: 'Somente equivalências de corte comum para agendar, com IDs próprios. Esta lista NÃO contém todos os cortes. Para perguntas sobre cortes, tipos, opções ou preços, use modalidades_cortes ou listar_cortes; inclua tesoura e outras modalidades cadastradas, sem substituir pelo corte comum. Core pode ser erro de digitação de corte.',
      opcoes: options,
    },
    modalidades_cortes: {
      orientacao: 'Todos os cortes identificados no catálogo, incluindo modalidades e combos com corte, mantendo nome, preço, duração e IDs próprios. Apresente cada modalidade separadamente; nunca some ou iguale preços entre profissionais. O catálogo completo continua disponível para serviços sem um nome de corte reconhecível.',
      opcoes: modalities,
    },
  };
}

const clean = value => String(value ?? '').replace(/[\r\n\x00-\x1f*`_~]/g, ' ').trim().slice(0, 120);
const money = value => {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) return 'valor não informado';
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

export function haircutListReply(catalog, barberId = null) {
  const source = enrichCatalog(catalog);
  const groups = new Map();
  for (const option of source.modalidades_cortes.opcoes) {
    if (barberId !== null && option.barbeiro_id !== barberId) continue;
    const key = serviceMatchKey(option.servico);
    const group = groups.get(key) ?? { name: key === 'generic:haircut' ? 'Corte de cabelo' : clean(option.servico), options: [] };
    group.options.push(`${clean(option.barbeiro)} fica ${money(option.preco)} 💈`);
    groups.set(key, group);
  }
  if (!groups.size) return 'Não encontrei cortes cadastrados nessa consulta. Quer conferir outro serviço? 💈';
  return [...groups.values()].map(group => `${group.name}:\n\n${group.options.join('\n')}`).join('\n\n') + '\n\n👊💈';
}

export function barberListReply(catalog) {
  const barbers = catalog.barbeiros ?? [];
  if (!barbers.length) return 'Não encontrei barbeiros cadastrados nessa consulta. Tenta de novo em instantes. 💈';
  return `Temos estes barbeiros:\n\n${barbers.map(barber => `${clean(barber.nome)} 💈`).join('\n')}\n\nCom quem você prefere? 💈`;
}

// A lista geral usa todos os serviços retornados pelo site, sem classificação por nome.
export function serviceListReply(catalog, barberId = null) {
  const blocks = [];
  for (const barber of catalog.barbeiros ?? []) {
    if (barberId !== null && barber.id !== barberId) continue;
    const services = barber.servicos ?? [];
    if (!services.length) continue;
    blocks.push(`Serviços com ${clean(barber.nome)} 💈\n\n${services.map(service => `${clean(service.nome)} — ${money(service.preco)}`).join('\n')}`);
  }
  return blocks.length ? `${blocks.join('\n\n')}\n\nQual você quer marcar? 👊💈`
    : 'Não encontrei serviços cadastrados nessa consulta. Quer conferir outro profissional? 💈';
}
