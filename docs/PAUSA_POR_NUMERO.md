# Atendimento manual por número

Na aba **Conversas** do painel, cada número tem seu próprio interruptor:

- **Ligada:** o agente pode responder a esse número, desde que o botão geral esteja ligado e o WhatsApp conectado.
- **Pausada:** você atende pelo aplicativo do WhatsApp; o agente fica em silêncio nessa conversa. Os demais números continuam funcionando.

Para assumir uma conversa, encontre o número e desligue o interruptor. Se ele ainda não aparece, use **Adicionar com IA pausada**, informando DDD e número; o nome é opcional. O formato pode ter `+55`, parênteses, espaços e hífen. A lista tem busca e filtro por estado. Novos remetentes passam a aparecer quando enviam mensagens após esta atualização. O histórico antigo usa chaves protegidas e não permite reconstruir uma lista retroativa de todos os telefones; contatos antigos podem ser adicionados manualmente.

A pausa do administrador fica no SQLite criptografado e continua valendo com o painel fechado ou após reiniciar o container. Nenhum `.env`, endpoint do site ou configuração do Nginx precisa mudar. As formas compatíveis de celular brasileiro com e sem o nono dígito compartilham o interruptor, preservando DDD. O telefone original de reservas e operações pendentes não é reescrito.

Durante a pausa do painel, texto, áudio e comandos como `/voltar` e `/iniciar` não provocam resposta. Um áudio ainda não iniciado não é baixado nem enviado para transcrição. Se o modelo já estiver processando, o resultado será descartado antes do envio. Uma mensagem já enviada ao WhatsApp não pode ser desfeita; uma operação já enviada ao site também pode terminar, e sua chave/resultado permanece preservado.

Ao religar o interruptor, o agente atende **novas mensagens**, sem despejar respostas antigas que aguardavam envio ou processamento. O histórico anterior permanece disponível para dar continuidade, mas o trecho atendido manualmente não é lido pelo bot: mensagens enviadas pelo dono continuam sendo ignoradas. Se o cliente já tivesse usado `/parar`, a retomada pelo painel também limpa essa pausa. O botão geral permanece independente.

O painel é um controle do agente, não uma caixa de entrada: não exibe conteúdo das mensagens nem envia sua resposta ao cliente. Converse pelo próprio WhatsApp.

## Atualizar a VPS

Após enviar as alterações ao Git, incluindo `src/contacts.js`, `test/contacts.test.js` e este documento:

```sh
cd /var/www/ia_barber/AI_barber
git pull --ff-only origin main
docker compose -p luna-ia -f compose.yaml up -d --build luna
```

Abra o painel e entre em **Conversas**. Não apague o volume ou substitua as chaves do banco.
