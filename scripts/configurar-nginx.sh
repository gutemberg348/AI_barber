#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

if [ "$(id -u)" -ne 0 ]; then
    echo 'Execute: sudo sh scripts/configurar-nginx.sh' >&2
    exit 1
fi
command -v nginx >/dev/null 2>&1 || { echo 'Nginx não encontrado no host da VPS.' >&2; exit 1; }
command -v certbot >/dev/null 2>&1 || {
    echo 'Instale o Certbot e o plugin Nginx. Em Ubuntu/Debian: apt-get install certbot python3-certbot-nginx' >&2
    exit 1
}
# Não alterar uma configuração global que já esteja inválida.
nginx -t

luna_source=deploy/nginx-ia.goodstyler.com.conf
luna_link=
if [ -d /etc/nginx/sites-available ] && [ -d /etc/nginx/sites-enabled ]; then
    luna_target=/etc/nginx/sites-available/ia.goodstyler.com.conf
    luna_link=/etc/nginx/sites-enabled/ia.goodstyler.com.conf
else
    luna_target=/etc/nginx/conf.d/ia.goodstyler.com.conf
fi

if [ -e "$luna_target" ] || [ -L "$luna_target" ]; then
    echo "Configuração existente preservada: $luna_target"
    echo 'Confira se ela encaminha ia.goodstyler.com para 127.0.0.1:3308 antes de prosseguir.'
    echo 'Para emitir/conferir o SSL: sudo certbot --nginx -d ia.goodstyler.com --redirect'
    exit 0
fi
if [ -n "$luna_link" ] && { [ -e "$luna_link" ] || [ -L "$luna_link" ]; }; then
    echo "Já existe uma entrada em $luna_link. Confira-a antes de instalar este domínio." >&2
    exit 1
fi
if nginx -T 2>/dev/null | grep -E '^[[:space:]]*server_name[[:space:]]' | grep -Eq '(^|[[:space:]])ia[.]goodstyler[.]com([[:space:];]|$)'; then
    echo 'O domínio ia.goodstyler.com já está em outra configuração do Nginx. Ajuste nela o proxy_pass para http://127.0.0.1:3308; não foi criado um bloco duplicado.' >&2
    exit 1
fi

install -m 644 "$luna_source" "$luna_target"
if [ -n "$luna_link" ]; then ln -s "$luna_target" "$luna_link"; fi
if ! nginx -t; then
    # Remove somente os arquivos que esta execução acabou de criar.
    if [ -n "$luna_link" ]; then rm -f -- "$luna_link"; fi
    rm -f -- "$luna_target"
    echo 'Configuração nova removida porque o teste Nginx falhou. Os outros sites foram preservados.' >&2
    exit 1
fi
nginx -s reload
echo 'Domínio instalado. O Certbot solicitará os dados necessários para emitir o certificado.'
certbot --nginx -d ia.goodstyler.com --redirect
nginx -t
echo 'Painel: https://ia.goodstyler.com/painel | upstream local: 127.0.0.1:3308'
