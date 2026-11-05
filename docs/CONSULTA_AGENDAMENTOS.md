# Reserva do site não encontrada pelo bot

Na verificação de 05/11/2026, a API autenticada do site retornou a reserva das 12:45 mencionada pelo cliente nas imagens. Ela estava pendente, com término às 14:15. A consulta com o celular completo encontrou uma reserva; a versão sem o nono dígito não encontrou nenhuma. A leitura não criou, alterou, cancelou ou reenviou agendamento.

Isso demonstra uma diferença entre as duas buscas do site, compatível com a hipótese de o canal ter identificado o celular sem o nono dígito. Sem os metadados da mensagem original da VPS, não se afirma que essa foi a única causa do incidente. O código também permitia que a frase sobre reserva existente fosse interpretada pela IA como uma pergunta de visita, resultando numa orientação inadequada para marcar novamente.

## Correção no Node

- `BarbershopApi.request('agendamentos')` consulta a API do site com as duas formas compatíveis de celular brasileiro, preservando o DDD. Une os resultados, remove IDs duplicados e mantém a paginação. Telefones fixos não recebem um 9 por tentativa. Números escritos nas mensagens não controlam essa consulta; o telefone continua vindo do remetente autenticado.
- Perguntas sobre uma reserva existente usam `conferir_agendamento`, que faz nova consulta ao site e responde com dia, hora e profissional. Não depende de reservas criadas via WhatsApp ou do histórico da conversa.
- Se a reserva não aparecer, o bot esclarece a divergência e orienta conferir “Meus horários”, em vez de mandar marcar novamente. Falha em qualquer consulta de formato é falha de leitura, não ausência de reserva.
- Somente leituras de agendamentos recebem a compatibilidade de telefone. Corpos/chaves de POSTs, operações incertas e dados já persistidos não são reescritos.

A API PHP de referência compara o telefone normalizado de forma exata (com e sem DDI), sem unificar o nono dígito. Esta correção funciona no cliente Node sem precisar atualizar o PHP. Para problemas futuros, conferir se a reserva pertence ao mesmo número autenticado, se ainda está ativa e se a VPS executa a versão atual do bot. Não listar reservas de todos os clientes como alternativa.

## Atualizar a VPS

Depois de enviar os commits pelo Git:

```sh
cd /var/www/ia_barber/AI_barber
git pull --ff-only origin main
docker compose -p luna-ia -f compose.yaml up -d --build luna
```

Teste com o próprio cliente perguntando novamente pelo agendamento. Não é necessário recriar a reserva nem reiniciar sua conversa. A confirmação real continua dependendo do resultado atual da API.

Referência sobre o formato de celular: [Anatel — nono dígito](https://www.gov.br/anatel/pt-br/regulado/numeracao/codigos-nacionais/nono-digito).
