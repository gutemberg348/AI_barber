import { setTimeout as delay } from 'node:timers/promises';

export class ApiError extends Error {
  constructor(code, status = 0, uncertain = false) {
    super(code);
    this.code = code;
    this.status = status;
    this.uncertain = uncertain;
  }
}

export class BarbershopApi {
  constructor(config, { fetchImpl = fetch, sleep = delay } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.sleep = sleep;
  }
  async request(action, params = {}, key) {
    if (!this.config.BARBEARIA_API_TOKEN) throw new ApiError('api_nao_configurada', 503);
    const write = ['agendar', 'cancelar'].includes(action);
    if (!['catalogo', 'disponibilidade', 'agendamentos', 'agendar', 'cancelar'].includes(action)) throw new ApiError('acao_invalida');
    if (write && !key) throw new ApiError('idempotencia_obrigatoria');
    const url = new URL(this.config.BARBEARIA_API_URL);
    url.searchParams.set('acao', action);
    if (!write) for (const [name, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) url.searchParams.set(name, Array.isArray(value) ? value.join(',') : String(value));
    }
    const body = write ? JSON.stringify(params) : undefined;
    let uncertain = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      let retryAfter = 500 * 2 ** attempt;
      try {
        const response = await this.fetch(url, {
          method: write ? 'POST' : 'GET', redirect: 'error', cache: 'no-store',
          headers: {
            Authorization: `Bearer ${this.config.BARBEARIA_API_TOKEN}`, Accept: 'application/json',
            'Cache-Control': 'no-cache, no-store',
            ...(write ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}),
          },
          body, signal: AbortSignal.timeout(this.config.API_TIMEOUT_MS),
        });
        const retryHeader = response.headers.get('retry-after');
        const seconds = Number(retryHeader);
        const retryDate = Date.parse(retryHeader ?? '');
        if (Number.isFinite(seconds) && seconds > 0) retryAfter = seconds * 1000;
        else if (Number.isFinite(retryDate) && retryDate > Date.now()) retryAfter = retryDate - Date.now();
        // Stream limitado: uma resposta HTML/proxy não deve consumir memória ilimitada.
        let size = 0;
        const chunks = [];
        for await (const chunk of response.body ?? []) {
          size += chunk.length;
          if (size > 512 * 1024) throw new ApiError('resposta_muito_grande', response.status, write);
          chunks.push(Buffer.from(chunk));
        }
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString()); }
        catch { throw new ApiError('resposta_invalida', response.status, write); }
        if (!response.ok || data.sucesso !== true) {
          const transient = response.status >= 500 || response.status === 429;
          throw new ApiError(typeof data.codigo === 'string' ? data.codigo : 'falha_api', response.status, write && transient);
        }
        return data;
      } catch (error) {
        const apiError = error instanceof ApiError ? error : new ApiError('conexao_indisponivel', 0, write);
        uncertain ||= apiError.uncertain;
        apiError.retryAfterMs = retryAfter;
        const retry = apiError.status === 0 || apiError.status >= 500 || apiError.status === 429 || apiError.code === 'resposta_invalida';
        if (!retry || attempt === 2 || retryAfter > 5000) {
          apiError.uncertain = uncertain;
          throw apiError;
        }
      }
      await this.sleep(retryAfter);
    }
  }
}
