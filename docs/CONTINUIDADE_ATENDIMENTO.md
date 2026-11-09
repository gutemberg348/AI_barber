# Tom e continuidade do atendimento

O atendimento passou a usar um tom cordial e levemente formal, sem “parceiro”, “meu irmão” ou “tamo junto”. A mudança vale para as instruções do modelo, o cumprimento de `/iniciar`, os resumos novos e as mensagens de sucesso. As respostas continuam curtas e com emojis discretos. Conversas antigas não precisam ser apagadas para aplicar as novas instruções; operações pendentes mantêm seus dados originais.

Foram corrigidos dois caminhos capazes de interromper a conversa:

- “Agenda meu horário para segunda de manhã” era confundido com consulta de reserva existente por conter “meu horário”. Agora segue o fluxo de nova marcação. Consultas como “meu horário continua?” continuam buscando a reserva no site.
- A proteção contra vagas inventadas podia bloquear uma pergunta curta como “Com qual barbeiro deseja agendar seu horário?”. Agora permite perguntas de dados faltantes, mantendo o bloqueio de horas publicadas pelo modelo sem consulta.

Dia e período informados permanecem no histórico enquanto o cliente escolhe profissional e serviços. As instruções orientam a consultar a grade real e não escolher uma hora automaticamente. Uma falha temporária oferece tentar novamente na conversa, sem mandar o cliente sair para o site. Esgotar as seis etapas registra `luna_turn_limit` nos logs do Node, sem conteúdo de conversa ou telefone. Uma indisponibilidade real da API ainda pode impedir uma consulta; a correção não garante disponibilidade externa nem dispensa a confirmação após o resumo.

Os testes cobrem a frase do incidente, escolhas em mensagens seguintes, perguntas de continuação, reserva existente, proteção contra horas inventadas e retomada após falha simulada. Não criam reservas reais nem comprovam qual erro ocorreu na VPS no instante da captura.

A integração mantém o fluxo de [chamadas de ferramentas da documentação oficial da OpenAI](https://developers.openai.com/api/docs/guides/function-calling): a aplicação executa a consulta e devolve seu resultado ao modelo. Grades e resumos continuam sendo enviados pelo backend, e a gravação continua exigindo o aceite posterior do cliente.

## Atualizar na VPS

Após enviar as alterações ao Git:

```sh
cd /var/www/ia_barber/AI_barber
git pull --ff-only origin main
docker compose -p luna-ia -f compose.yaml up -d --build luna
```

Não é necessário substituir o `.env`, apagar dados ou configurar novamente o Nginx. Para acompanhar falhas após a atualização:

```sh
docker compose -p luna-ia -f compose.yaml logs --tail=100 -f luna
```
