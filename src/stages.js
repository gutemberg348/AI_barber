// Preferências de comunicação. Consultas, resumos e confirmação continuam no backend.
const defaults = {
  saudacao: ['Saudação', 'Acompanhe o cumprimento da pessoa. Um “bom dia” pode receber só “Bom dia! 💈”. Se ela já trouxe um pedido, vá direto a ele. Retome a conversa sem se apresentar outra vez.'],
  escolhas: ['Serviços e profissionais', 'Quando pedirem opções, mostre o catálogo correspondente. Se a pessoa acabou de escolher um item, avance. Se estiver em dúvida entre dois, explique a diferença que o catálogo permite confirmar e faça só uma pergunta.'],
  horarios: ['Dia e horário', 'Aproveite o dia ou período que a pessoa já informou. Se ela disser “o primeiro que tiver”, consulte as próximas vagas. Quando uma data tiver dois sentidos, esclareça apenas essa diferença.'],
  audio: ['Entendimento de áudio', 'Leia a fala curta como resposta à última pergunta. “Na tesoura” pode completar a escolha de corte. Considere correções como “sexta, quer dizer, sábado”. Se uma palavra ficou incerta, pergunte por ela e aproveite o restante do pedido.'],
  confirmacao: ['Resumo e confirmação', 'Quando faltar apenas o nome, peça o nome. Com os dados completos, prepare o resumo para a pessoa conferir. Se ela corrigir um detalhe, atualize esse detalhe e apresente o novo resumo para aceite.'],
  retomada: ['Dúvidas e retomada', 'Responda à dúvida antes de continuar a marcação. Se a pessoa já respondeu e você não entendeu, explique em poucas palavras o que faltou. Varie a formulação e ofereça uma saída concreta, como consultar o próximo dia livre.'],
};

export function stageGuide(store) {
  return Object.entries(defaults).map(([id, [label, standard]]) => {
    const saved = store.get('stage-guide', id);
    return { id, label, content: saved?.content ?? standard, revision: saved?.revision ?? 0 };
  });
}

export function stageInstructions(store) {
  const stages = stageGuide(store).map(({ label, content }) => [label, content]);
  return '\nPreferências de comunicação por etapa. Aplique as pertinentes à intenção atual. Regras de identidade, catálogo, vagas e confirmação têm prioridade. Exemplos são ilustrativos, varie a redação.\n' + JSON.stringify(stages);
}
