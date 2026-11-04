#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
command -v docker >/dev/null 2>&1 || { echo 'Instale Docker Engine e Docker Compose na VPS antes de continuar.' >&2; exit 1; }
docker compose version >/dev/null
# Não exige Node instalado na VPS e não inicia o bot nem faz chamadas externas.
docker run --rm --user "$(id -u):$(id -g)" -v "$(pwd):/workspace" -w /workspace node:22-bookworm-slim node scripts/setup-vps.js
echo 'Agora edite .env e execute: docker compose up -d --build'
echo 'Na VPS com Nginx, configure domínio/SSL: sudo sh scripts/configurar-nginx.sh'
