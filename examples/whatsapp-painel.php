<?php
declare(strict_types=1);
// Copie para a área administrativa do site. Veja docs/INTEGRACAO_SITE.md.
session_start();
$adminSessionKey = getenv('LUNA_ADMIN_SESSION_KEY') ?: '';
if ($adminSessionKey === '' || empty($_SESSION[$adminSessionKey])) {
    http_response_code(403);
    exit('Acesso administrativo necessário. Configure LUNA_ADMIN_SESSION_KEY conforme o login do seu site.');
}
$backend = rtrim(getenv('LUNA_BACKEND_URL') ?: 'http://127.0.0.1:3000', '/');
$token = getenv('LUNA_ADMIN_API_TOKEN') ?: '';
if ($token === '') { http_response_code(503); exit('Configure LUNA_ADMIN_API_TOKEN no servidor PHP.'); }
$_SESSION['luna_csrf'] ??= bin2hex(random_bytes(32));
$csrf = $_SESSION['luna_csrf'];
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('X-Frame-Options: SAMEORIGIN');

if (isset($_GET['action'])) {
    header('Content-Type: application/json; charset=utf-8');
    $routes = [
        'status' => ['GET', '/api/v1/whatsapp/status'],
        'qrcode' => ['GET', '/api/v1/whatsapp/qrcode'],
        'connect' => ['POST', '/api/v1/whatsapp/connect'],
        'disconnect' => ['POST', '/api/v1/whatsapp/disconnect'],
        'logout' => ['POST', '/api/v1/whatsapp/logout'],
    ];
    $action = (string) $_GET['action'];
    if (!isset($routes[$action])) { http_response_code(404); exit('{"error":"acao_invalida"}'); }
    [$method, $path] = $routes[$action];
    if ($_SERVER['REQUEST_METHOD'] !== $method) { http_response_code(405); exit('{"error":"metodo_invalido"}'); }
    if ($method === 'POST' && !hash_equals($csrf, $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '')) {
        http_response_code(403); exit('{"error":"csrf_invalido"}');
    }
    session_write_close();
    $curl = curl_init($backend . $path);
    curl_setopt_array($curl, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $token, 'Accept: application/json'],
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
    ]);
    $body = curl_exec($curl);
    $status = (int) curl_getinfo($curl, CURLINFO_HTTP_CODE);
    curl_close($curl);
    if ($body === false || $status === 0) { http_response_code(502); exit('{"error":"backend_indisponivel"}'); }
    http_response_code($status);
    echo $body;
    exit;
}
$nonce = base64_encode(random_bytes(18));
header("Content-Security-Policy: default-src 'none'; script-src 'nonce-$nonce'; style-src 'nonce-$nonce'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'");
session_write_close();
?>
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Luna · WhatsApp da barbearia</title>
  <style nonce="<?= $nonce ?>">
    *{box-sizing:border-box}body{margin:0;background:#f5f4f0;color:#182d29;font:16px/1.55 system-ui,sans-serif}
    main{max-width:720px;margin:7vh auto;padding:32px;background:white;border:1px solid #dedfd8;border-radius:20px}
    small{letter-spacing:.14em;font-weight:700;color:#557367}h1{font-size:32px;margin:12px 0}p{color:#52615a}
    #state{display:inline-block;padding:7px 13px;background:#edf2ee;border-radius:30px;font-weight:650}
    #qr{display:block;margin:24px auto;max-width:100%}#qr[hidden]{display:none}button{border:1px solid #ccd8d0;border-radius:9px;padding:12px 16px;background:white;color:#173e30;font:inherit;cursor:pointer}
    button:first-child{background:#173e30;color:white}button:disabled{opacity:.5;cursor:wait}.actions{display:flex;gap:10px;flex-wrap:wrap}
    #message{min-height:26px}footer{margin-top:28px;border-top:1px solid #eee;padding-top:16px;font-size:14px}@media(max-width:760px){main{margin:20px;padding:24px}}
  </style>
</head>
<body><main>
  <small>LUNA / BARBEARIA</small>
  <h1>Seu atendimento no WhatsApp</h1>
  <span id="state" role="status">Consultando conexão…</span>
  <p id="integration"></p>
  <img id="qr" hidden width="320" height="320" alt="QR Code para conectar o WhatsApp da barbearia">
  <p>No WhatsApp da barbearia, abra <strong>Aparelhos conectados → Conectar um aparelho</strong> e leia o QR Code.</p>
  <div class="actions">
    <button data-action="connect">Conectar WhatsApp</button>
    <button data-action="disconnect">Pausar conexão</button>
    <button data-action="logout">Desvincular aparelho</button>
  </div>
  <p id="message" role="alert"></p>
  <footer>O status é atualizado a cada 5 segundos. “Pronto” indica conexão e configuração; a disponibilidade da OpenAI e do site depende dos serviços externos.</footer>
</main>
<script nonce="<?= $nonce ?>">
const csrf = <?= json_encode($csrf, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) ?>;
const state = document.getElementById('state');
const qr = document.getElementById('qr');
const message = document.getElementById('message');
const labels = { disconnected:'Desconectado', connecting:'Conectando…', qr:'Aguardando leitura do QR Code', connected:'WhatsApp conectado', reconnecting:'Reconectando…', logged_out:'Aparelho desvinculado', error:'Conexão requer atenção' };
async function request(action, method = 'GET') {
  const url = new URL(location.href); url.search = ''; url.searchParams.set('action', action);
  const response = await fetch(url, { method, headers: method === 'POST' ? {'X-CSRF-Token':csrf} : {}, cache:'no-store', signal:AbortSignal.timeout(25000) });
  const data = await response.json();
  if (!response.ok && !(action === 'qrcode' && response.status === 409)) throw new Error(data.error || 'Não foi possível acessar o serviço.');
  return data;
}
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const status = await request('status');
    state.textContent = labels[status.state] || status.state;
    document.getElementById('integration').textContent = status.ready ? 'Luna configurada e pronta para receber mensagens.' : !status.botEnabled ? 'Atendimento automático pausado pelo administrador.' : !status.openaiConfigured || !status.barbershopConfigured ? 'Preencha as chaves da OpenAI e da barbearia no servidor.' : 'Aguardando conexão do WhatsApp.';
    qr.hidden = true; qr.removeAttribute('src');
    if (status.qrAvailable) {
      const data = await request('qrcode');
      if (data.qrDataUrl) { qr.src = data.qrDataUrl; qr.hidden = false; }
    }
  } catch {
    state.textContent = 'Status indisponível'; qr.hidden = true; qr.removeAttribute('src');
    message.textContent = 'Não foi possível consultar o serviço. Verifique o login do painel e a conexão com o backend.';
  } finally { refreshing = false; }
}
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', async () => {
  if (button.dataset.action === 'logout' && !confirm('Desvincular? Será necessário ler um novo QR Code.')) return;
  document.querySelectorAll('button').forEach(b => b.disabled = true); message.textContent = '';
  try { await request(button.dataset.action, 'POST'); await refresh(); }
  catch (error) { message.textContent = error.message; }
  finally { document.querySelectorAll('button').forEach(b => b.disabled = false); }
}));
void refresh(); setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
</script></body></html>
