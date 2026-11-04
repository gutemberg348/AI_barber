const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const pages = { overview: 'Visão geral', connection: 'WhatsApp', teachings: 'Ensinamentos', settings: 'Configurações' };
const categories = { atendimento: 'Atendimento', informacoes: 'Informações', regras: 'Regras' };
const stateNames = { connected: 'Conectado', qr: 'Aguardando leitura', connecting: 'Conectando', reconnecting: 'Reconectando', disconnected: 'Desconectado', logged_out: 'Sem vínculo', error: 'Atenção na conexão' };
let authenticated = false, overview = null, teachings = { revision: 0, lessons: [] }, editingId = null;
let pollTimer, toastTimer, qrExpiry = 0, fetching = false, mutating = false, fresh = false, sessionEpoch = 0;
let currentPage = 'overview';

function toast(message, error = false) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.toggle('error', error); $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4800);
}
function resetQr() { qrExpiry = 0; $('#qr-image').hidden = true; $('#qr-image').removeAttribute('src'); $('#qr-placeholder').hidden = false; }
function showLogin() {
  authenticated = false; sessionEpoch++; fresh = false; overview = null; clearTimeout(pollTimer); resetQr();
  teachings = { revision: 0, lessons: [] }; $('#lesson-list').replaceChildren();
  $$('dialog[open]').forEach(dialog => dialog.close());
  $('#workspace').hidden = true; $('#login-screen').hidden = false; $('#access-key').value = '';
}
async function api(path, options = {}) {
  const { key, ...rest } = options;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`/api/v1/${path}`, { ...rest, signal: controller.signal, credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Luna-Panel': '1', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 && authenticated) { showLogin(); toast('Sua sessão terminou. Entre novamente.'); }
      const messages = { 401: 'Chave de acesso inválida. Confira e tente novamente.', 409: 'Os ensinamentos mudaram em outra sessão. A lista foi atualizada; confira antes de salvar novamente.', 429: 'Muitas tentativas. Aguarde um minuto e tente novamente.', 400: 'Confira os campos. Use até 30 ensinamentos e 18.000 caracteres no total.' };
      throw Object.assign(new Error(messages[response.status] ?? 'Não foi possível concluir. Tente novamente em instantes.'), { status: response.status, code: data.error });
    }
    return data;
  } catch (error) {
    if (!error.status) throw new Error('Não foi possível conectar ao painel. Confira sua conexão.');
    throw error;
  } finally { clearTimeout(timer); }
}
function badge(id, label, good, warn = false) {
  const element = $(id); element.textContent = label; element.className = `badge${good ? ' good' : warn ? ' warn' : ''}`;
}
function renderStatus() {
  if (!overview) return;
  const s = overview.status;
  $$('[data-shop]').forEach(element => { element.textContent = overview.barbershop; });
  $('#shop-avatar').textContent = overview.barbershop.split(' ').filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase();
  $('#owner-avatar').textContent = overview.owner.slice(0, 1).toUpperCase();
  $('#today-label').textContent = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: overview.timezone }).format(new Date(overview.serverTime)).toUpperCase();
  $('#count-conversations').textContent = overview.counts.conversations;
  $('#count-waiting').textContent = overview.counts.waiting;
  $('#count-teachings').textContent = overview.counts.teachings;
  $('#conversation-window').textContent = `Conversas nas últimas ${overview.historyHours} horas`;
  $('#hero-status').textContent = !fresh ? 'Sem atualização' : s.ready ? 'Pronta para atender' : !s.botEnabled ? 'Atendimento pausado' : 'Preparando o atendimento';
  $('#hero-title').textContent = s.ready ? 'A Luna cuida das conversas. Você cuida dos clientes.' : !s.botEnabled ? 'Uma pausa, no seu tempo.' : 'Sua assistente. Seu jeito de atender.';
  $('#hero-description').textContent = !fresh ? 'Aguardando uma nova atualização do servidor.' : !s.botEnabled ? 'Ative quando quiser retomar as respostas automáticas.' : !s.connected ? 'Conecte o WhatsApp para a Luna receber seus clientes.' : !s.openaiConfigured || !s.barbershopConfigured ? 'Confira as integrações para completar a configuração.' : 'WhatsApp conectado e integrações configuradas. Tudo pronto para boas conversas.';
  const heroToggle = $('[data-toggle-bot] span'); heroToggle.textContent = s.botEnabled ? 'Pausar a Luna' : 'Ativar a Luna';
  $('#bot-switch').setAttribute('aria-checked', String(s.botEnabled));
  $$('[data-toggle-bot]').forEach(button => { button.disabled = mutating || !fresh; });
  badge('#overview-wa', fresh ? stateNames[s.state] ?? 'Verificando' : 'Sem atualização', fresh && s.connected, fresh && !s.connected);
  badge('#overview-ai', s.openaiConfigured ? 'Configurada' : 'Configurar', s.openaiConfigured, !s.openaiConfigured);
  badge('#overview-site', s.barbershopConfigured ? 'Configurada' : 'Configurar', s.barbershopConfigured, !s.barbershopConfigured);
  badge('#connection-badge', fresh ? stateNames[s.state] ?? 'Verificando' : 'Sem atualização', fresh && s.connected, !s.connected);
  $('#nav-connection-dot').classList.toggle('connected', fresh && s.connected);
  $('#uncertain-banner').hidden = !overview.counts.uncertain;
  $('#uncertain-banner').textContent = `${overview.counts.uncertain} pedido(s) aguardando resultado do site. A Luna preserva esses pedidos e permite ao cliente conferir respondendo CONFIRMAR.`;
  $('#setting-owner').textContent = overview.owner; $('#setting-timezone').textContent = overview.timezone; $('#setting-model').textContent = overview.model;
  $('#site-link').href = overview.siteUrl;
  $('#connect-button').disabled = mutating || !fresh || s.connected || ['connecting', 'qr', 'reconnecting'].includes(s.state);
  $('#connect-button span').textContent = s.connected ? 'WhatsApp conectado' : s.state === 'qr' ? 'Aguardando leitura' : ['connecting', 'reconnecting'].includes(s.state) ? 'Conectando...' : 'Gerar QR Code';
  $('#disconnect-button').disabled = mutating || !fresh || ['disconnected', 'logged_out'].includes(s.state);
  $('#unlink-button').disabled = mutating || !fresh;
  $('#qr-title').textContent = !fresh ? 'Conexão com painel perdida' : s.connected ? 'Tudo conectado!' : ['connecting', 'reconnecting'].includes(s.state) ? 'Conectando ao WhatsApp...' : s.state === 'error' ? 'Vamos tentar novamente?' : s.state === 'qr' ? 'Preparando seu QR Code...' : 'Vamos conectar?';
  $('#qr-description').textContent = !fresh ? 'O QR foi ocultado. Aguarde a reconexão ao painel.' : s.connected ? 'O WhatsApp está vinculado. Você pode controlar a Luna pela visão geral.' : s.state === 'error' ? 'Verifique os aparelhos conectados no WhatsApp e tente conectar novamente.' : ['connecting', 'reconnecting', 'qr'].includes(s.state) ? 'O QR aparecerá assim que estiver disponível.' : 'Gere o QR Code para vincular o WhatsApp da barbearia.';
  if (!fresh || s.connected || !s.qrAvailable) resetQr();
  if (!qrExpiry) $('#qr-expiry').textContent = s.connected ? 'Conexão confirmada pelo WhatsApp.' : 'O QR Code aparece aqui e se atualiza automaticamente.';
}
async function refresh() {
  if (!authenticated || fetching) return;
  clearTimeout(pollTimer); fetching = true; const epoch = sessionEpoch;
  try {
    const data = await api('panel/overview');
    if (!authenticated || epoch !== sessionEpoch) return;
    overview = data; fresh = true; $('#offline-banner').hidden = true;
    $('#live-indicator').textContent = 'Atualizado agora'; $('#live-indicator').className = 'live-indicator fresh'; renderStatus();
    if (currentPage === 'connection' && data.status.qrAvailable && !data.status.connected && !document.hidden) {
      try {
        const qr = await api('whatsapp/qrcode');
        if (authenticated && !document.hidden && epoch === sessionEpoch && currentPage === 'connection' && Date.parse(qr.expiresAt) > Date.now() && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(qr.qrDataUrl)) {
          $('#qr-image').src = qr.qrDataUrl; $('#qr-image').hidden = false; $('#qr-placeholder').hidden = true; qrExpiry = Date.parse(qr.expiresAt);
        }
      } catch { resetQr(); }
    }
  } catch (error) {
    if (authenticated) { fresh = false; resetQr(); $('#offline-banner').hidden = false; $('#live-indicator').textContent = 'Sem atualização'; $('#live-indicator').className = 'live-indicator stale'; renderStatus(); }
  } finally {
    fetching = false;
    if (authenticated && !document.hidden) pollTimer = setTimeout(refresh, 5000);
  }
}
function navigate() {
  currentPage = Object.hasOwn(pages, location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  $$('[data-page]').forEach(section => { section.hidden = section.dataset.page !== currentPage; });
  $$('[data-nav]').forEach(link => { const active = link.dataset.nav === currentPage; link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  $('#page-label').textContent = pages[currentPage]; document.title = `${pages[currentPage]} · Luna Studio`;
  if (currentPage !== 'connection') resetQr();
  if (authenticated) { void refresh(); if (currentPage === 'teachings') void loadTeachings().catch(error => toast(error.message, true)); }
  window.scrollTo({ top: 0 });
}
function node(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; }
function renderTeachings() {
  const query = $('#lesson-search').value.toLocaleLowerCase('pt-BR'); const category = $('#lesson-filter').value;
  const filtered = teachings.lessons.filter(item => (category === 'all' || item.category === category) && `${item.title} ${item.content}`.toLocaleLowerCase('pt-BR').includes(query));
  $('#lesson-count').textContent = `${teachings.lessons.length} ensinamento${teachings.lessons.length === 1 ? '' : 's'} · ${teachings.lessons.filter(item => item.enabled).length} ativo(s)`;
  $('#saved-label').textContent = teachings.updatedAt ? `Salvo ${new Date(teachings.updatedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '';
  $('#lesson-empty').hidden = teachings.lessons.length !== 0; $('#no-results').hidden = !teachings.lessons.length || filtered.length !== 0;
  const list = $('#lesson-list'); list.replaceChildren();
  for (const item of filtered) {
    const card = node('article', `lesson-card${item.enabled ? '' : ' disabled'}`); const top = node('div', 'lesson-top');
    top.append(node('span', 'category-pill', categories[item.category]));
    const toggle = node('button', 'switch'); toggle.type = 'button'; toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(item.enabled)); toggle.setAttribute('aria-label', `Ativar ensinamento: ${item.title}`); toggle.append(node('span')); toggle.disabled = mutating;
    toggle.addEventListener('click', () => void changeLessons(teachings.lessons.map(lesson => lesson.id === item.id ? { ...lesson, enabled: !lesson.enabled } : lesson), item.enabled ? 'Ensinamento desativado.' : 'Ensinamento ativado.').catch(error => toast(error.message, true)));
    top.append(toggle); card.append(top, node('h3', '', item.title), node('p', '', item.content));
    const actions = node('div', 'lesson-actions'); const edit = node('button', '', 'Editar ensinamento ↗'); edit.type = 'button'; edit.addEventListener('click', () => openLesson(item));
    const remove = node('button', '', 'Excluir'); remove.type = 'button'; remove.disabled = mutating;
    remove.addEventListener('click', async () => { if (await confirmAction('Excluir ensinamento?', `“${item.title}” deixará de fazer parte das orientações da Luna.`, 'Excluir')) await changeLessons(teachings.lessons.filter(lesson => lesson.id !== item.id), 'Ensinamento excluído.').catch(error => toast(error.message, true)); });
    actions.append(edit, remove); card.append(actions); list.append(card);
  }
}
async function loadTeachings() { const epoch = sessionEpoch; const result = await api('panel/teachings'); if (authenticated && epoch === sessionEpoch) { teachings = result; renderTeachings(); } }
async function changeLessons(lessons, message) {
  if (mutating || !authenticated) throw new Error('Aguarde a operação atual terminar.');
  mutating = true; renderStatus(); renderTeachings();
  try { teachings = await api('panel/teachings', { method: 'PUT', body: JSON.stringify({ revision: teachings.revision, lessons }) }); renderTeachings(); toast(message); void refresh(); }
  catch (error) { if (error.status === 409) await loadTeachings(); throw error; }
  finally { mutating = false; renderStatus(); renderTeachings(); }
}
function openLesson(item = null) {
  if (mutating) return;
  editingId = item?.id ?? null; $('#lesson-dialog-title').textContent = editingId ? 'Editar ensinamento' : 'Novo ensinamento';
  $('#lesson-title').value = item?.title ?? ''; $('#lesson-category').value = item?.category ?? 'atendimento'; $('#lesson-content').value = item?.content ?? ''; $('#lesson-enabled').checked = item?.enabled ?? true;
  $('#lesson-content').placeholder = 'Escreva uma orientação clara, como se estivesse ensinando alguém da sua equipe.';
  $('#lesson-error').hidden = true; updateCounter(); $('#lesson-dialog').showModal();
}
function updateCounter() { $('#content-count').textContent = `${$('#lesson-content').value.length} / 1500`; }
function newLessonId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // getRandomValues também funciona na prévia por IP local sem HTTPS.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const value = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
function confirmAction(title, description, label) {
  $('#confirm-title').textContent = title; $('#confirm-description').textContent = description; $('#confirm-action').textContent = label;
  const dialog = $('#confirm-dialog'); dialog.returnValue = ''; dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}
async function mutate(action, success) {
  if (mutating || !fresh) return;
  mutating = true; renderStatus();
  try { await action(); toast(success); await refresh(); }
  catch (error) { toast(error.message, true); }
  finally { mutating = false; renderStatus(); }
}
async function logout() {
  try { await api('panel/session', { method: 'DELETE' }); showLogin(); $('#access-key').focus(); }
  catch (error) { toast(error.message, true); }
}
async function enter() {
  authenticated = true; sessionEpoch++; $('#login-screen').hidden = true; $('#workspace').hidden = false;
  navigate(); await loadTeachings().catch(error => toast(error.message, true));
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#login-error').hidden = true; $('#login-button').disabled = true;
  const key = $('#access-key').value.trim(); $('#access-key').value = '';
  try { await api('panel/session', { method: 'POST', key, body: '{}' }); await enter(); }
  catch (error) { $('#login-error').textContent = error.message; $('#login-error').hidden = false; }
  finally { $('#login-button').disabled = false; }
});
$$('[data-toggle-bot]').forEach(button => button.addEventListener('click', () => void mutate(() => api('bot', { method: 'PUT', body: JSON.stringify({ enabled: !overview.status.botEnabled }) }), overview.status.botEnabled ? 'Luna pausada.' : 'Luna ativada.')));
$$('[data-wa]').forEach(button => button.addEventListener('click', async () => {
  const action = button.dataset.wa;
  if (action === 'disconnect' && !await confirmAction('Desconectar WhatsApp?', 'A Luna ficará sem conexão. Você pode reconectar depois, preservando o vínculo.', 'Desconectar')) return;
  resetQr(); await mutate(() => api(`whatsapp/${action}`, { method: 'POST', body: '{}' }), action === 'connect' ? 'Conexão iniciada. Aguarde o QR Code.' : 'WhatsApp desconectado.');
}));
$('#unlink-button').addEventListener('click', async () => {
  if (await confirmAction('Trocar o número do WhatsApp?', 'O vínculo atual será removido. Depois, gere um novo QR Code e escaneie com o número que deseja conectar.', 'Remover vínculo')) {
    resetQr(); await mutate(() => api('whatsapp/logout', { method: 'POST', body: '{}' }), 'Vínculo removido. Gere um novo QR Code.');
  }
});
$('#check-integration').addEventListener('click', async () => {
  const button = $('#check-integration'); button.disabled = true; $('#integration-result').textContent = 'Consultando o catálogo da barbearia...';
  try { const result = await api('integrations/barbershop/check'); $('#integration-result').textContent = `Catálogo acessível. ${result.professionals} profissional(is) encontrado(s). A gravação de reservas é verificada durante uma marcação confirmada.`; }
  catch (error) { $('#integration-result').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#add-lesson').addEventListener('click', () => openLesson()); $('[data-new-lesson]').addEventListener('click', () => openLesson());
$('#lesson-content').addEventListener('input', updateCounter); $('#lesson-search').addEventListener('input', renderTeachings); $('#lesson-filter').addEventListener('change', renderTeachings);
$$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => $('#lesson-dialog').close()));
const templates = {
  tone: { title: 'Nosso jeito de conversar', category: 'atendimento', content: 'Fale de forma próxima e natural, com mensagens curtas. Use “meu irmão” de vez em quando e finalize com 💈. Evite repetir saudações em cada resposta.' },
  place: { title: 'Como chegar à barbearia', category: 'informacoes', content: '' },
  care: { title: 'Quando o cliente estiver em dúvida', category: 'regras', content: 'Acolha a dúvida com simpatia. Explique as opções disponíveis no catálogo e faça uma pergunta por vez, sem pressionar o cliente a decidir.' },
};
$$('[data-template]').forEach(button => button.addEventListener('click', () => { openLesson(templates[button.dataset.template]); if (button.dataset.template === 'place') { $('#lesson-content').placeholder = 'Informe o endereço real, ponto de referência e orientações úteis para chegar.'; $('#lesson-content').focus(); } }));
$('#lesson-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#lesson-error').hidden = true; $('#save-lesson').disabled = true;
  try {
    const lesson = { id: editingId ?? newLessonId(), title: $('#lesson-title').value.trim(), category: $('#lesson-category').value, content: $('#lesson-content').value.trim(), enabled: $('#lesson-enabled').checked };
    if (!lesson.title || !lesson.content) throw new Error('Preencha o título e a orientação.');
    if (editingId && !teachings.lessons.some(item => item.id === editingId)) throw new Error('Esse ensinamento foi excluído em outra sessão. Feche e adicione um novo.');
    const lessons = editingId ? teachings.lessons.map(item => item.id === editingId ? lesson : item) : [...teachings.lessons, lesson];
    await changeLessons(lessons, 'Ensinamento salvo. Vale nas próximas respostas.'); $('#lesson-dialog').close();
  } catch (error) { $('#lesson-error').textContent = error.message; $('#lesson-error').hidden = false; }
  finally { $('#save-lesson').disabled = false; }
});
$('#logout-button').addEventListener('click', logout); $('#settings-logout').addEventListener('click', logout);
window.addEventListener('hashchange', navigate);
document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(pollTimer); resetQr(); } else if (authenticated) void refresh(); });
setInterval(() => {
  if (!qrExpiry) return;
  const seconds = Math.max(0, Math.ceil((qrExpiry - Date.now()) / 1000));
  if (!seconds) { resetQr(); $('#qr-expiry').textContent = 'QR expirado. Aguardando a próxima atualização...'; void refresh(); }
  else $('#qr-expiry').textContent = `QR válido por ${seconds}s · atualização automática`;
}, 1000);
try { await api('panel/overview'); await enter(); } catch { showLogin(); }
