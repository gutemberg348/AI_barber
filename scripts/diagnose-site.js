import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';

// Nenhum POST usa um profissional real: testa validação e entrada na transação.
async function main() {
  const config = loadConfig();
  if (!config.BARBEARIA_API_TOKEN) throw new Error('token_ausente');
  const checks = [
    { name: 'catalogo', action: 'catalogo', method: 'GET' },
    { name: 'validacao_agendar_corpo_vazio', action: 'agendar', method: 'POST', body: '{}' },
  ];
  let healthy = true;
  for (const check of checks) {
    const url = new URL(config.BARBEARIA_API_URL);
    url.searchParams.set('acao', check.action);
    try {
      const response = await fetch(url, {
        method: check.method, body: check.body, redirect: 'error',
        headers: {
          Authorization: `Bearer ${config.BARBEARIA_API_TOKEN}`, Accept: 'application/json',
          ...(check.body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}),
        },
        signal: AbortSignal.timeout(config.API_TIMEOUT_MS),
      });
      let data;
      try { data = await response.json(); } catch { /* Reporta formato, não o corpo arbitrário. */ }
      const ok = check.method === 'GET' ? response.ok && data?.sucesso === true
        : check.name === 'transacao_profissional_inexistente'
          ? data?.sucesso === false && ((response.status === 422 && data?.codigo === 'dados_invalidos') || (response.status === 404 && data?.codigo === 'nao_encontrado'))
          : response.status === 422 && data?.sucesso === false && data?.codigo === 'dados_invalidos';
      if (check.method === 'GET' && ok && Array.isArray(data.barbeiros) && /^\d{4}-\d{2}-\d{2}$/.test(data.janela?.inicio)) {
        const ids = new Set(data.barbeiros.flatMap(barber => [barber.id, ...(barber.servicos ?? []).map(service => service.id)]));
        let absentId = 2147483647;
        while (ids.has(absentId)) absentId--;
        checks.push({
          name: 'transacao_profissional_inexistente', action: 'agendar', method: 'POST',
          body: JSON.stringify({ nome: 'Diagnostico sem reserva', telefone: '11900000000', barbeiro_id: absentId, servicos: [absentId], data: data.janela.inicio, hora: '09:00' }),
        });
      } else if (check.method === 'GET') healthy = false;
      healthy &&= ok;
      console.log(JSON.stringify({
        check: check.name,
        ok, httpStatus: response.status, json: Boolean(data),
        apiCode: typeof data?.codigo === 'string' && /^[a-z_]{1,80}$/.test(data.codigo) ? data.codigo : undefined,
      }));
    } catch {
      healthy = false;
      console.log(JSON.stringify({ check: check.name, ok: false, error: 'conexao_ou_resposta_indisponivel' }));
    }
  }
  console.log('Sem dados de clientes ou profissional real nos POSTs. Esses testes não comprovam gravação de uma reserva válida. Guia: docs/CORRIGIR_CONFIRMACAO_SITE.md');
  if (!healthy) process.exitCode = 1;
}

main().catch(() => {
  console.error('Não foi possível diagnosticar. Revise a configuração da API no .env.');
  process.exitCode = 1;
});
