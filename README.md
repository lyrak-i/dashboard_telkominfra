# Telkominfra — Dasbor KPI Tiket

Dashboard ringan untuk membaca ekspor tiket operasional. Dibuat hanya dengan **HTML, CSS, dan JavaScript**. Tidak menggunakan React, Vite, npm, backend, atau koneksi internet.

## Cara menjalankan

1. Simpan file `index.html`, `style.css`, `app.js`, `papaparse.min.js`, dan `xlsx.full.min.js` bersama di folder yang sama.
2. Klik ganda `index.html` — Firefox akan membuka dashboard langsung dari disk.
3. Seret satu atau beberapa file CSV/XLSX ke area unggah, atau klik untuk memilih file.

Tombol **Muat contoh data demo** memakai data sintetis yang tertanam di `app.js`; data tersebut bukan data produksi dan mengganti data yang sedang dimuat.

## Gabungkan ekspor bulanan

- Pilih beberapa file sekaligus (Ctrl/Shift saat memilih) atau seret beberapa file ke area unggah.
- Saat dashboard sudah terbuka, **Tambah file** menambahkan bulan berikutnya ke data yang ada; **Ganti semua file** memulai set data baru.
- File CSV dan XLSX boleh dicampur. Untuk workbook XLSX, lembar kerja pertama yang dibaca.
- Header dicocokkan tanpa membedakan huruf besar/kecil, spasi, tanda hubung, atau garis bawah. Kolom berbeda digabung dengan urutan file pertama; kolom yang tidak ada pada suatu file dianggap kosong.
- Dashboard membuang **baris yang sama persis** di seluruh kolom sumber. Baris yang berbeda walau hanya status, catatan, atau waktu tetap dipertahankan.
- Jumlah duplikat yang dibuang ditampilkan di bawah ringkasan file; file yang gagal dibaca dilaporkan, tidak diam-diam diabaikan.
- Pemrosesan berjalan berurutan dan lokal di peramban untuk menghindari pemakaian memori berlebihan. Batas ukuran 150 MB per file.

## Isi file

- **`index.html`** — susunan halaman, area unggah, filter, kartu KPI, grafik, dan tabel.
- **`style.css`** — warna, jarak, kartu, dan aturan responsif dari ponsel hingga desktop.
- **`app.js`** — seluruh logika: baca file, normalisasi header, penggabungan, deduplikasi, filter, KPI, grafik SVG, tabel, dan ekspor.
- **`papaparse.min.js`** — pembaca CSV lokal.
- **`xlsx.full.min.js`** — pembaca workbook Excel lokal (SheetJS).

Semua pustaka disimpan di folder proyek; tidak ada koneksi internet saat dashboard berjalan.

## Filter durasi penyelesaian

Di baris filter terdapat dua input **Durasi (jam)** — dari dan sampai. Nilainya dihitung dari **`Cleared Time − DateOccured`**, bukan kolom `Duration` maupun `MTTR (Hours)`.

- Contoh `dari = 1`, `sampai = 3` berarti **1 ≤ durasi < 3 jam** (batas bawah termasuk, batas atas belum termasuk). Kosong satu sisi = tanpa batas.
- Filter ini berlaku untuk seluruh data yang sudah dimuat (semua bulan), jadi rentang tanggal bisa dikosongkan untuk melihat seluruh periode.
- Bisa dikombinasikan dengan filter tanggal, NOP, Cluster, Severity, Status, dan SLA; semua KPI, grafik, serta tabel ikut berubah.
- Baris tanpa `Cleared Time`, tanggal tidak valid, atau cleared sebelum terjadinya tiket tidak cocok dengan rentang durasi dan tidak ikut terhitung saat filter aktif. Tanpa filter durasi, baris-baris tersebut tetap ditampilkan.

## Kolom yang dikenali

CSV menerima pemisah titik koma (`;`) maupun koma (`,`). Kolom utama: `DateOccured`, `Ticket Status`, `SLA`, `MTTR (Hours)`, `Severity`, `Rootcause Category`, `Cluster`, `NOP`, `Site`, `Site Name`, `WO Ticket No`, `Rootcause 1`, `PIC Name`, `Remarks`.

Header seperti `mttr_hours` dan `MTTR (Hours)` dicocokkan sebagai kolom yang sama. Tanggal ekspor KPI memakai format `DD-MM-YYYY HH:mm:ss`. Kolom yang tidak ada akan dilewati; petunjuk ditampilkan untuk kolom metrik utama yang hilang.

## Definisi KPI

- **Total Tiket:** semua baris unik yang cocok dengan filter.
- **Kepatuhan SLA:** `IN SLA ÷ (IN SLA + OUT SLA)`; status SLA lain tidak masuk penyebut.
- **MTTR Rata-rata:** rata-rata `MTTR (Hours)` untuk tiket `CLOSED`; nilai negatif/tidak valid dikecualikan. Median dan jumlah sampel ditampilkan juga.
- **Tiket Terbuka:** status selain `CLOSED` atau `RESOLVED`.
- **Tren Akar Masalah:** per bulan bila lebih dari 62 hari berbeda, selain itu per hari; pilih hingga enam kategori garis.
- **Deduplikasi:** hanya baris dengan nilai identik pada semua kolom sumber yang dibuang.

Filter tanggal, NOP, Cluster, Severity, Status, dan SLA berlaku bersama pada KPI, grafik, serta tabel. Tabel menampilkan 50 baris per halaman dan bisa diekspor ke CSV tersaring.

## Deploy

Folder ini sudah menjadi situs statis — tidak ada perintah build.

- **Netlify Drop:** unggah folder atau arsip ZIP yang berisi file-file situs.
- **Vercel:** impor repository, framework **Other**, build command kosong, output directory `.`.
- **GitHub Pages:** unggah file ke repository, aktifkan Pages untuk branch tersebut.

Untuk deploy, unggah **semua file bersama-sama**, termasuk `papaparse.min.js` dan `xlsx.full.min.js`.

## Privasi

File yang Anda pilih dibaca dan dihitung di dalam peramban. Tidak ada unggahan ke server. Jangan menaruh data produksi di folder deploy atau mengunggahkannya ke repository publik.
