#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ ${EUID} -eq 0 ]] || { echo 'Jalankan sebagai root atau sudo.' >&2; exit 1; }
source /etc/os-release
[[ "$ID" == almalinux && "$VERSION_ID" =~ ^(9|10)(\.|$) ]] || { echo 'Skrip ini untuk AlmaLinux 9/10.' >&2; exit 1; }
# Deliberately never removes Podman, stops web servers, disables SELinux, or changes SSH.
command -v docker >/dev/null || { echo 'Pasang Docker Engine + Compose dahulu mengikut ALMALINUX.md. Tiada servis sedia ada diubah.' >&2; exit 1; }
docker compose version >/dev/null
[[ -f .env ]] || { cp .env.example .env; chmod 600 .env; echo 'Isi domain, AUTH_SECRET dan SMTP dalam .env, kemudian jalankan semula.'; exit 1; }
chmod 600 .env
if [[ -n "$(ss -H -ltn '( sport = :80 or sport = :443 )')" && -z "$(docker compose ps -q caddy)" ]]; then
  echo 'Port 80/443 sedang digunakan. Rujuk mod reverse proxy sedia ada dalam ALMALINUX.md; tiada servis dihentikan.' >&2
  exit 1
fi
docker compose config --quiet
docker compose build --pull sembang
docker compose run --rm --no-deps --entrypoint node sembang deploy/preflight.mjs
systemctl enable --now docker
# Only the two public web ports are published; the Node port remains internal.
if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http
  firewall-cmd --permanent --add-service=https
  firewall-cmd --reload
fi
docker compose up -d --wait --wait-timeout 180
if [[ "$PWD" == /opt/sembang ]]; then
  install -m 0644 deploy/sembang-backup.service deploy/sembang-backup.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now sembang-backup.timer
fi
echo 'Servis bermula. Semak HTTPS dari luar dan uji pendaftaran emel sebelum jemput pengguna.'
