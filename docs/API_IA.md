# Integração da IA com a barbearia

Endpoint: `BASE_URL/admin/api_ia.php?acao=...`.

No servidor onde o site está na raiz, use `https://goodstyler.com/admin/api_ia.php`.
Se estiver instalado numa subpasta, inclua a subpasta na URL. No XAMPP deste projeto:
`http://localhost/barbearia_agenda/admin/api_ia.php`.

**A implementação está no projeto local. A URL pública só terá estes recursos depois de enviar os arquivos e aplicar a migração.**

Neste XAMPP, a migração já foi aplicada e o acesso via Apache foi verificado: catálogo com token retorna `200`, sem token retorna `401`, e o arquivo local do segredo retorna `403` por HTTP. Nenhum agendamento real foi criado ou cancelado na verificação; os testes de escrita usaram um banco separado.

## Ativação no servidor da barbearia

1. Envie `admin/api_ia.php`, `admin/.htaccess`, `configs/api_ia_helpers.php`, `configs/reservas_helpers.php`, `configs/.htaccess` e os helpers existentes `agenda_helpers.php` e `planos_helpers.php`.
2. Envie também as alterações de `ajax/salvar_agendamento.php`, `ajax/api_cliente.php` e `admin/ajax/api_confirm.php`: o site compartilha a trava de reserva com a IA, e o endpoint administrativo exige sessão.
3. Execute **`sql/migracao_api_ia.sql` no banco da aplicação**. Ele cria apenas `api_ia_requisicoes`; não remove dados. O banco já deve ter as tabelas/migrações de agenda e planos existentes. As tabelas de reservas, clientes, serviços, horários e planos precisam usar InnoDB para as transações funcionarem.
4. Defina `BARBEARIA_IA_TOKEN` no ambiente do PHP com um segredo aleatório de pelo menos 32 caracteres, sem espaços. Alternativa para hospedagem compartilhada: execute `php scripts/gerar_token_ia.php` para gerar `configs/api_ia.local.php` (64 caracteres hexadecimais), ou envie esse arquivo por canal privado. O gerador nunca sobrescreve um token existente.
5. Coloque **o mesmo token somente no backend da IA**. Aqui já foi gerado um token em `configs/api_ia.local.php`, ignorado pelo Git. A variável de ambiente, quando definida, tem prioridade sobre o arquivo.
6. Faça `GET ?acao=catalogo` com o Bearer token para verificar. Sem configuração válida: `503`; sem token válido: `401`. Em FastCGI/proxy, encaminhe `Authorization` ao PHP; `admin/.htaccess` cobre o encaminhamento comum no Apache.

Use HTTPS em produção. Não coloque o segredo na URL, no frontend, no prompt do modelo ou nos logs. O backend da IA injeta o cabeçalho ao executar as ferramentas. Não há CORS aberto; esta é uma API servidor-a-servidor, sem necessidade de login do painel.

## Autenticação e formatos

Todas as ações exigem:

```http
Authorization: Bearer SEU_TOKEN
```

POST também exige:

```http
Content-Type: application/json
Idempotency-Key: 8104bd19-9163-4a91-9475-22c0d812e93b
```

- Gere uma chave aleatória, como UUID, **por operação**. Armazene a chave e repita a mesma chave/corpo em caso de timeout, falha de rede ou `503`. Não gere uma chave diferente em cada tentativa.
- Chaves: 16–128 caracteres, somente letras ASCII, números, `_` ou `-`. A chave é global às operações: não reutilize a de agendar para cancelar.
- Chave já concluída + mesmo corpo/ação: devolve exatamente a resposta original e `Idempotency-Replayed: true`. Outra ação/corpo: `409 chave_reutilizada`. Reordenar as propriedades de primeiro nível não muda a operação; mantenha a ordem dos IDs de serviços em retries.
- A resposta original de criação pode continuar mostrando `pendente` após um cancelamento posterior: consulte `agendamentos` para o estado atual.
- Erros de validação/indisponibilidade não são gravados como operações concluídas. A gravação da resposta e a alteração do agendamento são atômicas.
- Datas: `YYYY-MM-DD`; horas: `HH:MM`; fuso: **`America/Sao_Paulo`**, o mesmo usado pela agenda. Não converta a hora para UTC ao enviar.
- Valores monetários são strings decimais em reais: `"30.50"`. IDs e duração são números inteiros; flags são booleanos JSON.
- Telefone brasileiro com DDD: 10 ou 11 dígitos. Aceita máscara e DDI 55, por exemplo `+55 (11) 99999-1234`; normaliza a entrada para `11999991234`. A resposta pode manter a máscara existente no cadastro.
- Limite de corpo: 16 KB. Campos não documentados são rejeitados.

## Operações

| Método | Ação | Uso |
|---|---|---|
| GET | `catalogo` | Profissionais ativos, serviços, preços, duração e janela de dias |
| GET | `disponibilidade` | Horários livres para o profissional e os serviços selecionados |
| GET | `agendamentos` | Reservas de hoje em diante vinculadas a um telefone |
| POST | `agendar` | Criar reserva com nome, telefone, profissional, serviços, data e hora |
| POST | `cancelar` | Cancelar uma reserva pelo ID e telefone do cliente |

O bot antigo pode continuar usando `admin/api_agendamentos.php`. Esse endpoint legado não é o contrato da IA e seu token antigo não autentica a API nova.

### 1. Catálogo

```http
GET /admin/api_ia.php?acao=catalogo
Authorization: Bearer SEU_TOKEN
```

Exemplo ilustrativo (datas e IDs devem vir da resposta real):

```json
{
  "sucesso": true,
  "timezone": "America/Sao_Paulo",
  "moeda": "BRL",
  "janela": {"inicio":"2026-10-23","fim":"2026-10-29","limite_dias":7},
  "dias_atendimento": ["2026-10-23","2026-10-24","2026-10-26","2026-10-27","2026-10-28","2026-10-29"],
  "barbeiros": [{
    "id": 1, "nome": "Julio", "especialidade": "Corte e barba",
    "servicos": [{"id":1,"nome":"Corte","preco":"30.00","duracao_minutos":30}]
  }]
}
```

`dias_atendimento` é o calendário permitido, excluindo domingos como no site. **Não garante vaga.** Bloqueios, ocupação e duração são verificados em `disponibilidade` e novamente ao gravar. Não são retornados e-mails de acesso, senhas, PINs ou dados de outros clientes.

### 2. Dias e horários disponíveis

```http
GET /admin/api_ia.php?acao=disponibilidade&barbeiro_id=1&servicos=1,2&data_inicio=2026-10-24&data_fim=2026-10-26
Authorization: Bearer SEU_TOKEN
```

- Obrigatórios: `barbeiro_id` e `servicos` (IDs separados por vírgula; 1–20 serviços ativos, sem repetição, todos do profissional escolhido).
- Datas opcionais: sem datas, consulta toda a janela liberada (até 60 dias). Só `data_inicio`: consulta aquele dia. Com ambas: intervalo inclusivo.
- Período inválido/fora da janela retorna `422`; dia válido sem vaga retorna `200` com `horarios: []`.

```json
{
  "sucesso": true,
  "timezone": "America/Sao_Paulo",
  "barbeiro_id": 1,
  "duracao_minutos": 60,
  "minutos_reservados": 60,
  "dias": [
    {"data":"2026-10-24","disponivel":true,"horarios":[{"hora":"08:00","hora_fim":"09:00"},{"hora":"09:00","hora_fim":"10:00"}]},
    {"data":"2026-10-25","disponivel":false,"horarios":[]},
    {"data":"2026-10-26","disponivel":false,"horarios":[]}
  ]
}
```

A duração e os preços vêm do banco. A ocupação segue a regra existente: blocos de 30 minutos, com tolerância de 10 minutos (`max(1, ceil((duração - 10) / 30))` blocos). Assim, serviço de 40 minutos reserva 30 minutos; `duracao_minutos` e `minutos_reservados` podem ser diferentes. Todos os blocos precisam estar ativos e livres. Horários passados, domingo, bloqueios por data/período e sobreposições são excluídos.

### 3. Marcar

```http
POST /admin/api_ia.php?acao=agendar
Authorization: Bearer SEU_TOKEN
Content-Type: application/json
Idempotency-Key: 8104bd19-9163-4a91-9475-22c0d812e93b

{
  "nome": "Rafael Silva",
  "telefone": "11999991234",
  "barbeiro_id": 1,
  "servicos": [1],
  "data": "2026-10-24",
  "hora": "09:00"
}
```

Resposta **201**:

```json
{
  "sucesso": true,
  "timezone": "America/Sao_Paulo",
  "agendamento": {
    "id": 123,
    "barbeiro_id": 1,
    "barbeiro": "Julio",
    "cliente_nome": "Rafael Silva",
    "telefone": "11999991234",
    "data": "2026-10-24",
    "hora": "09:00",
    "hora_fim": "09:30",
    "valor_total": "30.00",
    "status": "pendente",
    "plano_usado": false,
    "servicos": [{"id":1,"nome":"Corte","preco":"30.00"}]
  }
}
```

O cliente é localizado pelo telefone ou cadastrado automaticamente. O nome de cliente já existente é preservado. Não envie preço, duração, status, `cliente_id` ou `hora_fim` — o servidor calcula tudo. **Esta versão cria reservas avulsas; não aceita compra ou utilização de plano/PIN.** Para cliente que queira usar plano, encaminhe ao fluxo do site. Cancelar uma reserva existente feita com plano devolve o uso uma única vez.

`409 horario_indisponivel`: a vaga pode ter sido ocupada após a consulta. Consulte novamente e ofereça alternativas. Uma resposta de disponibilidade não é uma reserva temporária.

### 4. Consultar agendamentos do cliente

```http
GET /admin/api_ia.php?acao=agendamentos&telefone=11999991234&pagina=1
Authorization: Bearer SEU_TOKEN
```

Resposta **200**: `{"sucesso":true,"timezone":"America/Sao_Paulo","pagina":1,"tem_mais":false,"agendamentos":[...]}`.

Cada item tem o mesmo formato de `agendamento` acima. Retorna hoje e datas futuras, incluindo cancelados/concluídos; até 50 itens por página, em ordem de data/hora/ID. `pagina` começa em 1 e vai até 1000. Lista vazia é sucesso, não erro. Para oferecer cancelamento, filtre `status === "pendente"` e data/hora futura. Identifique o telefone pelo canal autenticado da conversa; não permita que o modelo escolha livremente o telefone de terceiros.

### 5. Cancelar

```http
POST /admin/api_ia.php?acao=cancelar
Authorization: Bearer SEU_TOKEN
Content-Type: application/json
Idempotency-Key: 67385735-58e5-42df-a97f-cb4892e135b8

{"agendamento_id":123,"telefone":"11999991234"}
```

Resposta **200**, no mesmo formato de criação, com `status: "cancelado"`. O telefone precisa pertencer ao agendamento. ID inexistente ou telefone diferente: `404`. Já cancelado: sucesso, sem repetir devolução de uso. Reserva concluída ou cujo horário passou: `409 cancelamento_nao_permitido`.

## Erros

```json
{"sucesso":false,"codigo":"horario_indisponivel","erro":"Horário indisponível. Consulte a disponibilidade novamente."}
```

| HTTP | Códigos principais | Conduta |
|---|---|---|
| 400 | `json_invalido` | Corrigir o JSON |
| 401 | `nao_autorizado` | Conferir Bearer token no backend |
| 404 | `acao_inexistente`, `nao_encontrado` | Conferir ação, ID e telefone |
| 405 | `metodo_invalido` | Usar o método indicado em `Allow` |
| 409 | `horario_indisponivel` | Consultar novas vagas |
| 409 | `chave_reutilizada` | Corrigir gerenciamento das chaves; nova operação exige nova chave |
| 409 | `cancelamento_nao_permitido` | Encaminhar ao atendimento |
| 413 | `corpo_muito_grande` | Reduzir corpo para até 16 KB |
| 415 | `tipo_invalido` | Usar application/json |
| 422 | `dados_invalidos`, `campos_desconhecidos`, `periodo_invalido`, `idempotencia_obrigatoria` | Corrigir os parâmetros |
| 500 | `erro_interno` | Conferir conexão/migração; não afirmar sucesso |
| 503 | `api_nao_configurada` | Configurar token no servidor |
| 503 | `tente_novamente` | Aguardar Retry-After e repetir mesma chave/corpo |

## Texto pronto para colar no Codex do projeto da IA

```text
Integre o backend da IA com a API existente da Good Style, sem criar outro banco de agendamentos.

Configuração exclusivamente no servidor:
BARBEARIA_API_URL=https://goodstyler.com/admin/api_ia.php
BARBEARIA_API_TOKEN=<segredo fornecido por canal privado>
Ajustar a URL caso o site esteja numa subpasta. Não hardcodar o token nem entregá-lo ao modelo/frontend.

Todas as requisições usam Authorization: Bearer ${BARBEARIA_API_TOKEN}.
GET ?acao=catalogo: retorna timezone, moeda, janela, dias_atendimento e barbeiros[{id,nome,especialidade,servicos[{id,nome,preco,duracao_minutos}]}].
GET ?acao=disponibilidade&barbeiro_id=ID&servicos=ID1,ID2&data_inicio=YYYY-MM-DD&data_fim=YYYY-MM-DD:
retorna dias[{data,disponivel,horarios[{hora,hora_fim}]}], duracao_minutos e minutos_reservados.
Datas opcionais: sem datas, janela inteira; só data_inicio, apenas esse dia. Catálogo NÃO garante vaga.
GET ?acao=agendamentos&telefone=DDDNUMERO&pagina=1: retorna agendamentos de hoje em diante, incluindo cancelados/concluídos, tem_mais e pagina (50 itens/página).
POST ?acao=agendar: JSON {nome,telefone,barbeiro_id,servicos:[IDs],data:"YYYY-MM-DD",hora:"HH:MM"}.
POST ?acao=cancelar: JSON {agendamento_id,telefone}.
Os POSTs exigem Content-Type: application/json e Idempotency-Key UUID, persistida por operação e reutilizada com corpo idêntico em retries/timeouts.
Criação retorna HTTP 201; cancelamento e consultas 200. Criação/cancelamento retornam {sucesso:true,timezone,agendamento:{id,barbeiro_id,barbeiro,cliente_nome,telefone,data,hora,hora_fim,valor_total,status,plano_usado,servicos:[{id,nome,preco}]}}.
Valores são strings decimais em BRL. Datas/horas sempre em America/Sao_Paulo. Telefone brasileiro com DDD; DDI 55 e máscara são aceitos.
Use IDs reais do catálogo; nunca invente preço, profissional, serviço ou vaga. O servidor calcula preço e duração. Não envie campos extras.
Antes de gravar/cancelar, resuma os dados e obtenha confirmação do cliente. Use o telefone identificado no canal da conversa; não aceite o modelo trocar o telefone por um de terceiros.
409 horario_indisponivel: consultar novamente e oferecer novas opções. 409 chave_reutilizada: erro de uso da chave. 401: problema de configuração, não pedir token ao cliente. Não afirmar sucesso após timeout; repetir a mesma operação/chave para recuperar o resultado.
Uma resposta repetida de criação é a resposta original. Consulte agendamentos para o estado atual.
Só cancelar reservas pendentes futuras; já cancelada é sucesso. Esta versão agenda serviços avulsos, sem uso/compra de plano/PIN. Para usar plano, encaminhe ao site.
Não chamar os endpoints AJAX do site nem admin/api_agendamentos.php: eles não fazem parte deste contrato.
Tratar erros {sucesso:false,codigo,erro}. Consultar docs/API_IA.md e docs/openapi-ia.json para o contrato completo.
```

## Verificação local

Sintaxe: `php -l admin/api_ia.php` (e helpers alterados).

Integração: `node tests/api_ia.integration.cjs`, com MariaDB **exclusivo para teste** em `127.0.0.1:33316`, root sem senha. É possível alterar a porta com `IA_TEST_MYSQL_PORT`. O teste cria um banco de nome aleatório `api_ia_test_*`, inicia servidores PHP temporários nas portas 8098–8100 e remove apenas o banco criado por essa execução. Não usa a conexão real do projeto. Cobre autenticação, validação, preços/duração, bloqueios, concorrência entre IA/site, idempotência, consulta e cancelamento/devolução de uso.
