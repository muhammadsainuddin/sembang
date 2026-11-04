# Zbuddy Android (.apk)

ID aplikasi/Firebase: `my.aigeo.private`. Namespace kod Java: `my.aigeo.zbuddy` kerana `private` ialah kata kunci Java dan tidak sah sebagai segmen package source.

Firebase Android disambungkan melalui `android/app/google-services.json`, Google Services plugin 4.5.0 dan Firebase BoM 35.1.0. Cloud Messaging tersedia pada klien dan Android 13+ meminta kebenaran notifikasi ketika aplikasi dibuka.

**Source Android dan APK release:** 1.14.1, `releases/zbuddy-v1.14.1.apk`.
**Pelayan:** backend Node.js 1.14.1, pakej `releases/zbuddy-nodejs-server-v1.14.1.zip`. Panduan VPS: [ALMALINUX.md](ALMALINUX.md).

APK menggunakan Android WebView untuk menjalankan antara muka JavaScript daripada pelayan Node.js yang dipilih. Ia menambah pemilihan pelayan, kebenaran kamera/mikrofon/GPS, kamera foto/video dan pemilih galeri utama Android, butang Back dan pautan peta ke aplikasi luar. Foto kamera dikecilkan secara native sebelum diserahkan kepada halaman bagi mengurangkan penggunaan memori dan risiko WebView tertutup. Node.js tidak dibenamkan dalam APK; satu pelayan berkongsi diperlukan untuk menghubungkan pengguna.

## Pasang dan sambung

Zbuddy membawa 30 ikon Kelopak yang direka khas, favicon dan ikon launcher Android yang sepadan. Ikon panggilan menggunakan gelombang suara; status dibaca menggunakan dua kelopak.

1. Salin APK ke telefon Android 8.0+ dan buka untuk memasang. Android mungkin meminta kebenaran memasang daripada aplikasi yang membuka fail; pilih sendiri pada telefon.
2. Jalankan pelayan Node.js. Lihat `SERVER.md` untuk ujian USB dan deployment VPS + HTTPS.
3. APK production menggunakan `https://private.aigeo.my` secara lalai. Pada skrin pertama, semak alamat itu dan tekan **Sambung ke Zbuddy**.
4. Cipta akaun, sahkan emel dan cari kenalan. Kenalan mesti menggunakan pelayan yang sama dan menyediakan kunci mereka sekali.

Untuk ujian USB sahaja:

```sh
npm start
adb reverse tcp:3000 tcp:3000
adb install -r releases/zbuddy-v1.14.1.apk
```

Pilih **Uji melalui USB** dalam APK. Jangan gunakan `10.0.2.2` atau IP LAN HTTP untuk menggantikan localhost kerana Web Crypto memerlukan secure context. Untuk penggunaan tanpa USB, hoskan Node.js pada domain HTTPS dengan sijil sah.

## Akaun dan kunci

Kuki dan IndexedDB Android berada dalam sandbox aplikasi, berasingan daripada pelayar komputer. Pada penggunaan pertama Android atau selepas data aplikasi dipadam, log masuk dengan emel dan kata laluan untuk membuka sandaran kunci chat. Origin (protokol/hostname/port) menentukan storan kunci; bertukar domain memerlukan log masuk semula. Backup automatik aplikasi dinyahdayakan.

Salin kod menggunakan clipboard Android dengan penandaan sensitif. Muat turun kod membuka pemilih lokasi simpan Android; fail teks hanya ditulis setelah pengguna memilih lokasi. Native message listener hanya menerima mesej daripada main frame origin pelayan yang dipilih. Tiada JavaScript interface terbuka kepada semua laman.

Permintaan kamera/mikrofon/lokasi hanya diluluskan kepada origin pelayan yang dipilih dan mengikut kebenaran Android. Tiada akses galeri menyeluruh, pintasan sijil HTTPS atau cleartext Internet; HTTP hanya diizinkan untuk loopback ujian USB. Pelayar luar mengendalikan pautan di luar pelayan.

## Bina semula

Perlu Node.js, Android Studio SDK (platform 36), JDK 17+ dan Internet pada binaan pertama.

```sh
npm run android:check
```

Arahan ini menjalankan ujian unit URL, Android lint, membina release APK bertandatangan dan menyalin output ke `releases/`. Binaan biasa selepas perubahan:

```sh
npm run android:build
```

`JAVA_HOME` dan `ANDROID_HOME` boleh ditetapkan sendiri. Pada macOS, skrip mengenali runtime JDK Android Studio dan SDK dalam `~/Library/Android/sdk`. Gradle Wrapper 8.13 menggunakan checksum rasmi; Android Gradle Plugin 8.13.0, compile SDK 36, target SDK 35 dan min SDK 26.

Pilihan untuk menetapkan domain lalai ketika binaan (tetapan dalam aplikasi masih boleh diubah):

```sh
SEMBANG_SERVER_URL=https://private.aigeo.my npm run android:build
```

**Simpan folder `android/.signing/` secara peribadi dan sandarkannya.** Kunci tandatangan serta kata laluannya dijana secara tempatan pada binaan pertama dan diabaikan oleh Git. Ia diperlukan untuk mengemas kini APK yang sudah dipasang. Jangan masukkan folder ini dalam pakej pelayan atau kongsi secara terbuka. Fail `.apk.sha256` menyemak integriti fail; APK juga mempunyai tandatangan Android.

## Had dan ujian

Ini aplikasi hybrid: shell, kamera/galeri, notifikasi dan servis foreground menggunakan Android native; chat, E2EE, peta dan panggilan menggunakan WebView/JavaScript yang sama seperti web. Latar datang daripada pelayan. Aplikasi memerlukan sambungan ke Node.js; tiada chat offline. Lokasi langsung tidak boleh dijamin jika Android menghentikan aplikasi. TURN mungkin diperlukan untuk panggilan merentas rangkaian.

Ujian automatik pelayan: `npm test`. Ujian Android: `npm run android:check`. Tandatangan APK diperiksa dengan `apksigner verify`. Pengesahan peranti fizikal dan panggilan suara/video dua peranti perlu dilakukan sebelum penggunaan sebenar.

Rujukan: [Android WebView](https://developer.android.com/develop/ui/views/layout/webapps/webview), [WebChromeClient](https://developer.android.com/reference/android/webkit/WebChromeClient).

Pengesahan binaan ini: ujian unit Android, Android lint dan release assembly lulus; 34 ujian Node/kriptografi turut lulus. Semakan interaksi skrin Android, kamera/mikrofon/GPS serta panggilan dua telefon masih perlu dibuat pada peranti sebenar.
