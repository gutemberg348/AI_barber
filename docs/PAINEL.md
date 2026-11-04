# Painel Luna Studio

O painel acompanha o backend Node.js em **`/painel`**. Endereço padrão no computador que executa o projeto: **http://localhost:3000/painel**, usando a porta definida em `PORT`. Não precisa instalar ou compilar outro frontend.

## Entrar e usar

1. Reinicie o Node com `npm start`. No Docker, reconstrua a imagem para incluir `public/`.
2. Abra `/painel` e use o valor de `ADMIN_API_TOKEN` do `.env` como chave de acesso. Não use a chave da OpenAI nem o token do site.
3. Em **WhatsApp**, clique em **Gerar QR Code**. No celular da barbearia, abra WhatsApp → Aparelhos conectados → Conectar um aparelho. Escaneie o QR em outra tela. A conexão e o QR são atualizados automaticamente; códigos expirados são ocultados.
4. Em **Visão geral** ou **Configurações**, pause ou ative a Luna. Pausar interrompe novos envios automáticos; respostas já preparadas podem ser enviadas na retomada. Uma operação já enviada ao site pode terminar. Reservas existentes são preservadas.
5. Em **Ensinamentos**, adicione título, categoria e orientação. É possível editar, excluir, pesquisar e ativar/desativar cada item. Somente ensinamentos ativos entram nas próximas chamadas da IA, sem reinício. Uma resposta já em processamento pode usar orientações anteriores.

Os ensinamentos ficam no SQLite criptografado do projeto. Limites: 30 itens, 1.500 caracteres por orientação e 18.000 no total. Duas abas não podem sobrescrever silenciosamente alterações: um conflito exige conferir a lista atualizada antes de salvar novamente. Os ensinamentos complementam o atendimento; catálogo, preços, vagas e reservas continuam vindo do site. As regras de confirmação do backend continuam obrigatórias.

As contagens são reais: conversas no período de memória configurado, pedidos preparados esperando confirmação e ensinamentos ativos. Não são métricas de vendas. “Configurada” indica presença de credenciais; **Verificar integração** consulta o catálogo, sem criar reservas. A prontidão combina conexão e configuração, não testa a disponibilidade externa de todos os serviços.

## Acessar online e no celular

Na VPS com Nginx existente, o Docker publica a Luna em **127.0.0.1:3308**. O Nginx encaminha **https://ia.goodstyler.com/painel** para essa porta. Siga [DEPLOY_VPS.md](DEPLOY_VPS.md) para preparar o `.env`, subir o container e executar o configurador de domínio/SSL. O Caddy é opcional e não inicia por padrão.

O painel precisa chegar ao **mesmo servidor Node que mantém o WhatsApp conectado**. Enviar apenas HTML para a hospedagem PHP não conecta o painel ao bot.

Na VPS/hospedagem, mantenha o Node em execução e configure um domínio com **HTTPS** e proxy reverso para a porta interna do backend. Abra `https://SEU-DOMINIO/painel`. Use `NODE_ENV=production`; os cookies de produção exigem HTTPS. O proxy deve encaminhar caminhos e cookies ao Node. O domínio não precisa expor tokens ou a chave da OpenAI.

Exemplo de trecho Nginx dentro do servidor HTTPS existente, com Node no mesmo host:

```nginx
location / {
    proxy_pass http://127.0.0.1:3308;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Se o proxy estiver em outro container, ajuste o destino para o serviço Node da rede interna. Não há implantação automática ou domínio criado por esta atualização. O QR só existe quando o WhatsApp solicitar pareamento; uma sessão vinculada normalmente reconecta sem QR.

Para testar na rede local, configure `HOST` para a interface de rede apropriada e use o IP desse computador no celular. `localhost` no celular aponta para o próprio celular. Prefira HTTPS para acesso remoto. Para ler o QR com o mesmo celular do WhatsApp, abra o painel em outra tela.

## Acesso e endpoints

Login: `POST /api/v1/panel/session` com `Authorization: Bearer <ADMIN_API_TOKEN>`. Cria sessão de 8 horas em cookie HttpOnly e SameSite=Strict. A chave não vai para localStorage, URL ou arquivos públicos. Sair invalida a sessão; reiniciar o Node invalida todas as sessões do painel. A API continua aceitando Bearer para integrações existentes.

| Método | Caminho | Uso |
| --- | --- | --- |
| DELETE | `/api/v1/panel/session` | Sair |
| GET | `/api/v1/panel/overview` | Estado e contagens sem dados de clientes |
| GET | `/api/v1/panel/teachings` | Lista, revisão e data de atualização |
| PUT | `/api/v1/panel/teachings` | Salvar `{revision, lessons}`; conflito retorna 409 |

Somente login e assets são públicos. Dados, QR e controles exigem sessão ou Bearer. Mutações com cookie exigem `X-Luna-Panel: 1`, enviado pelo frontend. Sem CORS aberto para sites externos. QR não é armazenado no navegador e é ocultado ao sair, expirar, perder conexão ou trocar de tela.

## Prévia isolada para desenvolvimento

`node scripts/preview-panel.js` abre **http://127.0.0.1:3467/painel** com banco em memória, sem clientes, IA ou WhatsApp reais. Chave fictícia exclusivamente dessa prévia: `luna-preview-local-only-1234567890`. O QR dela é ilustrativo e não conecta ao WhatsApp. Não publique essa prévia. Use `npm start` para o painel real.
