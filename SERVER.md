# Pelayan Node.js Sembang 1.4.0

Pelayan untuk APK Sembang 1.3.0 dan pelayar: chat E2EE, gambar dimampatkan/disulitkan, SQLite, lokasi dan isyarat panggilan. **Panduan VPS AlmaLinux:** [ALMALINUX.md](ALMALINUX.md).

## Ringkasan pemasangan VPS

Pakej `sembang-nodejs-server-v1.4.0.zip` mengandungi aplikasi, Dockerfile, dua mod Compose, installer AlmaLinux, backup dan panduan. Data pengguna, `.env` sebenar, kunci SSH dan kunci tandatangan APK tidak disertakan.

1. Halakan domain ke VPS dan sediakan SMTP untuk kod emel.
2. Pasang Docker Engine + Compose mengikut versi AlmaLinux, kemudian ekstrak pakej ke `/opt/sembang`.
3. Salin `.env.example` ke `.env`, isi domain/SMTP dan `AUTH_SECRET` rawak; `chmod 600 .env`.
4. VPS tanpa web server sedia ada: `bash deploy/install-almalinux.sh`. Caddy mengurus HTTPS; port Node tidak diterbitkan.
5. VPS dengan proxy/panel sedia ada: gunakan `compose.external-proxy.yaml`, contoh Nginx dan langkah dalam ALMALINUX.md. Jangan hentikan servis laman lain.

Production menolak konfigurasi tanpa HTTPS origin, Secure cookie, pengesahan emel dan SMTP/rahsia yang diperlukan. Header IP hanya dipercayai daripada alamat proxy yang ditetapkan. Jangan buka port 3000 pada semua interface atau menukar TRUST_PROXY kepada true.

## Pengukuhan 1.4.0

- Rate limit IP asal (termasuk pengelompokan IPv6), disimpan di SQLite supaya kekal selepas restart. IP pengguna berlainan di belakang Caddy tidak berkongsi satu bucket proxy.
- Maksimum 20 sesi aktif setiap akaun. Socket diputuskan pada tamat sesi dan penerima disemak sebelum siaran. Logout terus membatalkan sesi/sambungan.
- Kuota media setiap pengguna/pelayan, tempahan ruang untuk upload serentak, had baki disk, mesej dan perbualan.
- Upload pending terikat pada pemilik/perbualan/ID mesej. Mesej yang diakui mengkomit ID media secara atomik. Hanya pending yang luput dibersihkan; fail committed dan media lama dipelihara.
- Kod emel enam digit, luput 10 minit, maksimum lima percubaan. Kod dihash dengan HMAC; tiada akaun/sesi dicipta sebelum pengesahan. Permintaan belum disahkan tidak menempah alamat emel. Pengguna lama mengesahkan emel pada log masuk production seterusnya.
- Had handshake WebSocket, sambungan per akaun dan kerja hash kata laluan/SMTP, timeout HTTP, pengesahan origin penuh, pengepala keselamatan, log JSON tanpa rahsia, graceful shutdown dan readiness.
- Container aplikasi tanpa root, filesystem baca sahaja, had memori/PID, log berputar, data kekal, restart selepas reboot dan backup konsisten dengan checksum.

## Ujian setempat / USB

Perlu **Node.js 24+**. Pemasangan setempat lalai hanya mendengar `127.0.0.1:3000`; tidak menghantar emel. Ini mod pembangunan, bukan tetapan production.

```sh
npm ci
npm test
npm start
```

Buka `http://localhost:3000`. Untuk APK pada telefon USB:

```sh
adb reverse tcp:3000 tcp:3000
```

Pasang APK 1.3.0 dan pilih **Uji melalui USB**. Untuk kegunaan tanpa USB, masukkan origin HTTPS domain yang sama dalam APK. Kod JavaScript baharu datang daripada pelayan; tidak perlu membina APK semula untuk backend ini.

`.env` tidak dibaca oleh `npm start` secara automatik di luar Compose. Gunakan `node --env-file=.env server.js` selepas mengisi tetapan yang sesuai untuk cara pemasangan itu.

## Operasi

`GET /api/health`: `{ "service": "sembang", "version": "1.4.0", "status": "ok" }`.

`GET /api/ready`: 200 apabila SQLite boleh dibaca dan ruang minimum tersedia; 503 jika tidak. Health hanya menyatakan proses hidup; readiness tidak mengesahkan penghantaran SMTP atau sijil awam.

Ikut ALMALINUX.md untuk timer backup, pemulihan volume baharu dan migrasi. Kekalkan data SQLite, media dan `AUTH_SECRET`; jangan jalankan `down -v`. Satu proses Node + SQLite digunakan; jangan gandakan replika tanpa menyelaras database/Socket.IO/panggilan.

STUN disediakan. TURN provider/coturn berasingan disokong melalui `TURN_URL` + `TURN_SHARED_SECRET`, dengan kelayakan REST empat jam. Stack tidak memasang TURN atau push/background calls. Uji panggilan pada dua telefon selepas domain/HTTPS berfungsi.

## Batas yang masih ada

E2EE masih prototaip Web Crypto tanpa Double Ratchet / forward secrecy atau audit kriptografi bebas. Pelayan mengetahui metadata, dan kod klien daripada origin yang terkompromi boleh membaca kandungan pada peranti ketika dibuka. Pengukuhan backend tidak menjadikan jaminannya setara messenger production yang diaudit.

Emel tidak menggantikan kod pemulihan kunci pengguna. Jika kunci peranti dan kod pemulihan hilang, kata laluan akaun tidak boleh membuka sejarah sulit. Latar Stitch & Angel mempunyai syarat kegunaan peribadi dengan atribusi; lihat `public/assets/ASSETS.md`.
