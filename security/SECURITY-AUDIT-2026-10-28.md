# Semakan keselamatan Sembang — 28 Oktober 2026

**Keputusan: belum sedia untuk penggunaan awam atau chat sensitif.**

Skop: pelayan Node.js 1.2.2, JavaScript klien, tetapan deployment dan sumber pembungkus Android/APK 1.2.0. Ini semakan kod, semakan advisory npm dan ujian setempat; bukan pentest bebas atau pengesahan keselamatan production. Tiada pembaikan aplikasi dibuat dalam semakan ini.

## Penemuan yang disahkan

### SEC-01 — Tinggi / P1: had log masuk dikongsi semua pengguna di belakang proxy

Lokasi: [server.js:140](/Volumes/Work/Slide%20Munciss/sembang/server.js:140), [server.js:168](/Volumes/Work/Slide%20Munciss/sembang/server.js:168), [Caddyfile:2](/Volumes/Work/Slide%20Munciss/sembang/Caddyfile:2).

Had 30 permintaan dalam 15 minit menggunakan `req.socket.remoteAddress`. Dalam deployment Caddy yang disediakan, alamat itu milik proxy, bukan pengguna asal. Laluan daftar dan log masuk berkongsi bucket. Seorang penyerang tanpa akaun boleh menghabiskan kuota dan menyebabkan pengguna lain menerima HTTP 429 sehingga tetingkap 15 minit tamat. Ini menyekat pendaftaran/log masuk; ia tidak serta-merta memutuskan sesi pengguna yang sudah masuk.

Bukti: 30 percubaan log masuk dengan kata laluan salah daripada satu alamat forwarded menghasilkan 401. Pendaftaran sah daripada alamat forwarded lain, melalui peer TCP sama, kemudian menerima 429. Ujian mensimulasikan dua klien di belakang proxy pada loopback; tiada serangan pada deployment sebenar.

Pembaikan: percayai hanya proxy yang diketahui, dapatkan IP pengguna melalui konfigurasi proxy yang betul, dan gabungkan had IP dengan had akaun yang tidak membolehkan kunci akaun secara mudah. Jangan mempercayai `X-Forwarded-For` secara membuta tuli. Rujukan: [Express — behind proxies](https://expressjs.com/en/guide/behind-proxies/).

### SEC-02 — Sederhana / P2: sesi tamat masih boleh menerima chat melalui socket

Lokasi: [server.js:315](/Volumes/Work/Slide%20Munciss/sembang/server.js:315), [server.js:98](/Volumes/Work/Slide%20Munciss/sembang/server.js:98).

Sesi disemak ketika socket disambungkan dan setiap paket aplikasi masuk. Tiada pemutusan pada masa tamat sesi atau semakan sebelum siaran keluar. Klien yang hanya mendengar kekal dalam bilik pengguna selepas sesi luput. Ini bukan kebocoran chat kepada pengguna rawak: klien yang sudah disahkan dan mempunyai kunci peranti boleh terus menerima serta membuka chat melepasi tempoh akses yang ditetapkan.

Bukti: selepas sesi penerima dalam database ujian ditetapkan kepada masa lampau, `/api/me` menolak kukinya dengan 401. Socket sedia ada masih menerima mesej baharu dan kunci penerima berjaya menyahsulitkannya. Tiada paket aplikasi dihantar oleh penerima selepas tamat sesi. Laluan logout biasa memang memutuskan socket sesi tersebut; isu ini berkenaan tamat sesi tanpa logout.

Pembaikan: jadualkan pemutusan pada `expires`, batalkan timer apabila disconnect, dan pastikan siaran kepada pengguna hanya menuju sesi yang masih sah. Tambah ujian penerima pasif selepas tamat sesi.

### SEC-03 — Sederhana / P2: muat naik tiada kuota keseluruhan atau tamat tempoh fail tidak digunakan

Lokasi: [server.js:261](/Volumes/Work/Slide%20Munciss/sembang/server.js:261).

Had setiap fail dan had 30 muat naik/minit/akaun wujud. Namun fail disimpan terus tanpa kuota jumlah byte pengguna, had kapasiti pelayan atau pembersihan fail yang tidak digunakan dalam mesej. Akaun yang mempunyai perbualan dan kunci boleh terus menggunakan ruang storan sehingga penuh, menjejaskan SQLite serta muat naik pengguna lain. Had kod bersamaan sekitar 60 MiB seminit bagi satu akaun pada saiz maksimum; ini pengiraan had, bukan keputusan ujian beban.

Bukti: dua fail ujian kecil, keseluruhan 34 byte, diterima dan kekal sebagai rekod media walaupun tidak digunakan oleh sebarang mesej. Semakan kod mengesahkan tiada kuota kumulatif atau proses tamat tempoh. Storan tidak dipenuhkan semasa semakan.

Pembaikan: tempahan kuota byte sebelum menerima fail, had storan per pengguna/pelayan, rekod pemilik dan saiz fail, serta proses pembersihan muat naik tidak digunakan dengan tempoh yang selamat. Deskriptor media berada dalam ciphertext, jadi perubahan protokol diperlukan untuk menandakan komit muat naik tanpa membuka kandungan. Jangan padam fail lama berdasarkan andaian bahawa pelayan boleh membaca rujukan di dalam mesej sulit.

## Had reka bentuk yang masih penting

- **Emel belum disahkan.** Pendaftaran mengesahkan format dan keunikan sahaja lalu terus mengeluarkan sesi. Sesiapa boleh mendaftar menggunakan alamat orang lain, menghalang pemilik sebenar menggunakan alamat itu. Ini bukan pengambilalihan akaun sedia ada dan tidak membuka chat lama. Sebelum pelancaran berasaskan identiti emel, perlukan pengesahan pemilikan serta polisi tamat tempoh pendaftaran belum disahkan. Lokasi: [server.js:143](/Volumes/Work/Slide%20Munciss/sembang/server.js:143), [server.js:161](/Volumes/Work/Slide%20Munciss/sembang/server.js:161).
- **E2EE belum mempunyai forward secrecy atau pemulihan selepas kompromi kunci.** Kunci perbualan berasal daripada kunci identiti ECDH kekal; tiada ratchet. Jika kunci identiti terkompromi, ciphertext yang dikumpulkan bagi identiti itu boleh terdedah. Kod pemulihan bersama sandaran turut membuka identiti lama. Gunakan protokol dan implementasi yang diselenggara serta diaudit jika sasaran ialah messenger production; perubahan ini memerlukan reka bentuk dan migrasi data, bukan sekadar menukar nama algoritma. Lokasi: [crypto.js:44](/Volumes/Work/Slide%20Munciss/sembang/public/crypto.js:44). Rujukan sifat perlindungan: [spesifikasi Double Ratchet](https://signal.org/docs/specifications/doubleratchet/).
- **Kod klien dipercayai datang daripada pelayan.** APK memuat JavaScript daripada origin pelayan yang dipilih. Pelayan yang diambil alih boleh menghantar kod baharu yang membaca kandungan ketika dibuka, walaupun kunci disimpan sebagai CryptoKey tidak boleh dieksport. HTTPS diperlukan tetapi tidak menyelesaikan kompromi origin.

## Apa yang lulus

- `npm audit --json`: 0 advisory yang diketahui dalam dependency npm yang dipasang. Ini tidak meliputi semua kerentanan aplikasi, Android atau sistem operasi.
- `npm test`: 15/15 ujian lulus, termasuk akses perbualan/media, emel peribadi, penolakan socket tanpa sesi, plaintext/tampering, pemulihan kunci, isyarat panggilan, logout dan persistence.
- Kata laluan menggunakan scrypt dengan salt rawak; kuki sesi HttpOnly/SameSite Strict; token sesi dihash dalam database. Docker Compose menetapkan Secure cookie dan origin HTTPS.
- Query yang disemak menggunakan parameter SQLite; akses sejarah dan media disemak sebagai peserta perbualan. Ujian tidak menemui pintasan akses tersebut.
- APK sedia ada lulus `apksigner verify --verbose` menggunakan tandatangan v2. Ini mengesahkan integriti tandatangan, bukan keselamatan tingkah laku aplikasi.
- Semakan sumber Android menemui sekatan HTTPS selain loopback, penolakan sijil tidak sah, kebenaran mengikut origin, backup aplikasi dimatikan dan debug WebView mengikut build. Ini semakan statik, bukan pengesahan runtime baharu.
- Fail pelayan, klien, kriptografi, vault dan lockfile dalam zip pelayan 1.2.2 sepadan dengan fail yang disemak. Tiada folder data, `.env` sebenar atau kunci tandatangan dalam zip tersebut; tiada fail `.jks`, `.keystore`, `.env` atau `.sqlite` dalam APK.

## Bukti dan ulangan

[Skrip probe](/Volumes/Work/Slide%20Munciss/sembang/security/audit-probes.mjs) dan [keputusan JSON](/Volumes/Work/Slide%20Munciss/sembang/security/audit-probe-results.json).

Jalankan `node security/audit-probes.mjs` dari projek. Ia hanya mencipta server loopback pada port rawak dan database sementara, kemudian membersihkannya. Tidak membaca database/kuki/kunci pengguna. Skrip ini mengesahkan isu versi 1.2.2; selepas pembaikan, ubah assertion menjadi regression test yang menjangkakan akses ditolak atau pengguna lain kekal dibenarkan.

Kebergantungan yang terpasang ketika semakan: Express 5.3.0, Multer 2.5.0, Socket.IO dan Socket.IO Client 4.8.4. Runtime ujian Node.js 26.0.0.

Belum diuji: deployment HTTPS sebenar, operasi Caddy sebenar, kebocoran melalui peranti fizikal/OS, eksploit WebView, panggilan kamera/mikrofon dua telefon, kebergantungan Android melalui pangkalan advisory khusus, ujian beban/kehabisan disk dan penilaian kriptografi bebas. Tiada listener pada port 3000 dikesan ketika semakan; penemuan datang daripada sumber dan instance ujian berasingan.

Keutamaan: selesaikan SEC-01 dan SEC-02, tambah kawalan storan SEC-03, kemudian pengesahan emel, pengesahan deployment sebenar dan penilaian reka bentuk E2EE sebelum penggunaan awam.
