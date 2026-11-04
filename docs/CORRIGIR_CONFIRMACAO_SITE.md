# Falha ao confirmar no site

## Situação após a correção e resumo depois do nome

No diagnóstico posterior informado em 27/10/2026, os três testes passaram: catálogo `200`, corpo vazio `422 dados_invalidos` e profissional inexistente `422 dados_invalidos`, todos com `ok: true`. O erro 500 anterior deixou de ocorrer nesse teste; isso ainda não comprova a gravação de uma reserva válida.

Ao receber o nome de um pedido novo, a Luna prepara e envia nome, profissional, serviços, valor, data e horário, seguidos de **SIM ou CONFIRMAR**. O nome não autoriza um POST de agendamento. O resumo precisa ter sido entregue antes do aceite.

Se existir uma operação anterior com resultado incerto, o preparo permanece bloqueado para preservar a chave original. Antes, esse caminho repetia a mensagem “O site está com erro” com base no último erro salvo, mesmo depois de corrigir o site. Agora mostra o resumo salvo do **pedido anterior aguardando resultado** e pede SIM ou CONFIRMAR para tentar recuperar esse mesmo pedido. Não afirma que a reserva deixou de ser criada e não substitui seus dados pelos de um novo pedido. O nome sozinho não repete o POST. Reinicie o processo Node após atualizar o código para carregar a mudança.

## Diagnóstico de 27/10/2026: tabela de idempotência ausente

O log da hospedagem de `2026-10-27T20:33:37-03:00` registrou `etapa: idempotencia`, `tipo: PDOException`, `arquivo: api_ia.php`, `linha: 113`, `sqlstate: 42S02` e `driver_codigo: 1146`. Esses códigos indicam tabela inexistente. Na versão local conferida, a linha 113 prepara o `INSERT INTO api_ia_requisicoes`: se o arquivo publicado corresponde a essa versão, é essa tabela que falta no banco usado pela API.

No phpMyAdmin ou cliente MySQL da hospedagem:

1. Selecione o **mesmo banco configurado na conexão PHP do site publicado**. Criar a tabela apenas no XAMPP local não corrige a hospedagem.
2. Confira o banco selecionado e a tabela:

   ```sql
   SELECT DATABASE();
   SHOW TABLES LIKE 'api_ia_requisicoes';
   ```

3. Se estiver ausente, execute nesse banco o conteúdo de `C:/xampp/htdocs/barbearia_agenda/sql/migracao_api_ia.sql`. O SQL completo também está na seção **O que conferir no servidor PHP** abaixo. Apenas enviar o arquivo `.sql` para a hospedagem não executa a migração. Ela cria a tabela de idempotência e não remove agendamentos.
4. Se a tabela já existir no banco selecionado, confira se a API está conectada a esse mesmo banco e se o PHP publicado corresponde à versão local. Não apague nem recrie uma tabela existente para contornar o erro.
5. Rode `npm run diagnose:site` novamente. A terceira chamada deve retornar `422 dados_invalidos` (ou `404 nao_encontrado`), com `ok: true`. Se continuar retornando 500, consulte a nova linha do log: outra dependência pode estar ausente.

Esse log identifica a falha desta chamada de diagnóstico; ele não comprova o resultado de pedidos reais anteriores. Preserve as chaves e os corpos de operações com resultado incerto. A correção do banco não reenvia esses pedidos automaticamente, e o diagnóstico saudável ainda não comprova a gravação de uma reserva válida.

## Log TXT na hospedagem

Envie estes dois arquivos atualizados do projeto PHP para os mesmos caminhos na hospedagem:

- `C:/xampp/htdocs/barbearia_agenda/admin/api_ia.php` → `admin/api_ia.php`
- `C:/xampp/htdocs/barbearia_agenda/configs/api_ia_log.php` → `configs/api_ia_log.php` (novo)

Na próxima falha interna (HTTP 500 ou erro de banco temporário 503), o PHP cria automaticamente a pasta **`barbearia-api-logs` um nível acima da pasta do site**, com arquivo diário **`api-ia-AAAA-MM-DD.txt`**. Exemplo: site em `/home/usuario/public_html`, log em `/home/usuario/barbearia-api-logs/api-ia-2026-10-26.txt`. A data segue `America/Sao_Paulo`. Abra ou baixe pelo gerenciador de arquivos da hospedagem; não é uma URL pública.

Depois de enviar os dois arquivos, rode `npm run diagnose:site` novamente. Se ocorrer o erro 500, abra o TXT do dia e confira as últimas linhas. Cada linha contém um JSON com horário, ação, status HTTP, etapa, classe da exceção, nome do arquivo e linha; erros PDO incluem `sqlstate` e `driver_codigo`. O log não grava token, chave de idempotência, telefone, nome, corpo da requisição, mensagem SQL ou argumentos da exceção. Erros esperados de validação (422) não geram esse TXT.

Se a hospedagem impedir criar a pasta acima do site (`open_basedir` ou permissão), crie um diretório privado permitido e configure a variável de ambiente PHP `BARBEARIA_IA_LOG_DIR` com o caminho absoluto dessa pasta. A variável pertence ao **PHP da hospedagem**, não ao `.env` do Node. O usuário do PHP precisa poder criar/gravar os arquivos. Evite permissões 777. A pasta recebe um `.htaccess` com `Require all denied` como proteção adicional no Apache; em Nginx mantenha o diretório fora da raiz pública.

O limite é de 5 MiB por arquivo diário; erros além desse limite continuam no log padrão do PHP. Arquivos antigos podem ser removidos pelo gerenciador da hospedagem. Se faltar permissão, espaço ou houver limite atingido, o log padrão recebe `API IA: log TXT indisponivel`, e a API mantém sua resposta JSON sem expor detalhes ao cliente. O TXT é criado na primeira falha interna, não apenas ao consultar um catálogo saudável.

## Atualização de 26/10/2026: corpo vazio passou, transação ainda falha

A versão atual do PHP local valida o formato **antes da conexão e da transação**. Assim, o resultado anterior `catalogo: 200` + `corpo vazio: 422` não prova que a idempotência ou a gravação estejam funcionando. A interpretação anterior do diagnóstico foi insuficiente para essa nova versão.

O diagnóstico foi ampliado com uma terceira chamada: um corpo com formato válido, mas com profissional e serviço de ID `2147483647`, previamente ausentes do catálogo. Ela não pode agendar um serviço real. Na nova verificação, retornou:

```text
catalogo                            → 200, sucesso
validacao_agendar_corpo_vazio        → 422, dados_invalidos (esperado)
transacao_profissional_inexistente   → 500, erro_interno (FALHA)
```

O esperado na terceira chamada é a rejeição de negócio do profissional inexistente (`422 dados_invalidos` no PHP de referência, ou `404 nao_encontrado`), depois de entrar na camada de banco/transação. O 500 mostra que ainda há falha no caminho de escrita. Não foi feita uma reserva de teste nem repetido o POST do pedido real.

No servidor publicado, procure o log `API IA: falha interna` gerado pela terceira chamada. A versão local atual registra `etapa`, `tipo`, `arquivo`, `linha` e, para PDO, `sqlstate` e `driver_codigo`. Esses campos são necessários para identificar a causa exata. Se aparecer `etapa: idempotencia`, verifique `api_ia_requisicoes` no banco da hospedagem e suas permissões/colunas. A simples validação antecipada do corpo não substitui essa correção.

O fluxo Node também passou a exigir evidência de envio do resumo: nome e horário só preparam o pedido. `SIM` ou `CONFIRMAR` só enviam o primeiro POST após o resumo dessa operação ter sido enviado com sucesso e a resposta do cliente ter chegado depois. Resposta a outra pergunta devolve o resumo para um novo aceite. A confirmação antiga em recuperação mantém sua chave original; ela não deve ser apagada para contornar o erro.

## Verificação inicial (histórico)

Na verificação de 26/10/2026, o endpoint configurado respondeu ao POST:

```text
POST https://goodstyler.com/admin/api_ia.php?acao=agendar
Content-Type: application/json
Authorization: Bearer <token do backend>
Idempotency-Key: <UUID novo para o diagnóstico vazio>
Corpo: {}

HTTP 500
{"sucesso":false,"codigo":"erro_interno","erro":"Não foi possível processar a operação. Verifique a conexão e a migração da API no servidor."}
```

Esse corpo não permite criar uma reserva. Com a API e suas dependências funcionando, o esperado é **422 `dados_invalidos`**, pois faltam nome, telefone, barbeiro, serviços, data e hora. O HTTP 500 evidencia falha no processamento do site; trocar o texto da confirmação no WhatsApp não corrige esse erro.

No mesmo diagnóstico, `GET ?acao=catalogo` retornou **200** com `sucesso: true`. Portanto o endpoint está acessível e o token utilizado foi aceito para consulta; isso não comprova que a escrita está funcionando. A consulta de agendamentos do cliente do pedido incerto também não encontrou correspondência de barbeiro, data e hora entre as reservas retornadas. O pedido local foi preservado, sem reenviar POST de reserva durante a investigação.

## O que conferir no servidor PHP

Na versão inicial do código local de referência (`C:/xampp/htdocs/barbearia_agenda/admin/api_ia.php`), o POST acessava `api_ia_requisicoes` antes de validar os campos. A versão atual antecipa a validação de formato; um corpo válido continua passando pela transação e por essa tabela. A terceira chamada do diagnóstico investiga esse caminho. O corpo público não contém a exceção que confirme a causa do 500.

1. Consulte o log de erros do PHP da hospedagem no instante da chamada. Procure `API IA: falha interna`. Confira SQLSTATE e o erro do driver no servidor, sem publicar credenciais, telefones ou payloads. SQLSTATE `42S02` costuma indicar tabela ausente; `42S22`, coluna ausente. Não ative exibição pública de erros.
2. No **mesmo banco usado pelo site publicado**, confira a tabela e as colunas:

```sql
SHOW TABLES LIKE 'api_ia_requisicoes';
SHOW COLUMNS FROM api_ia_requisicoes;
```

3. Se a tabela estiver ausente, aplique `sql/migracao_api_ia.sql` do projeto PHP nesse banco. Conteúdo da migração de referência:

```sql
CREATE TABLE IF NOT EXISTS api_ia_requisicoes (
    chave VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    payload_hash CHAR(64) CHARACTER SET ascii NOT NULL,
    resposta LONGTEXT NULL,
    http_status SMALLINT NULL,
    criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

`IF NOT EXISTS` não corrige uma tabela já existente com colunas incompatíveis. Compare a estrutura com a migração. Confira também permissão de leitura/escrita do usuário MySQL e as tabelas/migrações de agenda e planos exigidas pelo projeto.

4. Confirme que `admin/api_ia.php`, `configs/api_ia_helpers.php`, `configs/reservas_helpers.php` e os helpers de agenda/planos enviados são da mesma versão. As tabelas de reservas e idempotência precisam usar InnoDB.
5. Repita o diagnóstico deste backend:

```sh
npm run diagnose:site
```

Esperado: catálogo saudável, POST vazio com **422 `dados_invalidos`** e teste de transação rejeitando o profissional inexistente com **422 `dados_invalidos`** (ou **404 `nao_encontrado`**). O comando não usa cliente ou profissional real nos POSTs e não imprime tokens. Mesmo todos passando, a gravação de uma reserva válida só fica comprovada com uma operação confirmada pelo cliente retornando sucesso.

## Como a confirmação deve responder

Depois do resumo, o cliente responde `SIM` ou `CONFIRMAR`, sem código. O Node envia:

```text
POST ?acao=agendar
Authorization: Bearer <token do backend>
Content-Type: application/json
Idempotency-Key: <mesma chave da operação em todas as tentativas>
```

O corpo segue o contrato de [API_IA.md](API_IA.md): `nome`, `telefone`, `barbeiro_id`, `servicos`, `data`, `hora`. O sucesso exige **201**, `sucesso: true` e `agendamento` com `id` numérico, barbeiro, data, hora, valor_total e status. Só depois desse retorno o WhatsApp informa que a reserva foi registrada.

Se o POST já foi tentado e o resultado ficou incerto, preserve a chave e o corpo originais. O cliente pode responder `CONFIRMAR` para recuperar o resultado com a mesma chave. Nunca substitua a chave para tentar contornar o 500: isso perde a proteção contra reserva duplicada. Corrigir o site não executa automaticamente pedidos antigos.

Enquanto o resultado estiver incerto, a Luna continua respondendo consultas de serviços e horários. Uma nova criação/cancelamento fica bloqueada somente para aquele cliente até resolver a operação anterior. Os logs do Node registram `booking_failed`, ação, status HTTP e código da API, sem dados pessoais ou tokens.
