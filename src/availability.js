import { ApiError } from './barbershop.js';

const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function availableTimes(day) {
  if (!Array.isArray(day?.horarios) || day.horarios.some(slot => !timePattern.test(slot?.hora))) {
    throw new ApiError('resposta_invalida', 502);
  }
  return [...new Set(day.horarios.map(slot => slot.hora))].sort();
}

export function availabilityDays(result) {
  if (!Array.isArray(result?.dias) || result.dias.some(day => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day?.data)) return true;
    const parsed = new Date(`${day.data}T12:00:00Z`);
    return !Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== day.data;
  })) throw new ApiError('resposta_invalida', 502);
  return result.dias;
}

export async function readDayAvailability(api, { barbeiro_id, servicos, data }) {
  const result = await api.request('disponibilidade', { barbeiro_id, servicos, data_inicio: data, data_fim: data });
  const day = availabilityDays(result).find(item => item?.data === data);
  // Dia ausente/resposta corrompida é erro, nunca confirmação de agenda lotada.
  return availableTimes(day);
}
