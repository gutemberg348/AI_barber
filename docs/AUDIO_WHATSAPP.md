# Áudio no atendimento do WhatsApp

O agente recebe mensagens de voz e arquivos enviados como áudio pelo WhatsApp, transcreve com a OpenAI e responde por texto. O texto reconhecido entra no mesmo fluxo: catálogo completo, consulta real de horários no site, resumo e aceite posterior para criar ou cancelar uma reserva. Não há geração de resposta em voz.

Usa a mesma `OPENAI_API_KEY` já configurada. A transcrição é uma chamada adicional da API e tem cobrança própria. O modelo de conversa `OPENAI_MODEL` não muda. Os padrões já estão no código, portanto um `.env` existente funciona sem acrescentar variáveis:

```dotenv
OPENAI_TRANSCRIPTION_MODEL=gpt-transcribe
WHATSAPP_AUDIO_ENABLED=true
WHATSAPP_AUDIO_MAX_SECONDS=300
WHATSAPP_AUDIO_MAX_BYTES=10485760
```

Para desligar apenas a interpretação de áudio, defina `WHATSAPP_AUDIO_ENABLED=false` e recrie o container. Não precisa de outra chave, endpoint PHP, FFmpeg ou configuração do Nginx. O `.env` deve continuar apenas na VPS/local, fora do Git.

## Funcionamento e limites

- Mensagens passam pelos mesmos filtros de remetente, idade, deduplicação, pausa e limite por cliente antes do download. Um áudio não bloqueia conversas de outros clientes; áudio e texto do mesmo remetente seguem a ordem da fila.
- A duração informada pelo WhatsApp é limitada a 300 segundos por padrão. O download é interrompido se os bytes reais excederem 10 MiB, mesmo que a mensagem declare um arquivo menor. Tem prazo de 20 segundos; a transcrição usa timeout de 45 segundos por tentativa e uma repetição automática do SDK para falhas transitórias.
- OGG/Opus de mensagem de voz é enviado diretamente. Também são aceitos tipos MIME de MP3, M4A/MP4, WAV, WebM e FLAC. Formato não aceito, mídia indisponível, transcrição vazia ou erro da OpenAI geram pedido curto para reenviar ou escrever, sem executar o agente com conteúdo vazio. Documentos anexados, vídeos, imagens e figurinhas continuam sem interpretação.
- O arquivo baixado fica em memória e não é salvo em disco. Enquanto aguarda processamento, a fila guarda no SQLite criptografado apenas os metadados necessários ao download, incluindo a chave da mídia. Após a tentativa, esses metadados são removidos. Se houver sucesso, o texto reconhecido é persistido antes de chamar o agente e segue a mesma retenção do histórico escrito. A OpenAI recebe o áudio para transcrição.
- Um reenvio da resposta já pronta não transcreve novamente. Um reinício depois de persistir a transcrição também a reutiliza. Se o processo cair enquanto a chamada externa ainda não tiver retornado/persistido, a retomada pode repetir a transcrição; não há garantia de cobrança única nesse caso.
- Um áudio com “sim” só confirma se tiver sido recebido depois da entrega do resumo daquela operação. Horário ou nome sozinhos continuam sem autorizar gravação. O identificador do remetente e o momento de recebimento vêm do WhatsApp, não do áudio.

A transcrição pode errar nomes, números ou falas com ruído. O cliente confere profissional, serviços, valor, data e horário no resumo antes de aceitar. Falas ambíguas devem ser esclarecidas.

O modelo padrão recebe dicas curtas de contexto em português. Na escolha do profissional, podem acompanhar a gravação nomes públicos do catálogo consultado naquela conversa. Na pergunta pelo dia, a dica descreve a etapa sem sugerir uma data. Mensagens anteriores, telefone do cliente e dados das reservas não entram nessas dicas. Uma transcrição vazia ou marcada como inaudível pede reenvio e preserva a seleção em andamento.

Implementação baseada na [documentação oficial de transcrição da OpenAI](https://developers.openai.com/api/docs/guides/speech-to-text) e no [download de mídia documentado pelo Baileys](https://github.com/WhiskeySockets/docs/blob/main/messaging/media-messages.mdx). O SDK instalado já suporta `gpt-transcribe` e `languages`. Não foi necessário atualizar dependências.

## Subir na VPS

Depois de enviar os arquivos alterados e os novos `src/audio.js` e `test/audio.test.js` ao Git:

```sh
cd /var/www/ia_barber/AI_barber
git pull --ff-only origin main
docker compose -p luna-ia -f compose.yaml up -d --build luna
docker compose -p luna-ia -f compose.yaml logs --tail=100 -f luna
```

Não apague o volume, o banco, as chaves ou a sessão do WhatsApp. Envie um áudio curto como “Quero um corte com Júlio amanhã” e confira a continuação por texto. Os testes automatizados simulam áudio/SDK/site e não abrem uma sessão de WhatsApp nem criam reservas reais. A validação com áudio de cliente no WhatsApp depende do processo atualizado conectado na VPS.
