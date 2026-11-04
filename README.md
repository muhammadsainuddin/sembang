# Zbuddy 💜

Developed by **Aigeo — Freelance Programmer**, for **My Purple**.

**Zbuddy 1.14.1** merangkumi source aplikasi, APK release dan pakej backend. Lihat [panduan Android](ANDROID.md) dan [panduan pelayan Node.js](SERVER.md).


Aplikasi chat JavaScript + Node.js untuk komuniti peribadi yang diluluskan Owner: tanda dihantar/disampaikan/dibaca, Web Push sulit, gambar automatik dimampatkan, panggilan suara/video dan lokasi langsung. Tema, warna, font dan gambar latar chat boleh dipilih sendiri. Antara muka Bahasa Inggeris, responsif untuk telefon dan desktop.

## Ikon Zbuddy

Zbuddy menggunakan **Kelopak**, set 30 ikon SVG yang dilukis khas untuk projek ini. Chat dua kapsul, gelombang suara, sasaran lokasi dan status dua kelopak memberi identiti aplikasi. Favicon serta launcher/menu Android menggunakan reka bentuk yang sama. Sumber vektor: `public/assets/icons/`; helaian rujukan: `public/assets/icons/collection.svg`. Tiada aset WhatsApp digunakan.

## Jalankan

Perlu Node.js 24 atau lebih baharu.

```sh
cd sembang
npm install
npm start
```

Buka **http://localhost:3000**. Jika terminal sudah berada dalam folder `sembang`, terus jalankan `npm start`.

1. Cipta akaun menggunakan nama, emel dan kata laluan, kemudian sahkan kod enam digit melalui emel. Akaun pertama menjadi Owner; akaun baharu seterusnya perlu diaktifkan oleh Owner sebelum boleh log masuk.
2. Klik **+**, cari kenalan dan buka perbualan. Kenalan perlu log masuk sekali untuk menyediakan kunci mereka sebelum kamu boleh menghantar chat sulit.
3. Owner boleh membuka menu profil sendiri → **Manage account activation** untuk meluluskan atau menyahaktifkan akaun. Semua akaun yang sudah ada sebelum naik taraf kekal aktif; akaun paling awal menjadi Owner.
4. Akaun sama boleh log masuk serentak pada telefon dan web. Had lalai ialah 50 sesi aktif setiap akaun; sesi tertua dibatalkan apabila had dicapai.
5. Untuk akaun sama pada pelayar/peranti baharu, log masuk menggunakan emel dan kata laluan. Sandaran kunci chat dibuka secara setempat tanpa kod pemulihan berasingan.

## Backend VPS 1.14.1

Panduan AlmaLinux, proxy/HTTPS, SMTP, kuota, backup dan kemas kini berada dalam [ALMALINUX.md](ALMALINUX.md). Production memerlukan pengesahan emel; kod enam digit dihantar melalui SMTP. Tiga isu audit (bucket proxy, sesi socket tamat, dan storan upload) telah diberikan pembaikan serta regression test. Had E2EE klien yang diterangkan di bawah masih terpakai.

## Pendaftaran dan penyimpanan

Emel wajib untuk akaun baharu, disemak format dan disimpan secara unik tanpa mengira huruf besar/kecil. Borang log masuk menggunakan emel. Nama pengguna untuk carian kenalan dijana secara automatik; tidak perlu diisi semasa pendaftaran. API masih menerima nama pengguna untuk keserasian akaun lama. Emel hanya dipulangkan kepada pemilik akaun sendiri dan senarai pentadbiran Owner. Production mewajibkan kod emel, kemudian kelulusan Owner, sebelum sesi pertama boleh dicipta; mod pembangunan setempat tidak menghantar emel.

Ahli yang aktif boleh melihat profil ahli aktif lain. Profil pilihan menyokong bio, pekerjaan, nombor telefon, alamat rumah, tarikh lahir, TikTok, Instagram, Facebook dan laman web. Maklumat ini dikongsi kepada semua akaun yang diluluskan dalam pelayan peribadi tersebut, jadi isi hanya data yang memang mahu dikongsi.

Akaun lama dinaik taraf tanpa memadam chat, sesi atau kunci: medan emel yang belum ada kekal kosong dan API log masuk lama masih menerima nama pengguna. Dalam production, akaun perlu mengesahkan emel; akaun tanpa emel memerlukan bantuan pentadbir.

SQLite digunakan untuk akaun, sesi, kunci awam, sejarah dan mesej penerima offline. Tiada pemasangan pangkalan data berasingan diperlukan; data disimpan dalam fail pada pelayan. Mesej baharu kekal disulitkan. Chat live sahaja boleh direka tanpa database, tetapi ia tidak memberikan penyimpanan sejarah/penghantaran offline yang tahan restart seperti versi ini.

## Penyulitan hujung ke hujung

**Mesej baharu, gambar, kapsyen, koordinat dan kemas kini lokasi, serta isyarat panggilan SDP/ICE disulitkan pada pelayar sebelum dihantar.** Pelayan menyimpan ciphertext. Audio/video menggunakan DTLS-SRTP WebRTC, dan fingerprint sambungan berada dalam isyarat yang turut disulitkan.

- Web Crypto menggunakan ECDH P-256, HKDF-SHA-256 dan AES-256-GCM dengan IV rawak 96 bit setiap operasi.
- Kunci mesej diasingkan mengikut perbualan dan arah penghantaran. Data tambahan yang disahkan mengikat ciphertext kepada perbualan, pengirim, ID klien dan identiti kunci. Mengubah data atau konteks menyebabkan penyahsulitan gagal.
- Kunci peribadi disimpan sebagai `CryptoKey` yang tidak boleh dieksport dalam IndexedDB pelayar. Sandaran pada pelayan disulitkan pada klien menggunakan AES-256-GCM dengan kunci PBKDF2-SHA-256 daripada kata laluan akaun, salt rawak dan 600,000 iterasi.
- Pada pelayar/peranti baharu, kata laluan yang berjaya mengesahkan akaun turut membuka sandaran kunci secara setempat. Tiada kod pemulihan berasingan.
- Kunci awam tidak boleh ditukar melalui API selepas ditetapkan. Pelayar mengingati kunci kenalan (trust on first use); kunci yang berubah menyekat penghantaran.
- Buka **Maklumat kenalan → Nombor keselamatan** dan bandingkan nombor melalui saluran lain untuk mengesahkan kenalan. Pengesahan manual ini melindungi pertukaran kunci pada hubungan pertama.
- Tiada penghantaran baharu secara plaintext atau fallback plaintext. Mesej sebelum naik taraf tidak disulitkan semula secara automatik dan dilabel **Mesej lama · belum disulitkan**. Perkongsian lokasi lama dipaparkan sebagai snapshot terakhir.

**Had keselamatan:** Ini prototaip Web Crypto, belum diaudit secara bebas dan tidak menggunakan Signal Protocol / Double Ratchet. Tiada forward secrecy atau penggiliran identiti automatik; kompromi kunci identiti boleh mendedahkan sejarah yang dikumpulkan. Sandaran berasaskan kata laluan lebih mudah digunakan tetapi kata laluan lemah boleh diteka secara luar talian jika pangkalan data dicuri, dan pelayan menerima kata laluan melalui HTTPS semasa log masuk. Pelayan masih mengetahui metadata seperti peserta, masa, saiz fail, status dibaca, kehadiran dan metadata panggilan. Aplikasi web memerlukan penghantaran kod yang dipercayai melalui HTTPS; skrip klien yang dikompromi boleh mengakses kandungan yang sedang dibuka. Jangan anggap ia mempunyai jaminan keselamatan setara WhatsApp production.

## Pemampatan gambar

- Pemampatan berlaku **pada pelayar sebelum penyulitan**, bukan pada pelayan.
- Terima JPEG/PNG/WebP/GIF asal sehingga 25 MB.
- Saiz maksimum sisi panjang ialah **1600 px**, tanpa membesarkan gambar kecil.
- Encode sebagai WebP pada kualiti 82%, turunkan kualiti dan dimensi jika perlu, sasaran sekitar **1 MB**, had keras 2 MB. Pelayar tanpa WebP encoding menggunakan PNG.
- Pratonton menunjukkan saiz asal → saiz akhir, peratus penjimatan dan dimensi. Gambar sangat kecil boleh meningkat sedikit akibat overhead format.
- Pemprosesan melalui canvas membuang metadata EXIF. GIF dihantar sebagai gambar pegun dan dilabel demikian sebelum penghantaran.
- Setiap fail mendapat kunci AES-GCM rawak berasingan. Kunci fail, IV, nama, jenis, dimensi dan kapsyen berada dalam mesej yang disulitkan. Pelayan hanya menerima fail `encrypted.bin` dan tidak boleh memeriksa tandatangan imej asal; jenis/saiz input diperiksa pada klien, had saiz ciphertext pada pelayan.
- Penerima mengambil fail sulit, membukanya secara setempat, kemudian memaparkan URL blob. Akses fail pada pelayan tetap terhad kepada peserta perbualan.

## Chat, panggilan dan lokasi

Chat masa nyata menggunakan Socket.IO, dengan sejarah SQLite, tanda dibaca, belum dibaca, kehadiran, sedang menaip, emoji dan carian kenalan/perbualan. Enter menghantar mesej; Shift+Enter membuat baris baharu.

Tetapan rupa menyediakan Soft Purple, Soft Blue, Soft Green, Soft Grey dan warna tersuai. Gambar sendiri boleh disimpan sebagai wallpaper chat secara setempat pada peranti tanpa dihantar ke pelayan.

Panggilan berdua menyokong jawab/tolak, tamatkan, bisu dan hidup/matikan kamera. Kedua-dua pengguna mesti membuka aplikasi. Ujian automatik isyarat tidak menggantikan ujian kamera/mikrofon sebenar pada dua peranti; ujian tersebut belum dilakukan.

Lokasi langsung boleh dikongsi selama 15 minit, 1 jam, 8 jam atau sehingga dihentikan. Android menjalankan servis foreground sepanjang perkongsian dan menyegarkan lokasi apabila aplikasi kembali aktif; pelayar atau Android masih boleh menjeda GPS apabila aplikasi dihentikan oleh sistem. Kad memaparkan peta MapLibre dan cap masa terakhir, manakala peta bersama boleh menunjukkan kedua-dua pengguna serentak. Lokasi tempat menarik boleh disimpan dalam ruang **Places**.

Butang Henti menghentikan GPS segera dan menghantar kemas kini yang disulitkan. Menutup atau meminimumkan halaman tidak lagi menandakan perkongsian sebagai dihentikan secara automatik. Selepas muat semula, gunakan **Resume location updates** jika perkongsian belum tamat.

## Telefon / Internet

Web Crypto, kamera, mikrofon dan GPS memerlukan **HTTPS atau localhost**. HTTP biasa menggunakan IP LAN tidak menyokong aliran chat E2EE ini. `localhost` pada telefon merujuk kepada telefon sendiri.

Hoskan pada pelayan Node.js yang menyokong WebSocket, storan kekal dan HTTPS. Reverse proxy mesti menyokong WebSocket dan muat naik sekurang-kurangnya 2 MB. SQLite serta daftar panggilan/kehadiran sesuai untuk satu proses pelayan; pindahkan pangkalan data dan selaraskan Socket.IO sebelum menggandakan proses/pelayan.

Lihat `.env.example`. Fail `.env` tidak dibaca automatik oleh `npm start`; eksport pemboleh ubah atau gunakan:

```sh
node --env-file=.env server.js
```

Untuk production, ikut [ALMALINUX.md](ALMALINUX.md); HTTPS origin, Secure cookie, proxy yang dipercayai, AUTH_SECRET dan SMTP diperlukan.

STUN disediakan. Rangkaian mudah alih, NAT atau firewall tertentu memerlukan TURN; tetapkan `TURN_URL`, `TURN_USERNAME` dan `TURN_CREDENTIAL`. Gunakan kelayakan TURN jangka pendek/akses terhad untuk production.

## Data dan naik taraf

`data/sembang.sqlite` menyimpan akaun, sesi, kunci awam, sandaran kunci sulit dan mesej. `data/uploads/` menyimpan fail chat yang disulitkan, manakala `data/avatars/` menyimpan foto profil. Sandarkan seluruh folder `data/` bersama-sama. `DATA_DIR=/absolute/path npm start` menukar lokasi data.

Storan peranti juga penting: kunci IndexedDB terikat kepada origin (protokol, hostname dan port). Selepas mengubah origin, log masuk semula dengan emel dan kata laluan untuk membuka sandaran kunci daripada pelayan yang sama. Tiada pemadaman mesej atau fail lama semasa naik taraf ini. Fail/mesej lama kekal dalam format asal dan tidak mendapat perlindungan penyulitan baharu secara automatik.

Pemulihan kata laluan melalui emel disediakan. Chat berkumpulan dan background calls belum tersedia; aplikasi ini juga belum direka untuk perlindungan penyalahgunaan berskala besar.

## Ujian

```sh
npm test
```

34 ujian integrasi/kriptografi dan backend meliputi kelulusan akaun oleh Owner, profil ahli, login serentak web/peranti, ciphertext dalam pangkalan data/fail, penolakan plaintext, AES-GCM tampering, pengikatan konteks, pemulihan kunci dengan kata laluan betul/salah, kunci tidak boleh ditukar, akses fail, lokasi sulit, isyarat panggilan sulit, pagination, sesi dan restart. Pangkalan data ujian sementara tidak menyentuh data pengguna.

Semakan pelayar turut mengesahkan pemulihan kunci, mesej, muat semula sejarah, pemampatan JPEG 73 KB → WebP 55 KB (24%), pembukaan gambar daripada ciphertext dan paparan telefon 390 px.

Untuk data contoh berasingan:

```sh
node test/browser-fixture.js
```

Buka `http://localhost:3001` dan log masuk `aina_qa@example.com` / `ujian-sembang-123`. Semua akaun ialah data ujian sementara. Ctrl+C membersihkan data contoh. Gunakan pelayar ujian berasingan untuk mengelakkan kuki localhost bertindih dengan aplikasi sebenar.

## Aset dan sumber

Latar sebenar Stitch & Angel oleh **burnss / Wallpapers.com**, dimuat turun tanpa mengubah piksel. Kredit dipaparkan pada skrin utama dan Tentang Zbuddy. Sumber mengehadkan kepada kegunaan peribadi dengan atribusi; lihat [nota aset](public/assets/ASSETS.md). Dua percubaan built-in ImageGen ditolak; tiada imej janaan digunakan.

Rujukan: [Web Crypto deriveKey](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey), [AES-GCM](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams), [WebRTC](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Signaling_and_video_calling), [Socket.IO](https://socket.io/docs/v4/server-api/).
