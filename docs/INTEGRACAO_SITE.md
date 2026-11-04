# Integrar QR Code e status ao painel existente

O backend Node está neste repositório. O site PHP continua sendo outro projeto. O exemplo não foi instalado no site real porque seu código e sua sessão de login não fazem parte deste workspace.

## Três segredos diferentes

| Variável | Onde fica | Uso |
|---|---|---|
| `OPENAI_API_KEY` | Somente no Node | Node chama OpenAI |
| `BARBEARIA_API_TOKEN` | Node; mesmo valor de `BARBEARIA_IA_TOKEN` no PHP | Node consulta e altera a agenda |
| `ADMIN_API_TOKEN` | Node; mesmo valor de `LUNA_ADMIN_API_TOKEN` no PHP | Painel chama QR/status/controle do Node |

Nenhum desses tokens vai no HTML, JavaScript, URL ou prompt da Luna. O QR é sensível e só deve aparecer ao administrador autenticado.

## Instalar o exemplo PHP

1. Copie `examples/whatsapp-painel.php` para a pasta administrativa do seu site.
2. Configure no ambiente do PHP:

   ```dotenv
   LUNA_BACKEND_URL=http://127.0.0.1:3000
   LUNA_ADMIN_API_TOKEN=valor_de_ADMIN_API_TOKEN_do_node
   LUNA_ADMIN_SESSION_KEY=chave_da_sessao_do_administrador
   ```

3. Descubra qual chave o **login administrativo real** guarda em `$_SESSION` (ex.: `admin_id`). Use essa chave em `LUNA_ADMIN_SESSION_KEY`. O exemplo nega acesso se a variável estiver vazia ou a sessão não contiver um valor verdadeiro. Se o site utiliza autorização por função/perfil, substitua esse teste pelo guard administrativo existente; não use uma sessão de cliente comum.
4. Se o seu site usa nome/caminho de cookie de sessão personalizado ou um bootstrap de autenticação, carregue esse bootstrap antes de usar a sessão no exemplo.
5. Acesse o arquivo depois de entrar como administrador. Clique em **Conectar WhatsApp**, espere o QR e leia pelo celular.

Requer PHP 8+ com cURL e sessão habilitados. `LUNA_BACKEND_URL` é a URL do Node **vista pelo servidor PHP**, não pelo computador do administrador. Em máquinas diferentes use HTTPS com proxy reverso; `127.0.0.1` aponta sempre para a própria máquina/contêiner. TLS do cURL fica habilitado e redirecionamentos não são seguidos.

O arquivo contém um proxy com rotas permitidas explicitamente, proteção CSRF nos POSTs, imagem via data URL, atualização a cada 5 segundos e ocultação do QR em falhas. O token administrativo nunca é devolvido ao navegador. O botão “Pausar conexão” preserva a sessão; “Desvincular aparelho” exige novo pareamento.

## Integração com um frontend próprio

Implemente no backend do site rotas equivalentes a estas:

```text
Navegador autenticado -> backend do site -> Node (Bearer ADMIN_API_TOKEN)
GET  status          -> GET  /api/v1/whatsapp/status
GET  qrcode          -> GET  /api/v1/whatsapp/qrcode
POST conectar        -> POST /api/v1/whatsapp/connect
POST desconectar     -> POST /api/v1/whatsapp/disconnect
POST desvincular     -> POST /api/v1/whatsapp/logout
```

Após chamar `connect`, o retorno inicial costuma ser `connecting`; isso ainda não contém QR. Faça polling. Quando `qrAvailable=true`, consulte `qrcode` e use `qrDataUrl` como `src` da imagem. `expiresAt` informa a validade. `409 qr_indisponivel` significa que o QR não existe mais ou ainda não foi emitido: volte a consultar status. Quando `connected=true`, esconda a imagem. Em erros de rede não deixe um indicador antigo de “online” visível como se fosse atual.

Estados possíveis: `disconnected`, `connecting`, `qr`, `connected`, `reconnecting`, `logged_out`, `error`.

`ready=true` é configuração + conexão + bot habilitado. Uma chave inválida ou falta de saldo da OpenAI não é detectada por esse campo. `GET /api/v1/integrations/barbershop/check` faz uma consulta real ao site, sem gravar reservas. Erro `401` dos endpoints Node significa token administrativo inválido; erro `502` do check significa problema ao consultar o site.

Exemplo de resposta de QR:

```json
{
  "qr": "conteudo_temporario_do_qr",
  "qrDataUrl": "data:image/png;base64,...",
  "expiresAt": "2026-10-23T18:30:00.000Z",
  "state": "qr"
}
```

## Consultar diretamente para diagnóstico

PowerShell — substitua o placeholder pelo token do `.env` local, sem publicá-lo:

```powershell
$headers = @{ Authorization = 'Bearer SEU_ADMIN_API_TOKEN' }
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/api/v1/whatsapp/connect' -Headers $headers
Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/v1/whatsapp/status' -Headers $headers
Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/v1/integrations/barbershop/check' -Headers $headers
```

Para mostrar a imagem do endpoint `.png` no navegador, faça o backend do site encaminhá-la após conferir a sessão; uma tag `<img>` direta não consegue enviar o Bearer header. O exemplo usa JSON/data URL para evitar esse problema.
