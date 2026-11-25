# Wallpaper AGY + TPS

Tema OLED, wallpaper animasi, dan meter **TPS + konteks** untuk Google Antigravity Desktop. Buka lewat **Antigravity Kit** agar meter muncul otomatis di atas kotak chat. Panel **TPS Monitor** menyediakan grafik, riwayat, dan informasi cache.

| Fitur | Cara pakai |
| --- | --- |
| Wallpaper | Klik **Tema** di dekat **Settings**. Unggah, ganti, atau hapus GIF, MP4, dan WebM sampai **300 MB**. Klik **Minimalkan** untuk menutup panel tema. |
| TPS dan konteks | Meter mengikuti percakapan aktif. **≈** menandai estimasi. **—** muncul saat metrik belum tersedia atau judul percakapan ambigu. |
| Panel detail | Buka **TPS Monitor** dari panel plugin Antigravity. Dari chat Antigravity, Anda juga bisa meminta tautan `sidecar://wallpaper-agy-tps/tps_monitor/`. |
| Mulai otomatis | Gunakan opsi instalasi saat login di bawah. Untuk memilih wallpaper, gunakan file media Anda sendiri. |

Paket komunitas ini memakai [Antigravity Desktop resmi](https://antigravity.google/download), [Node.js 24+](https://nodejs.org/) dan [FFmpeg](https://ffmpeg.org/download.html) dengan encoder `libvpx-vp9`. Git diperlukan untuk langkah kloning. Kompatibilitas antarmuka ditargetkan untuk Antigravity Desktop 2.34.0. Komponen paket diuji di Windows. Installer macOS telah diperiksa sintaksnya dan masih memerlukan uji langsung di Mac.

## Instalasi Windows

Jika Node.js dan FFmpeg belum ada, jalankan di PowerShell lalu buka terminal baru.

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Gyan.FFmpeg -e
```

Keluar dari Antigravity Desktop melalui **Quit/Exit**, lalu jalankan.

```powershell
git clone https://github.com/Sorosjenaka/Wallpaper-AGY-TPS.git
cd Wallpaper-AGY-TPS
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\install-windows.ps1
```

Buka **Antigravity Kit** dari Start Menu. Untuk menambahkannya ke startup Windows, jalankan installer yang sama dengan `-StartAtLogin`. Installer mendaftarkannya di folder Startup dan Registry Run (`HKCU`), jadi wallpaper tetap terpasang setelah restart. Untuk lokasi pemasangan khusus, tambahkan `-AntigravityPath "D:\Apps\Antigravity\Antigravity.exe"`.

## Instalasi macOS

Taruh **Antigravity.app** di **Applications** dan keluar dari aplikasi dengan **⌘Q**. Jika menggunakan [Homebrew](https://brew.sh/), instal dependensi dari Terminal.

```sh
brew install node@24 ffmpeg
export PATH="$(brew --prefix node@24)/bin:$PATH"
git clone https://github.com/Sorosjenaka/Wallpaper-AGY-TPS.git
cd Wallpaper-AGY-TPS
sh ./install-macos.sh
open "$HOME/Applications/Antigravity Kit.app"
```

Untuk menjalankannya pada login berikutnya, gunakan `sh ./install-macos.sh --start-at-login`. Installer juga menerima `--app-path "/lokasi/Antigravity.app/Contents/MacOS/Antigravity"`.

## Mode Obsidian Prism

Mode opsional ini menaruh TPS, cache, dan konteks di baris bawah composer. Klik metrik untuk membuka rincian TTFT atau panel konteks. Mode ini juga menambahkan slider **Reasoning Effort**, maskot animasi, dan **View Usage**. Wallpaper dan menu **Tema** datang dari Antigravity Kit.

Tutup Antigravity, lalu jalankan salah satu perintah ini dari folder repo. Setelah itu buka kembali **Antigravity Kit**.

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\install-windows.ps1 -WithPrism
```

```sh
sh ./install-macos.sh --with-prism
```

Installer mengambil source Prism **v1.0.8-beta.2** di revisi yang dipatok dan menerapkan patch slider lokal. Saat slider digeser, knob dan isian mengikuti pointer tanpa menggambar ulang partikel pada setiap gerakan. Mode ini diuji di Windows. Jalur macOS tersedia dengan pemeriksaan sintaks, dan masih memerlukan pengujian langsung di Mac.

Mode Kit menyembunyikan notifikasi otomatis **Memory & Conversation DB Guard**. Pemeriksaan dan arsip manual tetap tersedia lewat pengaturan Prism.

Untuk kembali ke mode TPS Kit, jalankan installer dengan `-WithoutPrism` di Windows atau `--without-prism` di macOS. Instalasi Prism dan pengaturannya tetap tersimpan agar bisa diaktifkan lagi. Kredit, versi sumber, dan lisensi patch ada di [dokumen Prism](prism/README.md).

## Pengaturan wallpaper

File sumber hingga **4K** dan **300 MB** diproses secara lokal. Kit menyimpan versi WebM hingga **3840 × 2160**, **120 detik**, dan **60 FPS**. Video diputar tanpa audio dan dijeda saat jendela chat tersembunyi. Untuk impor berikutnya, Anda dapat memilih batas `-MaxFps 30` atau `-MaxFps 120` di Windows. Di macOS gunakan `sh ./install-macos.sh --max-fps 30` atau `--max-fps 120`.

FPS aktual bergantung pada file dan perangkat. Refresh rate layar seperti 240 Hz tetap mengikuti pengaturan layar sistem.

## Cara membuat pekerjaan AGY lebih cepat

1. **Kurangi putaran tool.** Pakai [agy-fast](https://github.com/INK-Q/agy-fast) untuk pekerjaan yang sering mencari atau membaca banyak file. Dengan Antigravity CLI `agy` terpasang, jalankan perintah berikut di Windows atau macOS. Buka percakapan baru dan cek daftar MCP untuk memastikan tool tersedia.

   ```sh
   agy plugin install https://github.com/INK-Q/agy-fast
   agy plugin enable agy-fast
   agy plugin list
   ```

2. **Jaga konteks tetap relevan.** Antigravity otomatis meringkas turn lama saat mendekati batas model. Saat pekerjaan mencapai satu milestone, gunakan `/compact` untuk membuat checkpoint dalam percakapan yang sama. Untuk pekerjaan lintas sesi, simpan keputusan dan langkah berikutnya di file proyek. [Dokumentasi `/compact`](https://antigravity.google/docs/commands/compact)
3. **Uji mode model dengan prompt yang sama.** Bandingkan beberapa respons tanpa tool untuk melihat waktu hingga teks pertama, TPS, dan waktu total. Gunakan konteks dan effort yang sebanding. Pilih effort rendah untuk tugas sederhana dan effort tinggi saat tugas memang perlu penalaran lebih panjang. [Panduan memilih model](https://antigravity.google/docs/models)

`agy-fast` dipasang terpisah. Penghematan waktu berasal dari pengurangan putaran tool dan konteks yang lebih terarah. Angka 500–600 tok/s bergantung pada model, beban layanan, dan jenis respons.

## Pemecahan masalah

- **Tema atau meter hilang.** Keluar sepenuhnya dari Antigravity, lalu buka **Antigravity Kit**. Antigravity yang sudah berjalan dapat membuka jendela melalui instans sebelumnya.
- **Meter terus kosong.** Tunggu percakapan memperoleh judul, lalu cek **TPS Monitor** di panel plugin. Beberapa versi atau model baru menampilkan token setelah satu respons selesai. Jika Anda punya plugin TPS lama, nonaktifkan plugin lama untuk menghindari dua meter.
- **Wallpaper terasa berat.** Turunkan batas ke 30 FPS dan unggah ulang temanya. Menu **Tema** juga memiliki tombol **Matikan wallpaper**.

## Pembaruan dan penghapusan

Tutup Antigravity, jalankan `git pull` di folder repo, lalu jalankan installer lagi. Untuk melepas paket, gunakan `powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\install-windows.ps1 -Uninstall` atau `sh ./install-macos.sh --uninstall`. Wallpaper yang sudah diimpor tetap disimpan di direktori data lokal pengguna.

Peluncur menggunakan pipe Chromium lokal pada mode standar dan port loopback sementara pada mode Prism. Plugin membaca metadata sesi melalui [sidecar Antigravity](https://antigravity.google/docs/sidecars) dan menyampaikan metrik ke meter lokal. Wallpaper, riwayat, dan cache sesi disimpan di perangkat.
