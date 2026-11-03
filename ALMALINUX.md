# Sembang 1.4.0 — VPS AlmaLinux 9 / 10

Pakej ini menjalankan Node.js 24 + SQLite dalam satu container, dengan storan kekal. APK **1.3.0** sedia ada serasi. Tiada MySQL/MariaDB diperlukan dan tiada port database perlu dibuka untuk Sembang.

Pemasangan sebenar VPS masih perlu disahkan mengikut versi OS, port sedia ada, domain dan SMTP. Panduan ini tidak bermaksud sambungan SSH atau deployment ke VPS telah berjaya.

## Sebelum bermula

- Satu domain/subdomain yang DNS A/AAAA-nya menunjuk kepada VPS. Buang rekod AAAA yang tidak menuju VPS sebenar.
- SMTP provider dengan hostname, port, username/password dan alamat penghantar yang dibenarkan. Pendaftaran production memerlukan kod emel; port 587 menggunakan STARTTLS, atau 465 dengan `SMTP_SECURE=true`. Ikut SPF/DKIM provider supaya kod tidak masuk spam.
- Docker Engine + Compose plugin. Cadangan awal 2 vCPU / 2 GB RAM, ruang data dan backup yang berasingan atau mencukupi. Kapasiti sebenar perlu diukur mengikut pengguna.
- Kenal pasti servis sedia ada pada port 80/443. Gunakan **satu** mod pemasangan di bawah. Skrip tidak memadam Podman, menghentikan web server lain, menukar SSH atau mematikan SELinux.
- Sahkan fingerprint SSH melalui console penyedia hosting jika ada amaran host key berubah. Jangan padam rekod known_hosts semata-mata untuk melepasi amaran.

## 1. Docker pada AlmaLinux

Periksa dahulu:

```sh
cat /etc/os-release
ss -lntup
docker version
docker compose version
getenforce
```

Jika Docker belum dipasang, pada VPS AlmaLinux 9/10 yang sesuai gunakan repositori RPM Docker untuk keluarga RHEL/CentOS. Semak versi dan konflik pakej dahulu; jangan buang Podman/runc pada VPS yang menjalankan servis lain secara automatik.

```sh
sudo dnf install dnf-plugins-core unzip openssl util-linux iproute
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

Perintah `dnf config-manager` berbeza jika host menggunakan DNF5; rujuk dokumentasi versi tersebut. Jangan gunakan skrip pemasangan Internet tanpa menyemak kandungannya. Rujukan rasmi: [Docker RPM repository](https://docs.docker.com/engine/install/centos/), [RHEL installation](https://docs.docker.com/engine/install/rhel/).

Kekalkan SELinux Enforcing. Bind mount Caddyfile/backup menggunakan label `:Z`; named volume data diurus Docker. Root atau akses kumpulan Docker memberikan kuasa besar terhadap host; jalankan arahan operator hanya daripada akaun pentadbir.

## 2. Upload pakej dan isi konfigurasi

Sahkan checksum zip pada komputer asal, upload zip + `.sha256`, kemudian ekstrak ke `/opt/sembang`. Nama folder di dalam zip ialah `sembang-nodejs-server`. Jangan mengekstrak di atas pemasangan lama yang belum dibackup.

```sh
sha256sum -c sembang-nodejs-server-v1.4.0.zip.sha256
unzip sembang-nodejs-server-v1.4.0.zip
sudo mv sembang-nodejs-server /opt/sembang
cd /opt/sembang
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

Salin nilai rawak terakhir ke `AUTH_SECRET` dalam `.env`; jangan kongsi nilai itu. Isi:

```dotenv
SEMBANG_DOMAIN=chat.domain-kamu.com
AUTH_SECRET=nilai_rawak_64_aksara_hex
SMTP_HOST=smtp.provider-kamu.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=akaun_smtp_kamu
SMTP_PASSWORD='kata_laluan_smtp_kamu'
SMTP_FROM='Sembang <chat@domain-kamu.com>'
```

Nilai contoh mesti diganti. Jika kata laluan mengandungi `$`, petik dengan single quote dalam `.env` supaya Compose tidak melakukan interpolation. Jangan letakkan `.env`, kunci SSH atau kunci tandatangan APK dalam folder `public/`.

`AUTH_SECRET` mesti kekal merentas restart/kemas kini. Simpan salinan `.env` secara peribadi di lokasi berasingan; backup data tidak memasukkan SMTP atau rahsia konfigurasi. `docker compose config` tanpa `--quiet` boleh mencetak rahsia, jadi gunakan `--quiet` ketika membuat semakan.

## 3A. VPS tanpa web server sedia ada — Caddy + HTTPS

Halakan DNS dahulu. Pastikan firewall penyedia VPS membenarkan TCP 80/443. Installer menambah servis HTTP/HTTPS hanya apabila firewalld sudah aktif; ia tidak mengubah port SSH.

```sh
cd /opt/sembang
bash deploy/install-almalinux.sh
docker compose ps
docker compose logs --tail 50 sembang
curl --fail https://chat.domain-kamu.com/api/health
curl --fail https://chat.domain-kamu.com/api/ready
```

Caddy mengurus sijil HTTPS dan WebSocket. Port Node 3000 tidak diterbitkan ke Internet. Compose hanya mempercayai IP tetap container Caddy untuk header IP pengguna. Jika subnet `172.29.241.0/24` bertindih dengan rangkaian VPS, ubah `SEMBANG_SUBNET` dan `CADDY_IP` secara bersama sebelum memulakan stack.

`restart: unless-stopped` bersama Docker yang diaktifkan systemd memulakan semula container selepas reboot. Tetapan memori/PID, root filesystem baca sahaja, pengguna Node tanpa root, dan putaran log disediakan. HTTPS/SMTP/DNS sebenar masih perlu diuji dari luar VPS.

## 3B. VPS dengan Nginx/Apache/panel sedia ada

Gunakan fail alternatif **menggantikan** compose.yaml, bukan digabungkan dengannya:

```sh
cd /opt/sembang
docker compose -f compose.external-proxy.yaml config --quiet
docker compose -f compose.external-proxy.yaml build --pull sembang
docker compose -f compose.external-proxy.yaml run --rm --no-deps --entrypoint node sembang deploy/preflight.mjs
docker compose -f compose.external-proxy.yaml up -d --wait
printf '%s\n' compose.external-proxy.yaml > deploy/compose-mode
```

Aplikasi diterbitkan hanya pada `127.0.0.1:3000`. Tambah reverse proxy pada vhost HTTPS domain Sembang sahaja. Contoh Nginx: `deploy/nginx-sembang.conf.example`. Proxy perlu menyokong WebSocket dan menulis semula `X-Forwarded-For` kepada IP klien yang dipercayai serta `X-Forwarded-Proto` kepada `https`. Untuk Apache/panel, sesuaikan melalui konfigurasi panel sebenar; jangan menggantikan vhost laman lain.

Host proxy dilihat oleh container sebagai gateway `172.29.241.1`; `PROXY_GATEWAY` dan subnet boleh diubah bersama jika perlu. Jangan menukar TRUST_PROXY menjadi `true`, mempercayai semua IP, atau membuka Node 3000 pada semua interface. Jika Nginx/Apache di bawah SELinux menolak sambungan ke backend, semak rekod AVC dan polisi host dahulu; jangan matikan SELinux.

Bagi host di belakang Cloudflare/load balancer, konfigurasi pemulihan IP asal pada proxy mengikut julat IP penyedia yang dipercayai. Tanpa konfigurasi itu, rate limit mungkin dikongsi mengikut IP load balancer. Jangan mempercayai semua header klien.

## 4. Backup harian dan pemulihan

Backup mengambil snapshot SQLite yang konsisten sambil aplikasi berjalan, kemudian menyertakan semua fail media **committed** dalam snapshot itu. Fail committed kekal immutable. Upload pending tidak disalin atau dipadam daripada data sebenar; ia hanya dikecualikan daripada salinan backup. Chat/kunci/sesi dan sandaran kunci sulit dimasukkan; private key peranti serta kod pemulihan pengguna tidak berada pada pelayan.

```sh
cd /opt/sembang
sudo bash deploy/backup.sh
sudo ls -lh /var/backups/sembang
```

Helper backup berjalan sebagai root dalam container sementara dengan capability membaca fail data, sementara servis aplikasi kekal tanpa root. Backup + checksum mempunyai mod 600. Semakan ruang mengelakkan backup menghabiskan baki disk minimum; backup lama dikekalkan jika backup baharu gagal. Polisi lalai menyimpan 14 hari **selepas backup baharu berjaya**. Sediakan ruang yang cukup dan pantau kegagalan; salin backup ke storan luar VPS secara peribadi kerana disk VPS boleh rosak atau hilang.

Installer mod 3A di `/opt/sembang` memasang timer automatik. Untuk mod 3B atau pemasangan manual:

```sh
sudo install -m 0644 deploy/sembang-backup.service deploy/sembang-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sembang-backup.timer
systemctl list-timers sembang-backup.timer
journalctl -u sembang-backup.service --since today
```

Timer berjalan sekitar **03:15–03:20 waktu Malaysia**, termasuk catch-up selepas host kembali hidup. Jangan menyimpan satu-satunya salinan backup pada VPS yang sama.

Pemulihan perlu dibuat ke **volume baharu yang kosong**, bukan menindih data aktif:

1. Sahkan `.tar.gz.sha256` dan senarai kandungan arkib backup milik sendiri; jangan ekstrak arkib pihak ketiga yang tidak dipercayai.
2. Hentikan aplikasi. Cipta named volume baharu dengan nama lain, ekstrak backup ke volume itu menggunakan helper container, dan tetapkan pemilik data kepada UID/GID `1000:1000`.
3. Isi nama volume baharu dalam `SEMBANG_DATA_VOLUME` pada `.env`, kekalkan `AUTH_SECRET`/domain yang sama, kemudian hidupkan aplikasi dan semak `/api/ready`, integriti SQLite serta sejarah/gambar menggunakan akaun ujian sendiri.
4. Kekalkan volume asal sehingga pemulihan disahkan. Jangan jalankan `docker compose down -v`.

## 5. Naik taraf dan akaun lama

Sebelum naik taraf versi lama, hentikan server lama dan backup **seluruh** folder/volume data termasuk fail WAL/SHM jika ada. Semak nama volume asal dengan `docker volume ls` dan tetapkan `SEMBANG_DATA_VOLUME` kepada nama tepat itu. Jangan tukar kepada volume kosong secara tidak sengaja.

Migrasi menambah kolum secara automatik; akaun, sejarah, sesi dan kunci lama dikekalkan. Media lama dianggap committed dan tidak dibuang oleh proses pembersihan pending. Saiz media lama dikira dalam kuota keseluruhan; pemiliknya tidak dapat ditentukan daripada ciphertext lama, jadi ia tidak dicaj kepada seorang pengguna secara tekaan.

Production memerlukan pengguna lama mengesahkan emel pada log masuk seterusnya. Akaun lama tanpa emel memerlukan pentadbir menetapkan alamat yang disahkan melalui proses sokongan sebelum pengguna boleh masuk melalui borang emel. Pendaftaran yang belum disahkan tidak menempah alamat emel.

Untuk kemas kini 1.4.x:

```sh
bash deploy/backup.sh
docker compose build --pull sembang
docker compose up -d --wait
```

Untuk mod proxy sedia ada, gunakan `-f compose.external-proxy.yaml` pada dua arahan Compose. Jika perlu kembali ke versi sebelum perubahan schema, pulihkan backup **sebelum naik taraf** bersama kod/image lama; jangan anggap image lama boleh menulis schema baharu. Volume asal dan arkib sebelum naik taraf mesti dikekalkan.

## 6. Kuota, log dan panggilan

Lalai: 256 MiB media/pengguna, 4096 MiB media keseluruhan, 512 MiB baki disk minimum, 24 jam sebelum pending upload luput, 50,000 mesej/pengguna dan 500,000 mesej keseluruhan. Kuota boleh diubah dalam `.env`. Pengakuan mesej menyertakan ID media sebagai metadata untuk komit fail; isi mesej/deskriptor gambar kekal disulitkan. Fail committed tidak dipadam automatik.

Log JSON merekod ID permintaan, route template, status dan masa respons. Emel, kata laluan, OTP, kuki, isi mesej dan lokasi tidak dicetak. Docker memutar log pada 10 MB × 3/container. Log kesilapan dan `/api/ready` perlu dipantau; tiada notifikasi operator luaran dipasang secara automatik.

Panggilan merentas rangkaian mungkin memerlukan TURN. Gunakan provider/coturn sendiri dan tetapkan `TURN_URL` + `TURN_SHARED_SECRET` untuk kelayakan REST sah empat jam. Static TURN masih disokong sebagai pilihan provider. Stack ini tidak memasang coturn atau membuka julat port TURN secara automatik. Uji kamera/mikrofon dua telefon selepas HTTPS tersedia.

E2EE masih prototaip klien tanpa Double Ratchet/forward secrecy. Pengukuhan VPS tidak mengubah sifat itu. Skrip web daripada origin yang terkompromi masih boleh membaca kandungan pada peranti ketika dibuka; pengesahan emel dan HTTPS tidak menggantikan audit kriptografi bebas.

Rujukan: [Express trusted proxies](https://expressjs.com/en/guide/behind-proxies/), [Docker/firewalld](https://docs.docker.com/engine/network/packet-filtering-firewalls/), [Nodemailer TLS](https://nodemailer.com/smtp), [systemd time zones](https://www.freedesktop.org/software/systemd/man/latest/systemd.time.html).
