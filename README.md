# Luna — WhatsApp da barbearia

Backend Node.js com Baileys e OpenAI Responses API. A Luna consulta o site da barbearia, apresenta serviços e horários, prepara agendamentos/cancelamentos e só grava após confirmação explícita do cliente no WhatsApp.

**Painel Luna Studio:** após iniciar/reiniciar o Node, abra [http://localhost:3000/painel](http://localhost:3000/painel) e entre com `ADMIN_API_TOKEN`. Painel responsivo com QR Code, status, ativação/pausa, ensinamentos editáveis e verificação da integração. Os ensinamentos são persistidos e aplicados sem reiniciar. [Acesso online e instruções do painel](docs/PAINEL.md).

Implementa o contrato existente em [docs/API_IA.md](docs/API_IA.md) e [docs/openapi-ia.json](docs/openapi-ia.json). A agenda e seus preços continuam no site. O SQLite deste serviço guarda sessão WhatsApp, histórico curto, confirmações e respostas pendentes.

## Iniciar

Requer Node.js **22.13 ou superior** e npm. Nessa versão do Node, `node:sqlite` emite aviso de funcionalidade experimental. Não precisa instalar MySQL para este backend.

```sh
npm ci
npm run setup
```

Edite `.env` e preencha:

```dotenv
OPENAI_API_KEY=sua_chave_da_api_openai
BARBEARIA_API_URL=https://goodstyler.com/admin/api_ia.php
BARBEARIA_API_TOKEN=mesmo_token_configurado_no_servidor_php
BARBEARIA_SITE_URL=https://goodstyler.com
```

`npm run setup` gera `ADMIN_API_TOKEN` e `DATA_ENCRYPTION_KEY` aleatórios. Não sobrescreve um `.env` existente e não imprime os segredos. A chave da OpenAI e o token real do site precisam ser fornecidos por você. Não os coloque no frontend ou no Git.

```sh
npm start
```

O serviço inicia em `http://127.0.0.1:3000`. `GET /healthz` confirma que o processo está vivo. Com a configuração inicial abaixo, o WhatsApp conecta automaticamente e exibe o QR Code no próprio terminal, sem depender do painel do site:

```dotenv
WHATSAPP_AUTO_CONNECT=true
WHATSAPP_PRINT_QR=true
```

Execute `npm start` e leia o QR em **WhatsApp → Aparelhos conectados → Conectar um aparelho**. O terminal mostra um novo QR quando ele é renovado. Se a sessão já estiver vinculada, o serviço reconecta sem pedir outro QR. Para conectar somente pelo painel, configure `WHATSAPP_AUTO_CONNECT=false`; para esconder o QR no terminal, configure `WHATSAPP_PRINT_QR=false`. Reinicie após alterar o `.env`.

Para conectar, abra `/painel` e use a seção WhatsApp, ou faça `POST /api/v1/whatsapp/connect` com `Authorization: Bearer <ADMIN_API_TOKEN>`. Depois do pareamento, a sessão é reutilizada. Para conectar automaticamente ao reiniciar, configure `WHATSAPP_AUTO_CONNECT=true`.

## Endpoints para o site

Todos os endpoints abaixo, exceto `/healthz`, exigem autenticação: **ADMIN_API_TOKEN** no cabeçalho Bearer para integrações, ou a sessão autenticada do painel. Esse token é diferente do token da API de agenda. Somente a tela de entrada do painel e seus assets são públicos.

| Método | Endpoint | Resultado |
|---|---|---|
| GET | `/healthz` | Processo vivo, sem consultar dependências |
| GET | `/readyz` | `200` se conectado/configurado/habilitado; senão `503` |
| GET | `/api/v1/whatsapp/status` | Estado, `connected`, `ready`, QR e configuração |
| POST | `/api/v1/whatsapp/connect` | Inicia conexão ou devolve conexão existente |
| GET | `/api/v1/whatsapp/qrcode` | QR bruto, imagem em `qrDataUrl` e validade |
| GET | `/api/v1/whatsapp/qrcode.png` | Imagem PNG do QR atual |
| POST | `/api/v1/whatsapp/disconnect` | Desconecta preservando a sessão |
| POST | `/api/v1/whatsapp/logout` | Desvincula a sessão; exigirá outro QR |
| PUT | `/api/v1/bot` | `{"enabled":false}` pausa novas respostas; `true` reativa |
| GET | `/api/v1/integrations` | Configuração das integrações, sem segredos |
| GET | `/api/v1/integrations/barbershop/check` | Consulta real de catálogo, sem escrever reservas |

Exemplo de status:

```json
{
  "state": "connected",
  "connected": true,
  "qrAvailable": false,
  "botEnabled": true,
  "openaiConfigured": true,
  "barbershopConfigured": true,
  "ready": true,
  "readinessScope": "connection_and_configuration"
}
```

`connected` indica conexão do Baileys com WhatsApp. `ready` acrescenta tokens preenchidos e bot habilitado; **não testa saldo, validade da chave OpenAI ou disponibilidade do site**. Para testar o site, use o endpoint `barbershop/check`. A OpenAI é efetivamente exercitada ao atender uma mensagem. `/healthz` não significa que o WhatsApp está conectado.

QR indisponível/expirado retorna `409`. Consulte status e QR a cada 5 segundos. A resposta usa `Cache-Control: no-store`; esconda o QR assim que conectar ou quando a consulta falhar. Não deixe o QR numa área pública.

Integração PHP pronta para adaptar: [examples/whatsapp-painel.php](examples/whatsapp-painel.php). Instruções: [docs/INTEGRACAO_SITE.md](docs/INTEGRACAO_SITE.md). Contrato dos endpoints Node: [docs/openapi-node.json](docs/openapi-node.json).

## Como a Luna atende

1. Recebe mensagens privadas novas; ignora grupos, status, histórico antigo e mensagens enviadas pelo próprio aparelho.
2. Identifica o telefone brasileiro a partir do WhatsApp. Para LID, usa o identificador alternativo ou mapeamento do Baileys. Sem telefone verificado, orienta usar o site. Nunca utiliza um telefone escolhido pelo modelo.
3. Consulta catálogo, disponibilidade e reservas pelas ferramentas da Responses API. O telefone é injetado pelo backend; tokens não são enviados ao modelo.
4. Prepara um resumo com dados reais e pergunta “Posso confirmar?”. Nome e horário só preparam o pedido, sem gravar no site. O cliente responde `SIM`, `CONFIRMAR`, `confirmo` ou `pode marcar`, sem código. O primeiro POST exige registro de que esse resumo foi enviado com sucesso ao WhatsApp e que o aceite chegou depois; gerar/guardar a mensagem antes do envio não basta. `NÃO` ou `DESISTIR` descarta apenas o pedido ainda não gravado. Confirmações expiram em 15 minutos. Depois de uma pergunta intermediária, qualquer aceite, inclusive `CONFIRMAR`, mostra novamente o resumo antes de confirmar o pedido antigo.
5. Ao receber o aceite, envia o POST com chave de idempotência persistida. Timeout mantém chave/corpo para recuperar o resultado, inclusive após reinício. Enquanto o resultado é incerto, bloqueia nova criação/cancelamento daquele cliente e permite consultas.
6. Registra a resposta antes de enviar ao WhatsApp. Reenvio de resposta não repete a chamada ao modelo ou cria outra reserva.

`/iniciar` começa a conversa do zero para o próprio cliente: limpa o histórico, descarta o pedido ainda não confirmado, remove respostas antigas aguardando envio e retoma uma pausa individual. Responde “Fala, meu irmão! Tudo bem? 💈”, sem chamar a IA nem perguntar o serviço. Não cancela reservas feitas no site, não desconecta o WhatsApp e não apaga dados de outros clientes. Se houver uma operação com resultado incerto após timeout, primeiro será preciso recuperar o resultado respondendo `CONFIRMAR`, sem código; a chave interna dessa operação não é apagada. Perguntas de serviços e horários continuam disponíveis nesse estado. O comando respeita a pausa global do administrador e os limites de mensagens.

Quando o cliente pergunta se pode ir ou diz que está indo, a Luna consulta os agendamentos do próprio WhatsApp no site antes de orientar. Informa a reserva ativa correspondente ao dia/hora pedidos; sem reserva, explica que precisa agendar e oferece iniciar a marcação. Reservas canceladas, concluídas ou passadas não autorizam uma visita. A consulta percorre as páginas, não grava pedidos nem confirma resumos pendentes. Falha de leitura não é tratada como ausência de reserva.

`/parar` pausa o bot para aquele cliente; `/voltar` retoma mantendo o histórico. Atendimento é por texto. Áudio, imagem, vídeo, documento e figurinha recebem orientação para escrever. Não há transferência automática para atendente humano nem compra/uso de planos; esses pedidos são direcionados ao site.

Edite [prompts/luna.md](prompts/luna.md) para mudar o jeito da Luna falar e reinicie. **Não precisa de Prompt ID nem de um GPT pronto**: as instruções são locais, e a aplicação chama a API da OpenAI. O modelo padrão é `gpt-4.1-mini`, alterável em `OPENAI_MODEL` para um modelo compatível com Responses e function calling.

O atendimento usa o tom descontraído da equipe do dono configurado em `BARBEARIA_DONO` (padrão: `Julio`), com expressões como “meu irmão” e emojis. As listas terminam com 💈; na lista de barbeiros, cada nome também termina com 💈. Quando perguntam quem ela é, a Luna se identifica como assistente virtual da equipe. As mensagens de confirmação, cancelamento e falha também seguem esse estilo.

Preços aparecem com um título curto, uma linha por profissional e uma linha em branco antes do fechamento “💈👊”. Nomes e valores vêm do catálogo, na ordem retornada pelo site; não há preços ou quantidade de barbeiros fixos. Se o cliente pediu só preço, a resposta termina na lista. A pergunta sobre preferência de barbeiro aparece quando ele quer marcar.

Um “oi” ou “bom dia” recebe apenas um cumprimento curto; a Luna não puxa serviço ou cobra uma etapa de agendamento só por isso, mesmo com histórico anterior. Ela segue o papo do cliente e entra em serviços quando ele demonstrar interesse. Se receber “oi, quero um corte”, já atende ao pedido; perguntas sobre preços não iniciam automaticamente uma marcação.

O catálogo enviado à IA inclui `comparacao_cortes`, que reúne equivalências do corte comum para agendar, e `modalidades_cortes`, com as demais opções identificadas, incluindo tesoura, degradê e combos com corte quando cadastrados. Cada opção mantém seu próprio ID, preço e duração. A ferramenta `listar_cortes` consulta o catálogo atual e envia um bloco por modalidade, com valores separados por profissional; perguntas amplas sobre cortes e preços incluem as modalidades em vez de mostrar só o corte comum. Pode filtrar por barbeiro. A apresentação mais ampla não altera a equivalência da agenda: escolher tesoura usa o serviço de tesoura daquele profissional, sem substituir pelo comum.

Perguntas gerais como “quais serviços tem?” usam `listar_servicos`, que mostra todos os itens de `barbeiros[].servicos`, um por linha com seu preço, sem filtro de nome ou categoria. Respeita o profissional escolhido na conversa; sem preferência, separa a lista por profissional. `listar_cortes` fica restrita a perguntas específicas sobre cortes. Todo serviço retornado pelo site pode seguir o fluxo de agendamento, incluindo barba, sobrancelha, pezinho, luzes, hidratação e serviços novos. Para vários serviços juntos, o conjunto completo de IDs do mesmo profissional vai para disponibilidade, preparo e gravação; o site determina duração e valores. Listar todos os serviços não autoriza reservar todos.

`listar_barbeiros` consulta o catálogo e mostra todos os profissionais reais, um por linha com 💈, antes de perguntar a preferência. Se o cliente pedir horários sem informar profissional nem serviço, a orientação é mostrar primeiro os barbeiros; após a escolha, mostrar os serviços completos daquele profissional. Não pede barbeiro e serviço juntos nem exige que o cliente adivinhe as opções. Informações já fornecidas são aproveitadas para pular a escolha correspondente.

Se a gravação no site falhar, o Node registra `booking_failed` com status HTTP e código da API, sem telefones ou tokens, e mantém o diagnóstico no pedido incerto. Perguntas de consulta continuam funcionando; nova reserva/cancelamento aguarda a recuperação, usando a mesma chave e corpo. Para conferir o endpoint sem criar reservas, execute `npm run diagnose:site`. O diagnóstico faz GET do catálogo, POST vazio para validação e POST com formato válido e IDs ausentes do catálogo para verificar a entrada na transação. Os dois POSTs devem ser rejeitados com erro de validação/negócio; HTTP 500 indica falha no site. O POST vazio sozinho não verifica banco ou idempotência nas versões que validam antes da conexão. Evidências e instruções para a hospedagem: [CORRIGIR_CONFIRMACAO_SITE.md](docs/CORRIGIR_CONFIRMACAO_SITE.md).

O fluxo pergunta primeiro o dia e usa `grade_horarios` para mostrar os horários reais em linhas separadas, com blocos por profissional e data. A ferramenta recebe `barbeiro_id`, os IDs de `servicos` desse profissional, `data` (`YYYY-MM-DD` ou `null`) e `comparar_barbeiros`. Com `comparar_barbeiros: false`, respeita a preferência de profissional. Se o cliente pedir sugestões sem indicar um dia, `data: null` consulta a janela liberada e mostra o próximo dia com vaga do profissional; se ele não tiver vagas na janela, busca equivalentes com outros barbeiros. Para um dia específico sem vagas, mostra os horários dos outros barbeiros nesse dia e o próximo dia livre do escolhido; se este também não tiver próximos dias livres, busca outros dias dos demais. Datas fora da janela recebem o intervalo liberado e sugestões das primeiras vagas encontradas dentro dele. O cliente escolhe a alternativa antes de marcar. Falha de consulta é informada como falha, sem afirmar agenda lotada.

Quando o cliente aceita “qualquer um”, pergunta “quem tem vaga?” ou pede todos, `comparar_barbeiros: true` consulta todos os profissionais com serviços equivalentes. O profissional e os serviços enviados servem de referência para a comparação; os IDs e preços usados em cada consulta continuam sendo os de cada barbeiro. Para um dia específico sem vagas com ninguém, busca próximos dias reais de todos; com `data: null`, já busca esses próximos dias. A comparação não escolhe nem troca o barbeiro pelo cliente. Depois da escolha, a próxima consulta usa o profissional e os serviços escolhidos, com `comparar_barbeiros: false`.

`grade_horarios` é a única ferramenta de consulta de vagas exposta ao modelo. A ação `disponibilidade` do site continua sendo usada internamente pelo backend. Assim, a resposta de horários mantém o formato e os parâmetros necessários para atualizar a agenda antes de um reenvio. Nas etapas simples, a Luna faz só a pergunta necessária, como “Pra qual dia?” ou “Qual seu nome?”. Explicações, grades e resumos podem ser maiores quando necessário, sem impor um corte de caracteres nem reduzir `OPENAI_MAX_OUTPUT_TOKENS` para encurtar a conversa.

Horários no histórico não são garantia de vaga: as instruções exigem nova consulta antes de informar disponibilidade. As requisições ao site pedem `no-store`/`no-cache`. O backend consulta o horário ao preparar o resumo e antes do primeiro POST de confirmação. Se a vaga sumir, invalida o código antigo e já consulta uma grade nova, sem pedir ao cliente para solicitar a atualização. Falha na leitura de confirmação mantém o pedido preparado, sem enviar o POST. Ainda pode haver disputa entre leitura e escrita: a proteção definitiva é a validação atômica do site. Se o POST retornar `409 horario_indisponivel`, também atualiza a grade. O tempo de validade do código não segura a vaga.

O contexto guarda também o catálogo consultado para relacionar nomes aos IDs corretos entre mensagens; isso não guarda nem garante vagas. IDs rejeitados provocam uma nova leitura do catálogo para corrigir a consulta. O catálogo acompanha a expiração do histórico e é apagado por `/iniciar`. Respostas livres com horas numéricas, ou que falem de disponibilidade sem tentativa de consulta, são descartadas e refeitas; se a IA não conseguir consultar, o atendimento retorna uma falha curta. A listagem de reservas próprias continua permitindo os horários lidos pela ferramenta de agendamentos.

Sem um dia indicado no contexto, uma tentativa de consultar uma data escolhida pela IA vira a pergunta “Pra qual dia?”. Os IDs são validados e guardados para a resposta seguinte; essa pergunta não vira grade no reenvio. Quando o cliente pede sugestões sem dia, a consulta usa a janela liberada, sem fixar uma data por conta própria.

O cliente pode mandar vários dados numa mensagem, em qualquer ordem. “Quero um corte com Julio” já define serviço e profissional: falta apenas perguntar o dia. Com dia e hora definidos, a Luna pede somente o nome se faltar; `conferir_horario` permite validar essa vaga sem reenviar a grade. Com todos os dados, chama diretamente o preparo, que valida a vaga e devolve o resumo para confirmação. Se o cliente informar uma hora antes do dia, essa hora acompanha a pergunta de data. Não é obrigatório passar pela grade para escolher novamente um horário já informado; dados ambíguos são esclarecidos antes do preparo. Conferir uma vaga não a reserva.

Respostas curtas como “hoje”, “amanhã” e “depois de amanhã” usam o fuso da barbearia. Imediatamente após a pergunta de dia com seleção validada ou uma grade, elas consultam o profissional/serviços para o novo dia, sem copiar horários do histórico. Uma mensagem intermediária encerra esse atalho, evitando reaproveitar o profissional antigo após uma troca. Quando o cliente escolhe a hora de uma única sugestão, a orientação é manter a data/profissional daquela sugestão e pedir apenas o dado faltante; havendo várias opções, esclarecer qual foi escolhida antes do preparo.

Grades guardadas para reenvio carregam os parâmetros da consulta, incluindo `data: null` quando o pedido era pelas próximas vagas e `comparar_barbeiros: true` quando o cliente quis comparar profissionais. Após falha de envio, ou se passaram mais de 30 segundos desde sua geração, o serviço consulta a agenda de novo antes de enviar. Se essa consulta falhar, pede nova consulta sem enviar horários antigos. Essa atualização só faz leituras; uma reserva de resultado incerto continua sendo recuperada pelo mesmo POST/chave/corpo, sem testar a vaga ocupada pela própria reserva.

## Trocar site ou tokens

- Mesmo site, token novo: altere `BARBEARIA_API_TOKEN` e reinicie.
- Outra barbearia: altere `BARBEARIA_API_URL`, `BARBEARIA_API_TOKEN`, `BARBEARIA_SITE_URL`, `BARBEARIA_NOME` e `DATABASE_PATH` (por exemplo `./data/outra-barbearia.sqlite`); reinicie e pareie o WhatsApp correspondente.
- O novo site precisa implementar o mesmo contrato de `docs/API_IA.md`. Para outro contrato, adapte [src/barbershop.js](src/barbershop.js) e os mapeamentos em [src/booking.js](src/booking.js).
- O serviço recusa reutilizar o banco com outra URL para não executar uma confirmação antiga na barbearia errada. Preserve o banco anterior para reconciliar operações pendentes. Uma instância atende uma barbearia e um WhatsApp; não há multitenancy.
- Não troque `DATA_ENCRYPTION_KEY` em um banco existente. Para rotacionar essa chave é necessária uma migração dos dados; perder a chave impede ler sessão e operações pendentes.

O fuso padrão é `America/Sao_Paulo`, conforme o contrato fornecido, independentemente do fuso da máquina. Mantenha `BARBEARIA_TIMEZONE` igual ao fuso usado pelo site.

## Executar em servidor

O domínio de produção é **https://ia.goodstyler.com/painel**. Na VPS que já usa Nginx, o Docker publica a Luna em **127.0.0.1:3308** e o Nginx existente cuida do domínio/HTTPS. [Passo a passo e onde preencher os tokens](docs/DEPLOY_VPS.md).

```sh
sh scripts/preparar-vps.sh
# Preencha OPENAI_API_KEY e BARBEARIA_API_TOKEN em .env.
docker compose up -d --build
sudo sh scripts/configurar-nginx.sh
```

O Compose mantém os dados em volume e publica `127.0.0.1:3308` na VPS, encaminhando para a porta 3000 dentro do container. O Nginx existente compartilha suas portas 80/443 entre os domínios e encaminha apenas `ia.goodstyler.com` à Luna. O script configura o domínio e usa Certbot com plugin Nginx para HTTPS; ele requer ambos instalados no host. O Caddy ficou opcional no perfil `caddy` e não inicia com `docker compose up` normal. O painel acessa a API no próprio domínio com sessão autenticada.

Execute **uma única réplica** por banco/sessão. O processo mantém uma trava de arquivo para impedir dois workers usando a mesma sessão. Não use PM2 cluster nem várias réplicas compartilhando esse volume. O SQLite deve ficar em disco local, não em volume de rede. `SIGINT`/`SIGTERM` encerram conexão e trabalho em andamento, com prazo máximo de 20 segundos.

Faça backup do volume e da chave de criptografia em locais protegidos. Para um backup simples consistente, pare o processo antes de copiar a pasta de dados completa (incluindo arquivos WAL, se existirem). Histórico usa até 20 mensagens por cliente no contexto durante 24 horas; limpeza de dados concluídos é feita em até `RETENTION_DAYS` + uma hora. Credenciais, opção de pausa e operações pendentes não são apagadas automaticamente. Logs estruturados não contêm corpos de mensagem, QR, tokens ou números de clientes. Com `WHATSAPP_PRINT_QR=true`, a imagem do QR é impressa na saída do processo; desative essa opção quando não precisar do pareamento pelo terminal.

Limites configuráveis: concorrência entre clientes, tamanho da fila, mensagens por minuto, idade máxima de mensagem recebida, timeout do site, tokens de saída da OpenAI e retenção. Fila cheia ou limite excedido ignora novas mensagens e registra o evento de fila cheia. Reenvios de mensagens de resposta podem se duplicar se o processo cair depois de o WhatsApp aceitar o envio e antes de registrar o sucesso; as escritas de agenda continuam protegidas pela chave de idempotência.

Baileys é uma biblioteca não oficial. A versão instalada e fixada é `7.0.0-rc14`, a versão publicada como atual no npm durante a implementação; trata-se de uma release candidate. Valide o pareamento com seu aparelho antes de uso operacional. O funcionamento depende também do WhatsApp e dos serviços externos.

## Verificação

```sh
npm run verify
php -l examples/whatsapp-painel.php
```

Os testes usam adaptadores simulados, sem enviar mensagens reais, cobrar chamadas da OpenAI ou criar reservas no site. Cobrem autenticação HTTP, contrato de chamadas, confirmação, expiração, titularidade, conflitos, timeouts, idempotência, criptografia, retomada de respostas, isolamento por cliente, limites, LID, QR e reconexão.

Para validar ponta a ponta: configure as duas credenciais, verifique `barbershop/check`, pareie o WhatsApp e faça um atendimento controlado com outro número. Antes disso não é possível afirmar que as credenciais, o site publicado ou o pareamento real funcionam. O contrato original informa que o PHP e as migrações precisam estar implantados no site; esta implementação não fez essa implantação.

## Referências utilizadas

- Contrato local: [API_IA.md](docs/API_IA.md) e [openapi-ia.json](docs/openapi-ia.json).
- [OpenAI Docs — Function calling](https://developers.openai.com/api/docs/guides/function-calling).
- [OpenAI Docs — instruções e exemplos de respostas](https://developers.openai.com/api/docs/guides/prompt-engineering).
- [OpenAI Docs — GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini).
- [Baileys — conexão e persistência de autenticação](https://github.com/WhiskeySockets/baileys.wiki-site/blob/main/docs/socket/connecting.md).
- [Baileys — quickstart e eventos de mensagens](https://github.com/WhiskeySockets/docs/blob/main/quickstart.mdx).

A implementação usa um adaptador SQLite para autenticação em vez de `useMultiFileAuthState`, seguindo a orientação da documentação para persistência própria.
