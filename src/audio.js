import OpenAI, { toFile } from 'openai';

const formats = new Map([
  ['audio/ogg', 'ogg'], ['application/ogg', 'ogg'], ['audio/mpeg', 'mp3'], ['audio/mp3', 'mp3'],
  ['audio/mp4', 'm4a'], ['audio/x-m4a', 'm4a'], ['audio/wav', 'wav'], ['audio/x-wav', 'wav'],
  ['audio/webm', 'webm'], ['audio/flac', 'flac'], ['audio/x-flac', 'flac'],
]);
const failure = code => Object.assign(new Error(code), { code });

function recognitionContext(config, history) {
  const question = history?.messages?.at(-1)?.content ?? '';
  const barbers = history?.catalog?.barbeiros ?? [];
  const askingDay = /(?:qual|que) (?:o )?(?:dia|data)|dia (?:você |voce )?prefere/i.test(question);
  const askingBarber = /com quem|qual (?:barbeiro|profissional)/i.test(question);
  const prompt = 'Conversa em português do Brasil com uma barbearia. Transcreva apenas o que conseguir ouvir, inclusive negativas e correções.'
    + (askingDay ? ' A pergunta anterior era sobre o dia desejado.' : askingBarber ? ' A pergunta anterior era sobre a escolha de profissional.' : '');
  const names = barbers.map(item => item.nome);
  const services = barbers.flatMap(item => (item.servicos ?? []).map(service => service.nome));
  const words = askingDay ? [] : askingBarber ? names : [...names, ...services, config.BARBEARIA_NOME, config.BARBEARIA_DONO];
  const keywords = [...new Set(words.filter(word => typeof word === 'string' && /^[\p{L}\p{M}][\p{L}\p{M} '’-]{0,47}$/u.test(word)))].slice(0, 24);
  return { prompt, keywords };
}

export function audioFailureReply(error, config) {
  if (error.code === 'audio_disabled') return 'O atendimento por áudio está desativado. Pode escrever seu pedido? 💈';
  if (error.code === 'audio_too_long') return `Envie um áudio de até ${config.WHATSAPP_AUDIO_MAX_SECONDS} segundos ou escreva seu pedido. 💈`;
  if (error.code === 'audio_duration_unknown') return 'Não consegui conferir a duração. Pode gravar uma mensagem de voz pelo WhatsApp ou escrever seu pedido?';
  if (error.code === 'audio_too_large') return 'Esse áudio é muito grande. Pode enviar um áudio menor ou escrever seu pedido? 💈';
  if (error.code === 'audio_format') return 'Não consegui ler esse formato de áudio. Pode enviar uma mensagem de voz pelo WhatsApp ou escrever? 💈';
  if (error.code === 'audio_empty') return 'Não consegui entender o áudio. Pode repetir com mais clareza ou escrever seu pedido? 💈';
  if (error.code === 'audio_text_too_long') return 'O áudio contém muita informação. Pode dividir o pedido em mensagens menores? 💈';
  return 'Não consegui ouvir esse áudio agora. Pode reenviar ou escrever seu pedido? 💈';
}

export class AudioTranscriber {
  constructor({ config, client }) {
    this.config = config;
    this.client = client ?? (config.OPENAI_API_KEY ? new OpenAI({ apiKey: config.OPENAI_API_KEY, timeout: 45000, maxRetries: 1 }) : null);
  }
  async transcribe(audio, download, history) {
    const c = this.config;
    if (!c.WHATSAPP_AUDIO_ENABLED) throw failure('audio_disabled');
    if (!this.client || !download) throw failure('audio_unavailable');
    const media = audio.message.audioMessage;
    if (!Number.isFinite(media.seconds) || media.seconds <= 0) throw failure('audio_duration_unknown');
    if (media.seconds > c.WHATSAPP_AUDIO_MAX_SECONDS) throw failure('audio_too_long');
    if (media.fileLength > c.WHATSAPP_AUDIO_MAX_BYTES) throw failure('audio_too_large');
    const mime = (media.mimetype ?? '').split(';')[0].trim().toLowerCase();
    const extension = formats.get(mime);
    if (!extension) throw failure('audio_format');
    const controller = new AbortController();
    let stream, timer;
    // Limita o download inteiro, inclusive stream parado ou pedido de reupload.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        stream?.destroy();
        reject(failure('audio_download_timeout'));
      }, 20000);
    });
    let buffer;
    try {
      buffer = await Promise.race([deadline, (async () => {
        const received = await download(audio, controller.signal);
        if (controller.signal.aborted) { received.destroy(); throw failure('audio_download_timeout'); }
        stream = received;
        const chunks = [];
        let size = 0;
        for await (const part of stream) {
          const chunk = Buffer.from(part);
          size += chunk.length;
          if (size > c.WHATSAPP_AUDIO_MAX_BYTES) throw failure('audio_too_large');
          chunks.push(chunk);
        }
        if (!size) throw failure('audio_empty');
        return Buffer.concat(chunks, size);
      })()]);
    } finally {
      clearTimeout(timer);
      controller.abort();
      stream?.destroy();
    }
    const { prompt, keywords } = recognitionContext(c, history);
    const contextual = c.OPENAI_TRANSCRIPTION_MODEL === 'gpt-transcribe';
    const result = await this.client.audio.transcriptions.create({
      file: await toFile(buffer, `mensagem.${extension}`, { type: mime }),
      model: c.OPENAI_TRANSCRIPTION_MODEL,
      ...(contextual ? { languages: ['pt'], ...(keywords.length ? { keywords } : {}) } : { language: 'pt' }),
      ...(!c.OPENAI_TRANSCRIPTION_MODEL.includes('diarize') ? { prompt } : {}),
      response_format: 'json',
    });
    const text = typeof result?.text === 'string' ? result.text.trim() : '';
    const label = text.replace(/[^\p{L}\p{N} ]/gu, '').trim().toLowerCase();
    if (!label || ['inaudível', 'ininteligível', 'silêncio', 'ruído', 'inaudible'].includes(label)) throw failure('audio_empty');
    if (text.length > 4000) throw failure('audio_text_too_long');
    return text;
  }
}
