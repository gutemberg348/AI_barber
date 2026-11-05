import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './barbershop.js';
import { enrichCatalog, haircutListReply, serviceListReply, barberListReply } from './catalog.js';
import { scheduleReply } from './schedule.js';
import { readDayAvailability } from './availability.js';
import { visitReply } from './visits.js';

const id = z.number().int().positive();
const services = z.array(id).min(1).max(20).refine(a => new Set(a).size === a.length);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value;
});
export const schemas = {
  catalogo: z.strictObject({}),
  listar_barbeiros: z.strictObject({}),
  listar_cortes: z.strictObject({ barbeiro_id: id.nullable() }),
  listar_servicos: z.strictObject({ barbeiro_id: id.nullable() }),
  disponibilidade: z.strictObject({ barbeiro_id: id, servicos: services, data_inicio: date.nullable(), data_fim: date.nullable() }),
  grade_horarios: z.strictObject({ barbeiro_id: id, servicos: services, data: date.nullable(), comparar_barbeiros: z.boolean().default(false) }),
  conferir_horario: z.strictObject({ barbeiro_id: id, servicos: services, data: date, hora: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }),
  agendamentos: z.strictObject({ pagina: z.number().int().min(1).max(1000) }),
  orientar_visita: z.strictObject({ data: date.nullable(), hora: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable() }),
  conferir_agendamento: z.strictObject({ data: date.nullable(), hora: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable() }),
  preparar_agendamento: z.strictObject({ nome: z.string().trim().min(2).max(100), barbeiro_id: id, servicos: services, data: date, hora: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }),
  preparar_cancelamento: z.strictObject({ agendamento_id: id }),
};

export function localTime(timeZone, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function apiFailure(error) {
  const messages = {
    horario_indisponivel: 'Esse horário ficou indisponível. Vamos escolher outro?',
    cancelamento_nao_permitido: 'Essa reserva só pode ser tratada com a equipe pelo site.',
    nao_encontrado: 'Não achei essa reserva no seu WhatsApp. Quer consultar seus agendamentos?',
    dados_invalidos: 'O site não aceitou esses dados. Vamos conferir?',
    periodo_invalido: 'Essa data está fora da agenda liberada. Qual outro dia?',
  };
  return messages[error.code] ?? 'Não consegui consultar o site agora. Tenta de novo em instantes.';
}

const clean = value => String(value ?? '').replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 120);
const money = value => Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export class BookingService {
  constructor({ store, api, config, logger }) { Object.assign(this, { store, api, config, logger }); }
  async tool(name, raw, phone) {
    if (!Object.hasOwn(schemas, name)) throw new ApiError('ferramenta_invalida');
    const args = schemas[name].parse(raw);
    if (name === 'catalogo') return enrichCatalog(await this.api.request('catalogo'));
    if (name === 'listar_barbeiros') {
      const catalog = await this.api.request('catalogo');
      return { directReply: barberListReply(catalog), catalog: enrichCatalog(catalog) };
    }
    if (['listar_cortes', 'listar_servicos'].includes(name)) {
      const catalog = await this.api.request('catalogo');
      if (args.barbeiro_id !== null && !catalog.barbeiros?.some(barber => barber.id === args.barbeiro_id)) throw new ApiError('dados_invalidos', 422);
      const format = name === 'listar_servicos' ? serviceListReply : haircutListReply;
      return { directReply: format(catalog, args.barbeiro_id), catalog: enrichCatalog(catalog) };
    }
    if (name === 'disponibilidade') return this.api.request('disponibilidade', args);
    if (name === 'grade_horarios') return scheduleReply(this.api, args);
    if (name === 'agendamentos') return this.api.request('agendamentos', { telefone: phone, ...args });
    if (['orientar_visita', 'conferir_agendamento'].includes(name)) return visitReply(this.api, phone, args, localTime(this.config.BARBEARIA_TIMEZONE), this.store.get('pending', phone)?.state === 'executing', name === 'conferir_agendamento');
    // Uma operação cujo resultado é incerto bloqueia outra até recuperar o resultado.
    const previous = this.store.get('pending', phone);
    if (previous?.state === 'executing' && ['preparar_agendamento', 'preparar_cancelamento'].includes(name)) return { directReply: this.retryText(previous) };
    let action, payload, summary;
    if (['preparar_agendamento', 'conferir_horario'].includes(name)) {
      const catalog = await this.api.request('catalogo');
      const barber = catalog.barbeiros?.find(b => b.id === args.barbeiro_id);
      const selected = args.servicos.map(s => barber?.servicos?.find(v => v.id === s));
      if (!barber || selected.some(s => !s)) throw new ApiError('dados_invalidos', 422);
      let available;
      try { available = await readDayAvailability(this.api, args); }
      catch (error) {
        if (error.code !== 'periodo_invalido') throw error;
        if (name === 'conferir_horario' && previous?.state === 'executing') return scheduleReply(this.api, args);
        const metadata = {};
        const directReply = await this.refreshUnavailable(args, phone, metadata, error.code);
        return { directReply, ...metadata };
      }
      if (!available.includes(args.hora)) {
        if (name === 'conferir_horario' && previous?.state === 'executing') return scheduleReply(this.api, args);
        const metadata = {};
        const directReply = await this.refreshUnavailable(args, phone, metadata);
        return { directReply, ...metadata };
      }
      if (name === 'conferir_horario') {
        return { sucesso: true, disponivel: true, horario_consultado: args, barbeiro: barber.nome };
      }
      action = 'agendar';
      payload = { ...args, telefone: phone };
      const total = selected.reduce((sum, s) => sum + Math.round(Number(s.preco) * 100), 0) / 100;
      summary = `Confere pra mim: ✂️\n${clean(args.nome)} · ${clean(barber.nome)}\n${selected.map(s => clean(s.nome)).join(' + ')} · ${money(total)} (avulso)\n${args.data.split('-').reverse().join('/')} às ${args.hora} · horário da barbearia\nAinda não reservado.`;
    } else {
      let appointment;
      for (let page = 1; page <= 20; page++) {
        const data = await this.api.request('agendamentos', { telefone: phone, pagina: page });
        appointment = data.agendamentos?.find(a => a.id === args.agendamento_id);
        if (appointment || !data.tem_mais) break;
      }
      if (!appointment) throw new ApiError('nao_encontrado', 404);
      if (appointment.status !== 'pendente' || `${appointment.data} ${appointment.hora}` <= localTime(this.config.BARBEARIA_TIMEZONE)) {
        throw new ApiError('cancelamento_nao_permitido', 409);
      }
      action = 'cancelar';
      payload = { agendamento_id: args.agendamento_id, telefone: phone };
      summary = `Cancelar a reserva #${appointment.id}?\n${clean(appointment.barbeiro)} · ${clean(appointment.data)} às ${clean(appointment.hora)}\nAinda não cancelada.`;
    }
    const operation = {
      id: randomUUID(), code: randomBytes(3).toString('hex').toUpperCase(), action, payload, summary,
      state: 'prepared', createdAt: Date.now(), expiresAt: Date.now() + 15 * 60000,
    };
    this.store.set('pending', phone, operation);
    return { directReply: this.confirmationText(operation) };
  }
  confirmationText(op) {
    return `${op.summary}\n\nPosso confirmar? Responda SIM ou CONFIRMAR.\nPara descartar, responda NÃO. 💈`;
  }
  markSummaryDelivered(phone, reply) {
    const op = this.store.get('pending', phone);
    if (op?.state !== 'prepared' || reply !== this.confirmationText(op)) return;
    op.confirmationShownAt = Date.now();
    this.store.set('pending', phone, op);
  }
  retryText(op) {
    // O erro salvo pode ser anterior à correção do site. Mostre o pedido original
    // sem afirmar que continua falhando ou que a operação não chegou a ser gravada.
    const details = typeof op.summary === 'string'
      ? op.summary.replace(/^Confere pra mim: ✂️\n/, '').replace(/\nAinda não (?:reservado|cancelada)\.$/, '')
      : '';
    return `Pedido anterior aguardando resultado.${details ? `\n\n${details}` : ''}\n\nAinda não recebi o resultado desse pedido. Posso tentar confirmar esse mesmo pedido? Responda SIM ou CONFIRMAR.\nPreciso resolver esse pedido antes de criar ou cancelar outro. Você pode continuar vendo serviços e horários. 💈`;
  }
  async refreshUnavailable(args, phone, metadata = {}, reason = 'horario_indisponivel') {
    this.store.delete('pending', phone);
    try {
      const updated = await scheduleReply(this.api, args);
      metadata.scheduleQuery = updated.scheduleQuery;
      metadata.scheduleNotice = 'O pedido anterior não foi reservado.';
      if (reason === 'periodo_invalido') return updated.directReply;
      return `Esse horário ficou indisponível.\n\n${updated.directReply}`;
    } catch {
      if (reason === 'periodo_invalido') return 'Esse dia está fora da agenda liberada. Não consegui consultar as próximas vagas agora. Tenta de novo em instantes.';
      return 'Esse horário ficou indisponível. Não consegui atualizar as vagas agora. Tenta de novo em instantes.';
    }
  }
  async command(text, phone, metadata = {}) {
    const command = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase().replace(/[.!?]+$/, '').trim().replace(/\s+/g, ' ');
    const op = this.store.get('pending', phone);
    const yes = ['SIM', 'CONFIRMAR', 'CONFIRMO', 'PODE CONFIRMAR', 'PODE MARCAR', 'PODE AGENDAR', 'SIM PODE CONFIRMAR', 'SIM PODE MARCAR', 'SIM PODE AGENDAR'].includes(command);
    if (command === 'DESISTIR' || (op && ['NAO', 'NAO CONFIRMAR', 'NAO QUERO'].includes(command))) {
      if (op?.state === 'executing') return this.retryText(op);
      this.store.delete('pending', phone);
      return 'Pedido descartado. Suas reservas não foram alteradas. 👊';
    }
    if (!yes && !/^CONFIRMAR(?:\s|$)/.test(command)) return null;
    if (!op && yes && command !== 'CONFIRMAR') return null;
    if (!op) return 'Não há pedido para confirmar. O que deseja agendar?';
    if (!yes && command !== `CONFIRMAR ${op.code}`) return 'Para confirmar esse pedido, responda SIM ou CONFIRMAR.';
    if (op.state === 'completed') return op.reply;
    if (op.state === 'prepared' && op.expiresAt < Date.now()) {
      this.store.delete('pending', phone);
      return 'A confirmação expirou. Vamos consultar os horários de novo?';
    }
    // Nenhum aceite, nem CONFIRMAR, pode pular o envio do resumo dessa operação.
    if (op.state === 'prepared' && (!op.confirmationShownAt || (metadata.receivedAt && metadata.receivedAt <= op.confirmationShownAt))) return this.confirmationText(op);
    // Após outra pergunta, um aceite não pode confirmar silenciosamente o resumo antigo.
    const history = this.store.get('history', phone);
    const lastReply = history?.messages?.findLast(item => item.role === 'assistant')?.content;
    if (op.state === 'prepared' && lastReply && lastReply !== this.confirmationText(op)) return this.confirmationText(op);
    if (op.retryAt > Date.now()) return `Aguarde ${Math.ceil((op.retryAt - Date.now()) / 1000)} segundos e responda CONFIRMAR para conferir novamente.`;
    const recovering = op.state === 'executing';
    if (!recovering && op.action === 'agendar') {
      // Uma nova leitura reduz conflitos; só o POST do site garante a reserva.
      // Na recuperação, a própria reserva pode ter ocupado a vaga: repetir o POST original.
      let available;
      try { available = await readDayAvailability(this.api, op.payload); }
      catch (error) {
        if (error.code === 'periodo_invalido') return this.refreshUnavailable(op.payload, phone, metadata, error.code);
        return 'Não consegui conferir a vaga. Responda CONFIRMAR para tentar novamente em instantes.';
      }
      if (!available.includes(op.payload.hora)) return this.refreshUnavailable(op.payload, phone, metadata);
    }
    op.state = 'executing';
    op.confirmedAt ??= Date.now();
    // Persistir antes do POST: inclusive após reinício, repetir exatamente chave e corpo.
    this.store.set('pending', phone, op);
    try {
      const result = await this.api.request(op.action, op.payload, op.id);
      if (!Number.isInteger(result.agendamento?.id) || (op.action === 'cancelar' && result.agendamento.status !== 'cancelado')) throw new ApiError('resposta_invalida', 502, true);
      const appointment = result.agendamento;
      const message = op.action === 'cancelar'
        ? `Cancelamento registrado para a reserva #${appointment.id}. ✅ Tamo junto!`
        : `Reserva #${appointment.id} registrada! ✅\n${clean(appointment.barbeiro)} · ${clean(appointment.data)} às ${clean(appointment.hora)}\n${money(appointment.valor_total)} · ${clean(appointment.status)}\nTamo junto!`;
      // Mantém o resultado junto à confirmação até o chamador persistir a resposta.
      op.state = 'completed'; op.result = result; op.reply = message;
      this.store.set('pending', phone, op);
      return message;
    } catch (error) {
      op.lastError = {
        code: error instanceof ApiError && typeof error.code === 'string' && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'falha_operacao',
        status: error instanceof ApiError && Number.isInteger(error.status) && error.status >= 0 && error.status <= 599 ? error.status : 0,
        uncertain: !(error instanceof ApiError) || error.uncertain || recovering,
        at: Date.now(),
      };
      this.logger?.warn({ event: 'booking_failed', action: op.action, apiCode: op.lastError.code, httpStatus: op.lastError.status, uncertain: op.lastError.uncertain }, 'Site não confirmou a operação');
      if (!(error instanceof ApiError) || error.uncertain || recovering) {
        op.retryAt = Date.now() + (error.retryAfterMs ?? 0);
        this.store.set('pending', phone, op);
        return this.retryText(op);
      }
      this.store.delete('pending', phone);
      if (op.action === 'agendar' && ['horario_indisponivel', 'periodo_invalido'].includes(error.code)) {
        return this.refreshUnavailable(op.payload, phone, metadata, error.code);
      }
      return apiFailure(error);
    }
  }
}
