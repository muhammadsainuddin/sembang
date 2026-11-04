#!/usr/bin/env bash
set -euo pipefail
umask 077

app_dir="${1:-/var/www/private.aigeo.my/zbuddy-nodejs-server}"
env_file="$app_dir/.env"

[[ -d "$app_dir" ]] || { echo "Direktori aplikasi tidak dijumpai: $app_dir" >&2; exit 1; }
[[ -f "$app_dir/.env.example" ]] || { echo ".env.example tidak dijumpai dalam $app_dir" >&2; exit 1; }

cd "$app_dir"
if [[ ! -f "$env_file" ]]; then
  cp .env.example "$env_file"
fi
chmod 600 "$env_file"

set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$env_file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$env_file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$env_file"
  fi
}

set_env SEMBANG_DOMAIN private.aigeo.my
set_env SMTP_HOST smtp.gmail.com
set_env SMTP_PORT 587
set_env SMTP_SECURE false
set_env SMTP_USER mscreative.my@gmail.com
set_env SMTP_FROM "'Zbuddy <mscreative.my@gmail.com>'"
set_env MAX_USERS 2

if ! grep -Eq '^AUTH_SECRET=.{43,}$' "$env_file"; then
  set_env AUTH_SECRET "$(openssl rand -hex 32)"
fi

read -rsp 'Masukkan Google App Password BAHARU: ' gmail_app_password
printf '\n'
gmail_app_password="${gmail_app_password// /}"
if [[ ${#gmail_app_password} -ne 16 ]]; then
  unset gmail_app_password
  echo 'Google App Password mesti 16 aksara. Konfigurasi SMTP_PASSWORD tidak diubah.' >&2
  exit 1
fi
set_env SMTP_PASSWORD "'$gmail_app_password'"
unset gmail_app_password

chmod 600 "$env_file"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose -f compose.external-proxy.yaml config --quiet
else
  echo 'Amaran: Docker Compose belum tersedia; semakan Compose dilangkau.' >&2
fi

echo 'Konfigurasi production disimpan dalam .env dan semakan selesai.'
echo 'Rahsia tidak dipaparkan. Seterusnya jalankan deployment melalui Codex.'
