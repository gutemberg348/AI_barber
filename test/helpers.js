import pino from 'pino';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';

export const logger = pino({ level: 'silent' });
export function config(extra = {}) {
  return loadConfig({ NODE_ENV: 'test', ADMIN_API_TOKEN: 'a'.repeat(64), DATA_ENCRYPTION_KEY: 'b'.repeat(64), BARBEARIA_API_TOKEN: 'c'.repeat(64), ...extra });
}
export function memoryStore() { return new Store(':memory:', 'b'.repeat(64)); }
export async function prepareAndPresent(booking, name, args, phone) {
  const result = await booking.tool(name, args, phone);
  if (result.directReply) booking.markSummaryDelivered(phone, result.directReply);
  return result;
}
export const phone = '11999991234';
export const bookingArgs = { nome: 'Cliente Teste', barbeiro_id: 1, servicos: [2], data: '2099-10-24', hora: '09:00' };
export const catalog = { sucesso: true, timezone: 'America/Sao_Paulo', barbeiros: [{ id: 1, nome: 'Julio', servicos: [{ id: 2, nome: 'Corte', preco: '30.00', duracao_minutos: 30 }] }] };
export function fakeApi() {
  const calls = [];
  return {
    calls,
    async request(action, body, key) {
      calls.push({ action, body, key });
      if (action === 'catalogo') return catalog;
      if (action === 'disponibilidade') return { sucesso: true, dias: [{ data: bookingArgs.data, horarios: [{ hora: '09:00' }] }] };
      if (action === 'agendamentos') return { sucesso: true, agendamentos: [{ id: 123, barbeiro: 'Julio', status: 'pendente', data: bookingArgs.data, hora: '09:00' }], tem_mais: false };
      return { sucesso: true, agendamento: { id: 123, barbeiro: 'Julio', data: bookingArgs.data, hora: '09:00', valor_total: '30.00', status: action === 'cancelar' ? 'cancelado' : 'pendente' } };
    },
  };
}
export async function idle(processor) {
  const deadline = Date.now() + 3000;
  while (processor.active || processor.queue.length) {
    if (Date.now() > deadline) throw new Error('Fila não finalizou');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
