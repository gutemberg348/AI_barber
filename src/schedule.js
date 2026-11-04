import { ApiError } from './barbershop.js';
import { serviceMatchKey } from './catalog.js';
import { availableTimes as slots, availabilityDays as days, readDayAvailability } from './availability.js';

const label = value => String(value ?? '').replace(/[\r\n\x00-\x1f*`_~]/g, ' ').slice(0, 100);
const dayLabel = date => date.split('-').reverse().join('/');
const price = services => (services.reduce((total, s) => total + Math.round(Number(s.preco) * 100), 0) / 100)
  .toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function timeGrid(times) {
  return times.join('\n');
}

// Só compara combinações sem ambiguidade. IDs e preços permanecem de cada barbeiro.
function equivalentServices(barber, requested) {
  const selected = requested.map(service => {
    const matches = barber.servicos.filter(s => serviceMatchKey(s.nome) === serviceMatchKey(service.nome));
    return matches.length === 1 ? matches[0] : null;
  });
  if (selected.some(s => !s) || new Set(selected.map(s => s.id)).size !== requested.length) return null;
  return selected;
}

export async function scheduleReply(api, args) {
  const scheduleQuery = { barbeiro_id: args.barbeiro_id, servicos: [...args.servicos], data: args.data };
  if (args.comparar_barbeiros) scheduleQuery.comparar_barbeiros = true;
  const catalog = await api.request('catalogo');
  const barber = catalog.barbeiros?.find(b => b.id === args.barbeiro_id);
  const selected = args.servicos.map(id => barber?.servicos?.find(s => s.id === id));
  if (!barber || selected.some(s => !s)) throw new ApiError('dados_invalidos', 422);
  const chosen = { barber, services: selected };
  const others = (catalog.barbeiros ?? []).filter(other => other.id !== barber.id)
    .map(other => ({ barber: other, services: equivalentServices(other, selected) }))
    .filter(other => other.services);
  const compare = args.comparar_barbeiros === true;
  let failedLookup = false;
  let outsideWindow = Boolean(args.data && catalog.janela?.inicio && catalog.janela?.fim
    && (args.data < catalog.janela.inicio || args.data > catalog.janela.fim));
  const blocks = [];
  const params = option => ({ barbeiro_id: option.barber.id, servicos: option.services.map(s => s.id) });
  const block = (option, data, times) => `${label(option.barber.nome)} — ${price(option.services)}\n📅 ${dayLabel(data)}\n\n${timeGrid(times)}`;
  const result = heading => {
    const sections = [heading, ...blocks];
    if (failedLookup) sections.push('Não consegui conferir todas as opções.');
    if (blocks.length) {
      sections.push(blocks.length === 1 ? 'Qual horário? 💈👊' : 'Qual opção fica melhor? 💈👊');
      sections.push('Vagas sujeitas à confirmação.');
    } else if (failedLookup) sections.push('Tento de novo?');
    else sections.push('Sem alternativas livres na agenda liberada. Quer consultar mais tarde?');
    return { scheduleQuery, directReply: sections.join('\n\n') };
  };
  // Leituras independentes; falha em um profissional não esconde vagas dos demais.
  const lookup = async (options, read) => {
    const responses = await Promise.allSettled(options.map(read));
    return responses.flatMap((response, index) => {
      if (response.status === 'rejected') { failedLookup = true; return []; }
      return response.value ? [{ option: options[index], ...response.value }] : [];
    });
  };
  const nextAvailable = async option => {
    const response = await api.request('disponibilidade', params(option));
    // Valida toda a leitura antes de concluir que não existe uma próxima vaga.
    const valid = days(response).map(day => ({ data: day.data, times: slots(day) }));
    const after = outsideWindow ? null : args.data;
    return valid.filter(day => (!after || day.data > after) && day.times.length)
      .sort((a, b) => a.data.localeCompare(b.data))[0] ?? null;
  };

  if (args.data && !outsideWindow) {
    let available = [];
    try { available = await readDayAvailability(api, args); }
    catch (error) {
      if (error.code === 'periodo_invalido') outsideWindow = true;
      else if (compare) failedLookup = true;
      else throw error;
    }
    if (!outsideWindow) {
      if (available.length) {
        blocks.push(block(chosen, args.data, available));
        if (!compare) return result(`Horários com ${label(barber.nome)}:`);
      }
      const alternatives = await lookup(others, async option => {
        const times = await readDayAvailability(api, { ...params(option), data: args.data });
        return times.length ? { data: args.data, times } : null;
      });
      for (const alternative of alternatives) blocks.push(block(alternative.option, alternative.data, alternative.times));
      if (compare && blocks.length) return result('Horários disponíveis:');
    }
  }

  const next = await lookup(compare ? [chosen, ...others] : [chosen], nextAvailable);
  for (const option of next) blocks.push(block(option.option, option.data, option.times));
  // Sem opção do escolhido nem no mesmo dia: procure próximos dias dos demais.
  if (!compare && !blocks.length) {
    const alternatives = await lookup(others, nextAvailable);
    for (const alternative of alternatives) blocks.push(block(alternative.option, alternative.data, alternative.times));
  }

  if (outsideWindow) {
    const window = catalog.janela?.inicio && catalog.janela?.fim
      ? ` A agenda vai de ${dayLabel(catalog.janela.inicio)} a ${dayLabel(catalog.janela.fim)}.` : '';
    return result(`${dayLabel(args.data)} está fora da agenda liberada.${window}${blocks.length ? '\nEstas são as próximas opções:' : ''}`);
  }
  if (!args.data) return result('Próximos horários disponíveis:');
  const heading = compare
    ? (failedLookup ? `Não consegui conferir todas as vagas em ${dayLabel(args.data)}.` : `Sem vagas em ${dayLabel(args.data)}.`)
    : `${label(barber.nome)} está sem vagas em ${dayLabel(args.data)}.`;
  return result(`${heading}${blocks.length ? '\nTenho estas opções:' : ''}`);
}
