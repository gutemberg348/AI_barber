# Luna na VPS com Nginx — porta 3308

O Docker sobe a Luna (painel, API e bot) em **127.0.0.1:3308**. O Nginx existente continua nas portas 80/443 e encaminha o domínio para essa porta local. O Caddy ficou opcional no perfil `caddy` e não inicia no `docker compose up` normal.

| Configuração | Valor |
| --- | --- |
| Painel | https://ia.goodstyler.com/painel |
| Upstream no host da VPS | http://127.0.0.1:3308 |
| Porta dentro do container | 3000; não altere `PORT` no `.env` para 3308 |
| API consultada pela Luna | https://goodstyler.com/admin/api_ia.php |
| Arquivo do domínio | `deploy/nginx-ia.goodstyler.com.conf` |

## Preparar

Aponte o registro DNS **A** de `ia.goodstyler.com` para o IPv4 da VPS. Um registro AAAA, se existir, também precisa estar correto. O Nginx precisa estar acessível em 80/443 para validar o domínio e servir HTTPS. Não precisa liberar 3308 publicamente.

Tenha Docker Engine, Compose, Nginx instalado no host e Certbot com plugin Nginx. Em Ubuntu/Debian, se faltar Certbot/plugin:

```sh
sudo apt-get update
sudo apt-get install certbot python3-certbot-nginx
```

Envie o projeto completo, incluindo `deploy/`, `scripts/`, `src/`, `public/`, `prompts/`, Dockerfile, Compose, arquivos de pacote e os modelos `.env`. Não precisa enviar `node_modules`. Estas instruções são para Nginx no host; um Nginx em outro container exige adaptar a rede/upstream, pois o loopback dele não é o da VPS.

## Tokens e subida

Se já copiou seu `.env`, o preparador o preserva. Para criar um novo com as chaves internas geradas:

```sh
sh scripts/preparar-vps.sh
nano .env
```

Preencha `OPENAI_API_KEY` e `BARBEARIA_API_TOKEN`. Este último precisa corresponder ao token aceito pelo PHP publicado (`BARBEARIA_IA_TOKEN`). `ADMIN_API_TOKEN` é a chave do painel. Preserve `DATA_ENCRYPTION_KEY` ao migrar um banco existente. A URL da API já está no modelo; não a substitua pelo domínio do painel.

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:3308/healthz
sudo sh scripts/configurar-nginx.sh
```

O script cria a configuração do domínio em `sites-available` e ativa em `sites-enabled`, ou usa `conf.d` se essas pastas não existirem. Testa o Nginx antes de recarregar. Se a nova configuração for inválida, remove somente os arquivos recém-criados. Preserva arquivos existentes e evita cadastrar o mesmo domínio em outro bloco.

Depois executa `certbot --nginx -d ia.goodstyler.com --redirect`. O Certbot solicita os dados necessários e adiciona HTTPS e redirecionamento. O DNS precisa estar correto. O certificado pertence ao Nginx/Certbot da VPS; a Luna não emite SSL neste modo. Não ative Caddy junto do Nginx nas mesmas portas.

Se a emissão falhar, confira o erro e repita:

```sh
sudo certbot --nginx -d ia.goodstyler.com --redirect
sudo nginx -t
sudo certbot renew --dry-run
```

Confira se a instalação do Certbot tem timer/tarefa de renovação habilitado. Se o domínio já existe em outro arquivo Nginx, ajuste nele `proxy_pass http://127.0.0.1:3308;`, preservando o SSL existente. O modelo completo está em `deploy/nginx-ia.goodstyler.com.conf`.

Abra **https://ia.goodstyler.com/painel**, entre com `ADMIN_API_TOKEN` e leia o QR na tela WhatsApp. O login de produção exige HTTPS; o endereço HTTP local serve para diagnóstico. O Compose desativa a impressão do QR nos logs.

## Atualização e dados

```sh
docker compose logs --tail=80 luna
docker compose exec luna node scripts/diagnose-site.js
docker compose up -d --build
```

Depois de editar `.env`, use `up -d`; apenas `restart` não atualiza as variáveis. Se um Caddy deste mesmo projeto estava ativo de uma configuração anterior, pare somente ele com `docker compose stop caddy`. Não pare o Nginx que atende outros sites.

O volume `luna_data` preserva sessão, ensinamentos e operações. Não execute `docker compose down -v`. Preserve o nome/pasta do projeto Compose e a chave de criptografia ao atualizar. Faça backup do volume e da chave. Os volumes Caddy antigos continuam declarados para preservação, mas não são usados no modo Nginx.

Para migrar o SQLite local, pare o bot local antes de copiar todos os arquivos do banco para o volume e mantenha a mesma chave. Um volume novo exige pareamento novamente. Execute uma única réplica por banco/sessão.

Erro de porta ocupada em 3308 exige conferir o serviço que a usa. Um 502 no Nginx pede conferir `127.0.0.1:3308/healthz` e os logs da Luna. Processo saudável não comprova saldo/validade OpenAI ou gravação de reserva: confira as integrações e faça um atendimento controlado.

Referências: [proxy Nginx](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass), [Certbot com Nginx](https://eff-certbot.readthedocs.io/en/stable/using.html#nginx) e [perfis Compose](https://docs.docker.com/compose/how-tos/profiles/).
