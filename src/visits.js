import { z } from 'zod';
import { ApiError } from './barbershop.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
});
const hour = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const pageSchema = z.object({
  agendamentos: z.array(z.object({
    id: z.number().int().positive(), barbeiro: z.string().min(1),
    data: day, hora: hour, hora_fim: hour.optional(),
    status: z.enum(['pendente', 'cancelado', 'concluido']),
  })),
  tem_mais: z.boolean(),
});
const clean = value => value.replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 120);
const label = appointment => `${appointment.data.split('-').reverse().join('/')} às ${appointment.hora} · ${clean(appointment.barbeiro)}`;

// Só leitura do remetente autenticado. Um pedido local não é uma reserva.
export async function visitReply(api, phone, query, currentTime, uncertain = false) {
  const appointments = [];
  for (let page = 1; page <= 20; page++) {
    const parsed = pageSchema.safeParse(await api.request('agendamentos', { telefone: phone, pagina: page }));
    if (!parsed.success) throw new ApiError('resposta_invalida', 502);
    appointments.push(...parsed.data.agendamentos);
    if (!parsed.data.tem_mais) break;
    if (page === 20) throw new ApiError('consulta_incompleta', 502);
  }
  const active = appointments.filter(item => item.status === 'pendente'
    && `${item.data} ${item.hora_fim ?? item.hora}` >= currentTime)
    .sort((a, b) => `${a.data} ${a.hora}`.localeCompare(`${b.data} ${b.hora}`));
  const match = active.find(item => (!query.data || item.data === query.data) && (!query.hora || item.hora === query.hora));
  if (match) return { directReply: `Você já tem horário marcado! 👊\n${label(match)}\nTe esperamos no dia e horário marcados. 💈` };
  const period = query.data ? ` para ${query.data.split('-').reverse().join('/')}${query.hora ? ` às ${query.hora}` : ''}`
    : query.hora ? ` às ${query.hora}` : ' no seu WhatsApp';
  const noBooking = `Não encontrei horário marcado${period}.`;
  if (uncertain) return { directReply: `${noBooking}\nSeu pedido anterior ainda aguarda resultado. Responda CONFIRMAR para conferir esse pedido. 💈` };
  const next = active[0];
  return { directReply: next
    ? `${noBooking}\nVocê tem reserva em ${label(next)}.\nPara ir em outro horário, precisa agendar. Quer marcar? 💈`
    : `${noBooking}\nPrecisa agendar antes de ir. Quer marcar? 💈` };
}
