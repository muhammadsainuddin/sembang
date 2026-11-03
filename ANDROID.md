# Sembang Android (.apk)

**APK:** `releases/sembang-v1.3.0.apk`
**Pelayan:** backend Node.js 1.4.0, pakej `releases/sembang-nodejs-server-v1.4.0.zip`. Panduan VPS: [ALMALINUX.md](ALMALINUX.md). APK 1.3.0 kekal serasi; borang kod emel production dimuatkan daripada pelayan.

APK menggunakan Android WebView untuk menjalankan antara muka JavaScript daripada pelayan Node.js yang dipilih. Ia menambah pemilihan pelayan, kebenaran kamera/mikrofon/GPS, pemilih gambar Android, butang Back, pautan peta ke aplikasi luar serta simpan/salin kod pemulihan melalui Android. Node.js tidak dibenamkan dalam APK; satu pelayan berkongsi diperlukan untuk menghubungkan pengguna.

## Pasang dan sambung

Versi 1.3.0 membawa 30 ikon Kelopak yang direka khas untuk Sembang, monogram S baharu, favicon dan ikon launcher Android yang sepadan. Ikon panggilan menggunakan gelombang suara; status dibaca menggunakan dua kelopak. Pasang APK 1.3.0 untuk ikon launcher dan menu native baharu. Ikon dalam chat datang daripada pelayan Node.js 1.3.0.

1. Salin APK ke telefon Android 8.0+ dan buka untuk memasang. Android mungkin meminta kebenaran memasang daripada aplikasi yang membuka fail; pilih sendiri pada telefon.
2. Jalankan pelayan Node.js. Lihat `SERVER.md` untuk ujian USB dan deployment VPS + HTTPS.
3. Pada skrin pertama APK, masukkan alamat pelayan `https://domain-kamu` dan tekan **Sambung ke Sembang**.
4. Cipta akaun, simpan kod pemulihan dan cari kenalan. Kenalan mesti menggunakan pelayan yang sama dan menyediakan kunci mereka sekali.

Untuk ujian USB sahaja:

```sh
npm start
adb reverse tcp:3000 tcp:3000
adb install -r releases/sembang-v1.3.0.apk
```

Pilih **Uji melalui USB** dalam APK. Jangan gunakan `10.0.2.2` atau IP LAN HTTP untuk menggantikan localhost kerana Web Crypto memerlukan secure context. Untuk penggunaan tanpa USB, hoskan Node.js pada domain HTTPS dengan sijil sah.

## Akaun dan kunci

Kuki dan IndexedDB Android berada dalam sandbox aplikasi, berasingan daripada pelayar komputer. Akaun sedia ada memerlukan kod pemulihan pada penggunaan pertama Android. Origin (protokol/hostname/port) juga menentukan storan kunci; bertukar domain mungkin memerlukan kod semula. Menyahpasang APK atau mengosongkan datanya memadam kunci. Backup automatik aplikasi dinyahdayakan; simpan kod pemulihan sendiri.

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
SEMBANG_SERVER_URL=https://chat.domain-kamu npm run android:build
```

**Simpan folder `android/.signing/` secara peribadi dan sandarkannya.** Kunci tandatangan serta kata laluannya dijana secara tempatan pada binaan pertama dan diabaikan oleh Git. Ia diperlukan untuk mengemas kini APK yang sudah dipasang. Jangan masukkan folder ini dalam pakej pelayan atau kongsi secara terbuka. Fail `.apk.sha256` menyemak integriti fail; APK juga mempunyai tandatangan Android.

## Had dan ujian

Ini pembungkus Android bagi aplikasi sedia ada, bukan penulisan semula React Native. Ciri chat, E2EE, pemampatan dan panggilan menggunakan JavaScript yang sama. Latar datang daripada pelayan. Aplikasi memerlukan sambungan ke Node.js; tiada chat offline atau push/background calls. Lokasi langsung tidak boleh dijamin semasa aplikasi dijeda Android. TURN mungkin diperlukan untuk panggilan merentas rangkaian.

Ujian automatik pelayan: `npm test`. Ujian Android: `npm run android:check`. Tandatangan APK diperiksa dengan `apksigner verify`. Pengesahan peranti fizikal dan panggilan suara/video dua peranti perlu dilakukan sebelum penggunaan sebenar.

Rujukan: [Android WebView](https://developer.android.com/develop/ui/views/layout/webapps/webview), [WebViewCompat origin-scoped messaging](https://developer.android.com/reference/androidx/webkit/WebViewCompat), [WebChromeClient](https://developer.android.com/reference/android/webkit/WebChromeClient).

Pengesahan binaan ini: 3 ujian unit Android, Android lint dan 15 ujian Node/kriptografi lulus; tandatangan APK v2 disahkan dan pemasangan pada emulator Android berjaya. Semakan interaksi skrin Android, kamera/mikrofon/GPS serta panggilan dua telefon belum diselesaikan.
