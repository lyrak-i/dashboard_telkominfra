/* =========================================================
   Dasbor KPI Tiket — app.js
   Satu-satunya file logika. Urutan bagian:

   1. Konstanta & utilitas       — warna, format angka, escape HTML
   2. Pembacaan CSV              — deteksi kolom, tanggal, angka
   3. Filter                     — menyaring baris
   4. KPI                        — empat angka utama
   5. Agregasi                   — tren, hitungan kategori
   6. Grafik SVG                 - menggambar grafik tanpa library
   7. Render                     — menulis KPI + grafik ke layar
   8. Tabel data                 — paginasi, urut, ekspor
   9. Unggah file                — seret-lepas & pemilih file
  10. Data contoh                — CSV sintetis tertanam
   ========================================================= */

/* ---------------------------------------------------------
   1. Konstanta & utilitas
   --------------------------------------------------------- */

// Urutan warna seri — tetap, tidak pernah digeser.
var SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
var COLOR_GOOD = '#0ca30c';
var COLOR_CRITICAL = '#d03b3b';
var COLOR_SURFACE = '#fcfcfb';
var COLOR_GRID = '#e1e0d9';
var COLOR_AXIS = '#c3c2b7';
var COLOR_MUTED = '#898781';
var COLOR_INK = '#0b0b0b';
var COLOR_INK2 = '#52514e';

var nfInt = new Intl.NumberFormat('id-ID');
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

var PAGE_SIZE = 50;
var MAX_MB = 150;
var MAX_ROOT_TREND_SERIES = 6;
var LABEL_EMPTY = 'Belum diisi';

function fmtInt(n) { return nfInt.format(Math.round(n || 0)); }
function fmtPct(n) { return (n == null ? '—' : n.toFixed(1).replace('.', ',') + '%'); }
function fmtNum2(n) { return n == null ? '—' : n.toFixed(2).replace('.', ','); }
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function debounce(fn, ms) {
  var t;
  return function () { clearTimeout(t); t = setTimeout(fn, ms); };
}
function svgIcon(id, cls) { return '<svg class="icon ' + (cls || '') + '"><use href="#' + id + '"/></svg>'; }

/* ---------------------------------------------------------
   2. Pembacaan CSV
   --------------------------------------------------------- */

// Nama kolom kanonik → sebutan header yang diterima (banding tanpa membedakan
// huruf besar/kecil dan spasi ganda).
var FIELD_ALIASES = {
  nop: ['nop'],
  cluster: ['cluster'],
  severity: ['severity'],
  status: ['ticket status', 'status'],
  sla: ['sla'],
  date: ['dateoccured', 'date occurred', 'tanggal', 'date'],
  cleared: ['cleared time', 'cleared', 'waktu selesai', 'site cleared on'],
  mttr: ['mttr (hours)', 'mttr', 'mttr hours'],
  rootcause: ['rootcause category', 'kategori akar masalah'],
  rootcause1: ['rootcause 1'],
  ticketType: ['ticket type', 'tipe tiket'],
  siteName: ['site name'],
  site: ['site'],
  wo: ['wo ticket no', 'wo no'],
  pic: ['pic name', 'pic'],
  remarks: ['remarks'],
  faultLevel: ['fault level'],
  isCheckin: ['is checkin'],
  duration: ['duration']
};

function normHeader(h) {
  return String(h == null ? '' : h).replace(/^﻿/, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Kunci pemadanan alias: buang seluruh karakter non-alfanumerik.
// 'MTTR (Hours)', 'mttr_hours' dan 'mttr-hours' → 'mttrhours'; 'DateOccured' → 'dateoccured'.
// Ekspor bulanan bisa memakai gaya penulisan berbeda untuk kolom yang sama.
function aliasKey(h) {
  return normHeader(h).replace(/[^a-z0-9]/g, '');
}

function detectSchema(headers) {
  var byNorm = {};
  headers.forEach(function (h) { byNorm[aliasKey(h)] = h; });
  var schema = {};
  Object.keys(FIELD_ALIASES).forEach(function (key) {
    var found = null;
    FIELD_ALIASES[key].some(function (a) {
      if (Object.prototype.hasOwnProperty.call(byNorm, aliasKey(a))) { found = byNorm[aliasKey(a)]; return true; }
      return false;
    });
    schema[key] = found;
  });
  return schema;
}

// Tanggal ekspor asli berformat DD-MM-YYYY HH:mm:ss. Terbukti DD-MM karena
// 25.000+ baris punya bagian pertama > 12.
function parseDate(v) {
  if (v == null) return null;
  var s = String(v).trim();
  if (!s) return null;
  var dmy = /^(\d{2})-(\d{2})-(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (dmy) {
    var t1 = new Date(+dmy[3], +dmy[2] - 1, +dmy[1], +(dmy[4] || 0), +(dmy[5] || 0), +(dmy[6] || 0)).getTime();
    return isNaN(t1) ? null : t1;
  }
  var iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    var t2 = new Date(+iso[1], +iso[2] - 1, +iso[3]).getTime();
    return isNaN(t2) ? null : t2;
  }
  var t3 = Date.parse(s);
  return isNaN(t3) ? null : t3;
}

function parseNumber(v) {
  if (v == null || v === '') return null;
  var n = Number(String(v).trim().replace(',', '.'));
  return isFinite(n) ? n : null;
}

function cleanHeaders(list) {
  var used = {};
  return list.map(function (h) {
    var header = String(h == null ? '' : h).replace(/^﻿/, '').trim();
    var key = aliasKey(header);
    if (used[key]) throw new Error('Ada dua judul kolom yang sama/serupa: "' + header + '". Periksa baris header file.');
    used[key] = true;
    return header;
  });
}

/** Parse teks CSV menjadi { rows, headers, schema, rowCount, errors }. */
function parseCsvText(text, fileName) {
  return new Promise(function (resolve) {
    Papa.parse(text, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: function (h) { return String(h == null ? '' : h).replace(/^﻿/, '').trim(); },
      complete: function (results) {
        var errors = (results.errors || []).slice(0, 3).map(function (e) { return e.message; });
        var headers;
        try {
          headers = cleanHeaders(results.meta && results.meta.fields ? results.meta.fields : []);
        } catch (err) {
          resolve({ error: err.message });
          return;
        }
        if (!headers.length || !results.data.length) {
          resolve({ error: 'File tidak berisi baris data yang terbaca. Pastikan file CSV dengan baris judul.' });
          return;
        }
        var out = normalizeRows(results.data, headers, fileName);
        out.errors = errors;
        resolve(out);
      },
      error: function (err) {
        resolve({ error: 'Gagal membaca file: ' + ((err && err.message) || 'tidak diketahui') });
      }
    });
  });
}

function parseCsvFile(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () {
      resolve(parseCsvText(String(reader.result), file.name));
    };
    reader.onerror = function () { reject(new Error('File tidak dapat dibaca.')); };
    reader.readAsText(file);
  });
}

/** Bangun { rows, headers, schema, errors } dari daftar objek baris apa pun. */
function normalizeRows(dataRows, headers, fileName) {
  if (!headers.length || !dataRows.length) {
    return { error: 'File tidak berisi baris data yang terbaca. Pastikan file dengan baris judul.' };
  }
  var schema = detectSchema(headers);
  for (var i = 0; i < dataRows.length; i++) {
    dataRows[i].__ts = schema.date ? parseDate(dataRows[i][schema.date]) : null;
    dataRows[i].__mttr = schema.mttr ? parseNumber(dataRows[i][schema.mttr]) : null;
    dataRows[i].__resolutionHours = resolutionHours(dataRows[i], schema);
  }
  return { rows: dataRows, headers: headers, schema: schema, errors: [], rowCount: dataRows.length, fileName: fileName };
}

/**
 * Lama penyelesaian dari timestamp kejadian ke timestamp cleared.
 * Nilai invalid/negatif menjadi null; filter durasi mengecualikannya.
 */
function resolutionHours(row, schema) {
  if (!schema.date || !schema.cleared) return null;
  var occurred = row.__ts != null ? row.__ts : parseDate(row[schema.date]);
  var cleared = parseDate(row[schema.cleared]);
  if (occurred == null || cleared == null) return null;
  var hours = (cleared - occurred) / 3600000;
  return Number.isFinite(hours) && hours >= 0 ? hours : null;
}

/**
 * Baca workbook .xlsx memakai SheetJS (disetor lokal).
 * Lembar pertama dibaca sebagai baris berkepala — kolomnya lewat normalizeRows,
 * sehingga seluruh perhitungan dasbor sama persis dengan jalur CSV.
 */
function parseXlsxFile(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onerror = function () { reject(new Error('File tidak dapat dibaca.')); };
    reader.onload = function (e) {
      try {
        if (typeof XLSX === 'undefined') {
          resolve({ error: 'Pustaka XLSX belum termuat. Pastikan file xlsx.full.min.js berada di folder yang sama dengan index.html.' });
          return;
        }
        var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: false });
        var sheetName = wb.SheetNames[0];
        if (!sheetName) { resolve({ error: 'Workbook tidak memiliki lembar kerja.' }); return; }
        var aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: false, blankrows: false });
        // buang baris kosong sepenuhnya di depan (preamble laporan umumnya begitu)
        while (aoa.length && aoa[0].every(function (c) { return String(c == null ? '' : c).trim() === ''; })) aoa.shift();
        if (!aoa.length) { resolve({ error: 'Lembar pertama tidak berisi data.' }); return; }
        var headers = cleanHeaders(aoa[0]);
        var dataRows = [];
        for (var r = 1; r < aoa.length; r++) {
          var line = aoa[r];
          if (!line || line.every(function (c) { return String(c == null ? '' : c).trim() === ''; })) continue;
          var obj = {};
          for (var c = 0; c < headers.length; c++) obj[headers[c]] = line[c] == null ? '' : line[c];
          dataRows.push(obj);
        }
        resolve(normalizeRows(dataRows, headers, file.name));
      } catch (err) {
        resolve({ error: 'Gagal membaca workbook: ' + (err && err.message ? err.message : 'format tidak dikenali') });
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

/** Deteksi format dari ekstensi lalu teruskan ke pembaca yang tepat. */
function parseDataFile(file) {
  return /\.xlsx$/i.test(file.name) ? parseXlsxFile(file) : parseCsvFile(file);
}

/* ---------------------------------------------------------
   2b. Penggabungan berkas & deduplikasi
   --------------------------------------------------------- */

/**
 * Gabungkan header dalam urutan stabil: semua header file pertama, lalu kolom
 * baru dari file berikutnya. Header yang berbeda gaya tapi setara aliasnya
 * memakai nama tampilan dari file pertama.
 */
function mergeHeaders(files) {
  var headers = [];
  var byKey = Object.create(null);
  files.forEach(function (file) {
    file.headers.forEach(function (header) {
      var key = aliasKey(header);
      if (!Object.prototype.hasOwnProperty.call(byKey, key)) {
        byKey[key] = header;
        headers.push(header);
      }
    });
  });
  return headers;
}

/** Samakan setiap baris ke daftar header union; kolom yang tak ada = kosong. */
function alignRows(files, headers) {
  var headerKeys = headers.map(aliasKey);
  var rows = [];
  files.forEach(function (file) {
    var sourceByKey = Object.create(null);
    file.headers.forEach(function (h) { sourceByKey[aliasKey(h)] = h; });
    file.rows.forEach(function (row) {
      var aligned = {};
      headers.forEach(function (target, i) {
        var source = sourceByKey[headerKeys[i]];
        aligned[target] = source && row[source] != null ? row[source] : '';
      });
      rows.push(aligned);
    });
  });
  return rows;
}

/** Exact full-row only; changed values such as status or remarks are retained. */
function dedupeRows(rows, headers, existingKeys) {
  var seen = existingKeys || Object.create(null);
  var unique = [];
  var dropped = 0;
  rows.forEach(function (row) {
    // Compare every original column in union order; derived __ts/__mttr are excluded.
    var key = JSON.stringify(headers.map(function (h) { return row[h] == null ? '' : String(row[h]); }));
    if (Object.prototype.hasOwnProperty.call(seen, key)) { dropped++; return; }
    seen[key] = true;
    unique.push(row);
  });
  return { rows: unique, dropped: dropped, keys: seen };
}

function finalizeData(rows, headers, files, dedupe, errors) {
  var schema = detectSchema(headers);
  rows.forEach(function (row) {
    row.__ts = schema.date ? parseDate(row[schema.date]) : null;
    row.__mttr = schema.mttr ? parseNumber(row[schema.mttr]) : null;
    row.__resolutionHours = resolutionHours(row, schema);
  });
  return {
    rows: rows, headers: headers, schema: schema,
    errors: (errors || []).slice(0, 3), rowCount: rows.length,
    fileName: files.map(function (f) { return f.name; }).join(', '),
    dedupe: dedupe, files: files
  };
}

/* ---------------------------------------------------------
   3. Filter
   --------------------------------------------------------- */

var INITIAL_FILTERS = { nop: '', cluster: '', severity: '', status: '', sla: '', from: '', to: '', durationFrom: '', durationTo: '' };
var OPEN_STATUSES = { CLOSED: 1, RESOLVED: 1, SELESAI: 1, CLOSE: 1, 'CLOSE DONE': 1 };

function val(row, col) { return col ? String(row[col] == null ? '' : row[col]).trim() : ''; }

function distinctValues(rows, col) {
  if (!col) return [];
  var set = {};
  rows.forEach(function (r) { var v = val(r, col); if (v) set[v] = 1; });
  return Object.keys(set).sort(function (a, b) { return a.localeCompare(b, 'id'); });
}

function activeFilterCount(filters) {
  return Object.keys(filters).filter(function (k) { return filters[k]; }).length;
}

// Batas atas/bawah tanggal: pakai nilai yang dipilih, kalau kosong pakai
// rentang data yang sebenarnya.
function boundTs(chosen, rows, isEnd) {
  if (chosen) {
    var t = parseDate(chosen);
    if (t != null) return isEnd ? t + 86399999 : t;
  }
  var best = isEnd ? 0 : Infinity;
  for (var i = 0; i < rows.length; i++) {
    var ts = rows[i].__ts;
    if (ts == null) continue;
    if (isEnd ? ts > best : ts < best) best = ts;
  }
  if (isEnd) return best === 0 ? null : best;
  return best === Infinity ? null : best;
}

function applyFilters(rows, schema, filters) {
  var fromTs = boundTs(filters.from, rows, false);
  var toTs = boundTs(filters.to, rows, true);
  var hasDateWindow = fromTs != null || toTs != null;
  var fromDuration = filters.durationFrom === '' || filters.durationFrom == null ? null : Number(filters.durationFrom);
  var toDuration = filters.durationTo === '' || filters.durationTo == null ? null : Number(filters.durationTo);
  var hasDurationWindow = fromDuration != null || toDuration != null;
  return rows.filter(function (r) {
    if (filters.nop && val(r, schema.nop) !== filters.nop) return false;
    if (filters.cluster && val(r, schema.cluster) !== filters.cluster) return false;
    if (filters.severity && val(r, schema.severity) !== filters.severity) return false;
    if (filters.status && val(r, schema.status) !== filters.status) return false;
    if (filters.sla && val(r, schema.sla) !== filters.sla) return false;
    if (hasDateWindow) {
      if (r.__ts == null) return false;
      if (fromTs != null && r.__ts < fromTs) return false;
      if (toTs != null && r.__ts > toTs) return false;
    }
    if (hasDurationWindow) {
      if (r.__resolutionHours == null) return false;
      if (fromDuration != null && r.__resolutionHours < fromDuration) return false;
      if (toDuration != null && r.__resolutionHours >= toDuration) return false;
    }
    return true;
  });
}

/* ---------------------------------------------------------
   4. KPI
   --------------------------------------------------------- */

function computeKpis(rows, schema) {
  var total = rows.length;
  var open = 0, inSla = 0, outSla = 0, mttrSum = 0, mttrN = 0;
  var sites = {};
  var mttrAll = [];

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var st = val(r, schema.status).toUpperCase();
    if (st && !OPEN_STATUSES[st]) open++;

    var sla = val(r, schema.sla).toUpperCase();
    if (sla === 'IN SLA') inSla++;
    else if (sla === 'OUT SLA') outSla++;

    if (schema.site) { var s = val(r, schema.site); if (s) sites[s] = 1; }

    var m = r.__mttr;
    if (m != null && m >= 0) {
      mttrAll.push(m);
      if (st === 'CLOSED' || st === 'SELESAI') { mttrSum += m; mttrN++; }
    }
  }

  mttrAll.sort(function (a, b) { return a - b; });

  return {
    total: total,
    open: open,
    openPct: total ? (open / total) * 100 : 0,
    inSla: inSla,
    outSla: outSla,
    slaPct: inSla + outSla ? (inSla / (inSla + outSla)) * 100 : null,
    mttrAvg: mttrN ? mttrSum / mttrN : null,
    mttrN: mttrN,
    mttrMedian: mttrAll.length ? mttrAll[Math.floor(mttrAll.length / 2)] : null,
    sites: Object.keys(sites).length
  };
}

/* ---------------------------------------------------------
   5. Agregasi
   --------------------------------------------------------- */

function bucket(rows, keyFn, labelFn) {
  var map = {};
  var order = [];
  for (var i = 0; i < rows.length; i++) {
    var ts = rows[i].__ts;
    if (ts == null) continue;
    var key = keyFn(new Date(ts));
    if (!Object.prototype.hasOwnProperty.call(map, key)) { map[key] = 0; order.push(key); }
    map[key]++;
  }
  order.sort();
  return order.map(function (k) { return { key: k, label: labelFn(k), count: map[k] }; });
}

/**
 * Tren per akar masalah: satu baris per periode, satu kolom per kategori.
 * Aturan periode sama dengan tren lama: >62 hari berbeda → bulanan, selain itu harian.
 * `categories` dihitung dari seluruh baris tersaring (termasuk baris tanpa tanggal)
 * supaya daftar pilihan sama dengan grafik batang "Akar Masalah".
 */
function buildRootTrend(rows, schema) {
  var catCol = schema.rootcause;
  var daySet = {};
  var nDays = 0;
  var i, r, ts, d, key;

  for (i = 0; i < rows.length; i++) {
    ts = rows[i].__ts;
    if (ts == null) continue;
    d = new Date(ts);
    key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
    if (!daySet[key]) { daySet[key] = 1; nDays++; }
  }
  var monthly = nDays > 62;
  var keyFn = monthly
    ? function (x) { return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0'); }
    : function (x) {
      return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
    };
  var labelFn = monthly
    ? function (k) { var p = k.split('-'); return MONTHS[+p[1] - 1] + ' ' + p[0].slice(2); }
    : function (k) { var p = k.split('-'); return +p[2] + ' ' + MONTHS[+p[1] - 1]; };

  var byKey = {};
  var order = [];
  var catTotals = {};

  for (i = 0; i < rows.length; i++) {
    r = rows[i];
    var cat = catCol ? (String(r[catCol] == null ? '' : r[catCol]).trim() || LABEL_EMPTY) : null;
    if (cat) catTotals[cat] = (catTotals[cat] || 0) + 1;
    ts = r.__ts;
    if (ts == null || !cat) continue;
    key = keyFn(new Date(ts));
    if (!byKey[key]) { byKey[key] = {}; order.push(key); }
    byKey[key][cat] = (byKey[key][cat] || 0) + 1;
  }

  order.sort();
  var data = order.map(function (k) { return { key: k, label: labelFn(k), counts: byKey[k] }; });
  var categories = Object.keys(catTotals)
    .map(function (name) { return { name: name, value: catTotals[name] }; })
    .sort(function (a, b) { return b.value - a.value || a.name.localeCompare(b.name, 'id'); });

  return {
    granularity: monthly ? 'bulan' : 'hari',
    badge: monthly ? 'Bulanan' : 'Harian',
    data: data,
    categories: categories
  };
}

function countBy(rows, col, opts) {
  opts = opts || {};
  if (!col) return [];
  var map = {};
  rows.forEach(function (r) {
    var v = String(r[col] == null ? '' : r[col]).trim();
    if (!v) {
      if (opts.ignoreEmpty) return;
      v = opts.mapLabel || v;
      if (!v) return;
    }
    if (opts.pick) v = opts.pick(v) || v;
    map[v] = (map[v] || 0) + 1;
  });
  return Object.keys(map)
    .map(function (name) { return { name: name, value: map[name] }; })
    .sort(function (a, b) { return b.value - a.value || a.name.localeCompare(b.name, 'id'); });
}

/** Simpan `max` kategori teratas, sisanya digabung jadi "Lainnya". */
function topN(data, max, otherLabel) {
  if (data.length <= max) return data;
  var head = data.slice(0, max);
  var rest = data.slice(max).reduce(function (s, d) { return s + d.value; }, 0);
  if (rest > 0) head.push({ name: otherLabel || 'Lainnya', value: rest, isOther: true });
  return head;
}

var SEVERITY_ORDER = { low: 0, 'very low': 1, minor: 2, major: 3, critical: 4 };
function sortSeverity(data) {
  return data.map(function (d, i) {
    return { d: d, o: SEVERITY_ORDER[d.name.trim().toLowerCase()] != null ? SEVERITY_ORDER[d.name.trim().toLowerCase()] : i };
  })
    .sort(function (a, b) { return a.o - b.o; })
    .map(function (x) { return x.d; });
}

/* ---------------------------------------------------------
   6. Grafik SVG
   --------------------------------------------------------- */

/** Skala sumbu-Y "bagus": langkah 1/1.25/1.5/2/2.5/3/4/5/7.5/10 × 10^k. */
function niceScale(maxVal, tickCount) {
  tickCount = tickCount || 5;
  if (!(maxVal > 0)) return { max: 1, ticks: [0, 1] };
  var rough = maxVal / tickCount;
  var mag = Math.pow(10, Math.floor(Math.log10(rough)));
  var norm = rough / mag;
  var steps = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10];
  var nice = steps[steps.length - 1];
  for (var i = 0; i < steps.length; i++) { if (norm <= steps[i]) { nice = steps[i]; break; } }
  var step = nice * mag;
  // Semua metrik di dasbor ini berupa hitungan bulat. Paksa langkah bulat
  // supaya label sumbu tidak pernah dibulatkan jadi dobel (mis. 1,5 → "2").
  if (Number.isInteger(maxVal)) step = Math.max(1, Math.round(step));
  var max = Math.ceil(maxVal / step) * step;
  var ticks = [];
  for (var t = 0; t <= max + step * 1e-6; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return { max: max, ticks: ticks };
}

/** Ujung membulat hanya di sisi nilai (bar vertikal), tetap menempel di nol. */
function barPath(x, y, w, h, r) {
  r = Math.min(r || 4, w / 2, h);
  if (h <= 0.5) return 'M' + x + ',' + (y + h) + 'h' + w;
  return 'M' + x + ',' + (y + h) + 'V' + (y + r) +
    'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + (-r) +
    'h' + (w - 2 * r) +
    'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r +
    'V' + (y + h) + 'Z';
}

/** Ujung membulat hanya di sisi kanan (bar horizontal). */
function hbarPath(x, y, w, h, r) {
  r = Math.min(r || 4, h / 2, w);
  if (w <= 0.5) return 'M' + x + ',' + y + 'h0.5v' + h + 'h-0.5Z';
  return 'M' + x + ',' + y + 'H' + (x + w - r) +
    'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r +
    'V' + (y + h - r) +
    'a' + r + ',' + r + ' 0 0 1 ' + (-r) + ',' + r +
    'H' + x + 'Z';
}

/** Kurva halus (Catmull-Rom → bezier). Bila titik sedikit, pakai garis lurus. */
function smoothPath(pts) {
  if (pts.length === 0) return '';
  if (pts.length < 3) return 'M' + pts.map(function (p) { return p[0] + ',' + p[1]; }).join('L');
  var d = 'M' + pts[0][0] + ',' + pts[0][1];
  for (var i = 0; i < pts.length - 1; i++) {
    var p0 = pts[i > 0 ? i - 1 : 0];
    var p1 = pts[i];
    var p2 = pts[i + 1];
    var p3 = pts[i + 2 < pts.length ? i + 2 : pts.length - 1];
    var c1x = p1[0] + (p2[0] - p0[0]) / 6;
    var c1y = p1[1] + (p2[1] - p0[1]) / 6;
    var c2x = p2[0] - (p3[0] - p1[0]) / 6;
    var c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += 'C' + c1x + ',' + c1y + ' ' + c2x + ',' + c2y + ' ' + p2[0] + ',' + p2[1];
  }
  return d;
}

/** Cincin sektor untuk donat. */
function arcPath(cx, cy, rOuter, rInner, a0, a1) {
  var span = a1 - a0;
  if (span >= 359.999) { // satu-satunya slice = lingkaran penuh
    return 'M' + cx + ',' + (cy - rOuter) +
      'A' + rOuter + ',' + rOuter + ' 0 1 1 ' + cx + ',' + (cy + rOuter) +
      'A' + rOuter + ',' + rOuter + ' 0 1 1 ' + cx + ',' + (cy - rOuter) + 'Z' +
      'M' + cx + ',' + (cy - rInner) +
      'A' + rInner + ',' + rInner + ' 0 1 0 ' + cx + ',' + (cy + rInner) +
      'A' + rInner + ',' + rInner + ' 0 1 0 ' + cx + ',' + (cy - rInner) + 'Z';
  }
  var rad = Math.PI / 180;
  var x0o = cx + rOuter * Math.cos(a0 * rad), y0o = cy + rOuter * Math.sin(a0 * rad);
  var x1o = cx + rOuter * Math.cos(a1 * rad), y1o = cy + rOuter * Math.sin(a1 * rad);
  var x1i = cx + rInner * Math.cos(a1 * rad), y1i = cy + rInner * Math.sin(a1 * rad);
  var x0i = cx + rInner * Math.cos(a0 * rad), y0i = cy + rInner * Math.sin(a0 * rad);
  var large = span > 180 ? 1 : 0;
  return 'M' + x0o + ',' + y0o +
    'A' + rOuter + ',' + rOuter + ' 0 ' + large + ' 1 ' + x1o + ',' + y1o +
    'L' + x1i + ',' + y1i +
    'A' + rInner + ',' + rInner + ' 0 ' + large + ' 0 ' + x0i + ',' + y0i + 'Z';
}

function axisText(x, y, txt, anchor, rotate) {
  var tr = rotate ? ' transform="rotate(' + rotate + ' ' + x + ' ' + y + ')"' : '';
  return '<text x="' + x + '" y="' + y + '" text-anchor="' + anchor + '" fill="' + COLOR_MUTED +
    '" font-size="11"' + tr + '>' + esc(txt) + '</text>';
}

function emptyChart(msg) {
  return '<div class="empty-inline">' + svgIcon('i-layers') + '<p>' + esc(msg || 'Tidak ada data pada filter ini.') + '</p></div>';
}

/* --- 6a. Grafik garis (tren) --- */
function lineChart(data, width, categories) {
  categories = categories || [];
  if (!data.length || !categories.length) return emptyChart('Pilih setidaknya satu kategori akar masalah.');
  var W = Math.max(width || 560, 280);
  var H = 260;
  var m = { top: 14, right: 16, bottom: 34, left: 58 };
  var innerW = W - m.left - m.right;
  var innerH = H - m.top - m.bottom;
  var maxV = 0;
  data.forEach(function (point) {
    categories.forEach(function (cat) { maxV = Math.max(maxV, point.counts[cat] || 0); });
  });
  var sc = niceScale(maxV);
  var n = data.length;
  var xAt = function (i) { return n === 1 ? m.left + innerW / 2 : m.left + (i * innerW) / (n - 1); };
  var yAt = function (v) { return m.top + innerH - (v / sc.max) * innerH; };

  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H +
    '" role="img" aria-label="Grafik garis perbandingan kategori akar masalah">';

  // kisi + label sumbu-Y
  sc.ticks.forEach(function (t) {
    var y = yAt(t);
    svg += '<line x1="' + m.left + '" x2="' + (m.left + innerW) + '" y1="' + y + '" y2="' + y + '" stroke="' + COLOR_GRID + '"/>';
    svg += axisText(m.left - 8, y + 4, fmtInt(t), 'end');
  });
  svg += '<line x1="' + m.left + '" x2="' + (m.left + innerW) + '" y1="' + (m.top + innerH) + '" y2="' + (m.top + innerH) + '" stroke="' + COLOR_AXIS + '"/>';

  // label sumbu-X (dirapatkan supaya tidak bertumpuk)
  var maxLabels = Math.max(2, Math.floor(innerW / 68));
  var labelStep = Math.ceil(n / maxLabels);
  data.forEach(function (d, i) {
    if (i % labelStep !== 0 && i !== n - 1) return;
    svg += axisText(xAt(i), m.top + innerH + 20, d.label, i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle'));
  });

  // satu garis untuk setiap kategori terpilih; warna selalu mengikuti kategori.
  var pointsByCategory = {};
  categories.forEach(function (cat, seriesIndex) {
    var color = SERIES[seriesIndex];
    var pts = data.map(function (d, i) { return [xAt(i), yAt(d.counts[cat] || 0)]; });
    pointsByCategory[cat] = pts;
    svg += '<path d="' + smoothPath(pts) + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
    if (n <= 40) {
      pts.forEach(function (p) {
        svg += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="4" fill="' + color +
          '" stroke="' + COLOR_SURFACE + '" stroke-width="2"/>';
      });
    }
  });

  // Tooltip dekat setiap titik, target transparan lebih besar dari mark.
  data.forEach(function (d, i) {
    categories.forEach(function (cat, seriesIndex) {
      var p = pointsByCategory[cat][i];
      var color = SERIES[seriesIndex];
      svg += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="9" fill="transparent" data-line-i="' + i +
        '" data-tt="' + esc(cat) + ' · ' + esc(d.label) + '" data-tt2="' + fmtInt(d.counts[cat] || 0) +
        ' tiket" data-ttcolor="' + color + '"/>';
    });
  });
  svg += '</svg>';
  return svg;
}

/* --- 6b. Grafik batang tegak (status, severity, NOP) --- */
function barChart(data, width, height) {
  if (!data.length) return emptyChart();
  var W = Math.max(width || 480, 260);
  var H = height || 250;
  var rawLabels = data.map(function (d) { return d.name; });
  var longest = rawLabels.reduce(function (a, b) { return b.length > a.length ? b : a; }, '');
  var maxLabelW = Math.min(longest.length, 22) * 6.7;

  var m = { top: 16, right: 8, bottom: 34, left: 56 };
  var innerW = W - m.left - m.right;

  // Putar label bila muat tegak tidak cukup.
  var band = innerW / data.length;
  var rotate = maxLabelW > band - 6;
  if (rotate) m.bottom = Math.min(96, Math.round(16 + maxLabelW * 0.58));
  var innerH = H - m.top - m.bottom;

  var maxV = Math.max.apply(null, data.map(function (d) { return d.value; }));
  var sc = niceScale(maxV);
  var yAt = function (v) { return m.top + innerH - (v / sc.max) * innerH; };
  var barW = Math.min(band * 0.68, 72);
  var gap = (band - barW) / 2;

  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H +
    '" role="img" aria-label="Grafik batang perbandingan kategori">';

  sc.ticks.forEach(function (t) {
    var y = yAt(t);
    svg += '<line x1="' + m.left + '" x2="' + (m.left + innerW) + '" y1="' + y + '" y2="' + y + '" stroke="' + COLOR_GRID + '"/>';
    svg += axisText(m.left - 8, y + 4, fmtInt(t), 'end');
  });
  svg += '<line x1="' + m.left + '" x2="' + (m.left + innerW) + '" y1="' + (m.top + innerH) + '" y2="' + (m.top + innerH) + '" stroke="' + COLOR_AXIS + '"/>';

  data.forEach(function (d, i) {
    var x = m.left + i * band + gap;
    var y = yAt(d.value);
    var h = (m.top + innerH) - y;
    var color = d.isOther ? COLOR_MUTED : SERIES[i % SERIES.length];
    svg += '<g class="bar">';
    svg += '<path class="mark" d="' + barPath(x, y, barW, h, 4) + '" fill="' + color + '"/>';
    svg += '<rect x="' + (m.left + i * band) + '" y="' + m.top + '" width="' + band + '" height="' + innerH +
      '" fill="transparent" data-tt="' + esc(d.name) + '" data-tt2="' + fmtInt(d.value) + '" data-ttcolor="' + color + '"/>';
    svg += '</g>';

    var lx = m.left + i * band + band / 2;
    var txt = d.name.length > 22 ? d.name.slice(0, 21) + '…' : d.name;
    if (rotate) {
      svg += axisText(lx, m.top + innerH + 14, txt, 'end', -35);
    } else {
      svg += axisText(lx, m.top + innerH + 20, txt, 'middle');
    }
  });

  svg += '</svg>';
  return svg;
}

/* --- 6c. Grafik batang mendatar (akar masalah, cluster) --- */
function hbarChart(data, width) {
  if (!data.length) return emptyChart();
  var W = Math.max(width || 480, 260);
  var rowH = 30;
  var H = Math.max(data.length * rowH + 34, 120);
  var longest = data.reduce(function (a, d) { return d.name.length > a.name.length ? d : a; }, { name: '' });
  var labelW = Math.min(longest.name.length * 6.6 + 14, Math.round(W * 0.42));
  var m = { top: 6, right: 62, bottom: 26, left: labelW };
  var innerW = W - m.left - m.right;
  var innerH = H - m.top - m.bottom;

  var maxV = Math.max.apply(null, data.map(function (d) { return d.value; }));
  var sc = niceScale(maxV, 4);
  var xAt = function (v) { return m.left + (v / sc.max) * innerW; };
  var band = innerH / data.length;
  var barH = Math.min(band * 0.66, 20);
  var yOff = (band - barH) / 2;

  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H +
    '" role="img" aria-label="Grafik batang mendatar peringkat kategori">';

  // kisi vertikal
  sc.ticks.forEach(function (t) {
    var x = xAt(t);
    svg += '<line x1="' + x + '" x2="' + x + '" y1="' + m.top + '" y2="' + (m.top + innerH) + '" stroke="' + COLOR_GRID + '"/>';
    svg += axisText(x, m.top + innerH + 18, fmtInt(t), 'middle');
  });
  svg += '<line x1="' + m.left + '" x2="' + m.left + '" y1="' + m.top + '" y2="' + (m.top + innerH) + '" stroke="' + COLOR_AXIS + '"/>';

  data.forEach(function (d, i) {
    var y = m.top + i * band + yOff;
    var w = Math.max(xAt(d.value) - m.left, 1);
    var color = d.isOther ? COLOR_MUTED : SERIES[i % SERIES.length];
    var label = d.name.length > 26 ? d.name.slice(0, 25) + '…' : d.name;
    svg += '<g class="hbar">';
    svg += '<text x="' + (m.left - 8) + '" y="' + (y + barH / 2 + 4) + '" text-anchor="end" fill="' + COLOR_INK2 +
      '" font-size="11">' + esc(label) + '</text>';
    svg += '<path class="mark" d="' + hbarPath(m.left, y, w, barH, 4) + '" fill="' + color + '"/>';
    // label nilai langsung di ujung — juga menjadi penerang kontras warna
    svg += '<text x="' + (m.left + w + 8) + '" y="' + (y + barH / 2 + 4) + '" fill="' + COLOR_INK2 +
      '" font-size="11" font-weight="600">' + fmtInt(d.value) + '</text>';
    svg += '<rect x="' + m.left + '" y="' + (m.top + i * band) + '" width="' + innerW + '" height="' + band +
      '" fill="transparent" data-tt="' + esc(d.name) + '" data-tt2="' + fmtInt(d.value) + '" data-ttcolor="' + color + '"/>';
    svg += '</g>';
  });

  svg += '</svg>';
  return svg;
}

/* --- 6d. Donat (kepatuhan SLA) --- */
function donutChart(data, centerValue, centerLabel) {
  if (!data.length) return emptyChart('Kolom SLA tidak ditemukan pada file ini.');
  var S = 210;
  var cx = S / 2, cy = S / 2, rO = 95, rI = 63;
  var total = data.reduce(function (s, d) { return s + d.value; }, 0);
  if (!total) return emptyChart();

  var palette = {};
  data.forEach(function (d) {
    palette[d.name] = d.name === 'IN SLA' ? COLOR_GOOD : (d.name === 'OUT SLA' ? COLOR_CRITICAL : SERIES[0]);
  });

  var gapDeg = data.length > 1 ? 2 : 0;
  var angle = -90;
  var svg = '<svg viewBox="0 0 ' + S + ' ' + S + '" width="' + S + '" height="' + S +
    '" role="img" aria-label="Grafik donat kepatuhan SLA">';

  data.forEach(function (d) {
    var sweep = (d.value / total) * 360;
    var a0 = angle + gapDeg / 2;
    var a1 = angle + sweep - gapDeg / 2;
    if (a1 <= a0) a1 = a0 + 0.4;
    var color = palette[d.name] || SERIES[0];
    svg += '<path class="slice" d="' + arcPath(cx, cy, rO, rI, a0, a1) + '" fill="' + color +
      '" stroke="' + COLOR_SURFACE + '" stroke-width="2" data-tt="' + esc(d.name) +
      '" data-tt2="' + fmtInt(d.value) + '" data-ttcolor="' + color + '"/>';
    angle += sweep;
  });

  // angka besar di tengah donat
  svg += '<text x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle" fill="' + COLOR_INK +
    '" font-size="31" font-weight="700">' + esc(centerValue) + '</text>';
  svg += '<text x="' + cx + '" y="' + (cy + 24) + '" text-anchor="middle" fill="' + COLOR_MUTED +
    '" font-size="11.5">' + esc(centerLabel) + '</text>';
  svg += '</svg>';
  return { svg: svg, palette: palette };
}

/* --- Tooltip bersama --- */
var tooltipEl = null;
function showTooltip(e, label, value, color) {
  if (!tooltipEl) tooltipEl = $('tooltip');
  tooltipEl.innerHTML =
    '<span class="tt-label">' + esc(label) + '</span>' +
    '<span class="tt-row">' + (color ? '<span class="tt-dot" style="background:' + esc(color) + '"></span>' : '') +
    '<span class="tt-val">' + esc(value) + '</span></span>';
  tooltipEl.hidden = false;
  var pad = 14;
  var r = tooltipEl.getBoundingClientRect();
  var x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
  tooltipEl.style.left = Math.max(8, x) + 'px';
  tooltipEl.style.top = Math.max(8, y) + 'px';
}
function hideTooltip() {
  if (!tooltipEl) tooltipEl = $('tooltip');
  tooltipEl.hidden = true;
}

/** Pasang perilaku hover (tooltip + silang) pada satu SVG grafik. */
function bindChart(svgEl) {
  var crosshair = svgEl.querySelector('.crosshair');
  var dots = svgEl.querySelectorAll('circle');

  svgEl.addEventListener('mousemove', function (e) {
    var hit = e.target.closest ? e.target.closest('[data-tt]') : null;
    if (!hit) { hideTooltip(); return; }
    showTooltip(e, hit.getAttribute('data-tt'), hit.getAttribute('data-tt2'), hit.getAttribute('data-ttcolor'));
    if (crosshair) {
      var idx = hit.getAttribute('data-line-i');
      if (idx != null && dots[idx]) {
        var cx = dots[idx].getAttribute('cx');
        crosshair.setAttribute('x1', cx);
        crosshair.setAttribute('x2', cx);
        crosshair.setAttribute('opacity', '1');
      }
    }
  });
  svgEl.addEventListener('mouseleave', function () {
    hideTooltip();
    if (crosshair) crosshair.setAttribute('opacity', '0');
  });
}

/* ---------------------------------------------------------
   7. Render
   --------------------------------------------------------- */

var state = {
  data: null,        // { rows, headers, schema, rowCount, fileName, errors }
  filters: Object.assign({}, INITIAL_FILTERS),
  filtered: [],
  aggregates: {},    // cache agregasi, dipakai ulang saat layar diubah ukuran
  rootTrendCategories: [], // seri akar masalah pilihan pengguna (maks. 6)
  page: 0,
  sort: { key: 'date', dir: 'desc' },
  view: {},          // 'chart' | 'table' per kartu
  generation: 0
};

var CHARTS = ['trend', 'status', 'sla', 'severity', 'root', 'cluster', 'nop'];

function hide(id) { var el = $(id); if (el) el.hidden = true; }
function show(id) { var el = $(id); if (el) el.hidden = false; }

/** Isi pilihan filter dari data. */
function populateFilters() {
  var schema = state.data.schema;
  var rows = state.data.rows;
  var defs = [
    { id: 'f-nop', key: 'nop', col: schema.nop, all: 'Semua NOP' },
    { id: 'f-cluster', key: 'cluster', col: schema.cluster, all: 'Semua Cluster' },
    { id: 'f-severity', key: 'severity', col: schema.severity, all: 'Semua Severity', ordered: true },
    { id: 'f-status', key: 'status', col: schema.status, all: 'Semua Status' },
    { id: 'f-sla', key: 'sla', col: schema.sla, all: 'Semua SLA' }
  ];
  defs.forEach(function (def) {
    var sel = $(def.id);
    if (!sel) return;
    var values = distinctValues(rows, def.col);
    if (def.ordered) values = sortSeverity(values.map(function (v) { return { name: v, value: 0 }; })).map(function (d) { return d.name; });
    var html = '<option value="">' + esc(def.all) + '</option>';
    values.forEach(function (v) {
      html += '<option value="' + esc(v) + '">' + esc(v) + '</option>';
    });
    sel.innerHTML = html;
    if (state.filters[def.key] && values.indexOf(state.filters[def.key]) === -1) state.filters[def.key] = '';
    sel.value = state.filters[def.key] || '';
    sel.disabled = !def.col;
    sel.classList.toggle('is-set', !!state.filters[def.key]);
  });
}

function renderKpis(k) {
  $('kpi-total').textContent = fmtInt(k.total);
  $('kpi-total-sub').textContent = k.sites ? fmtInt(k.sites) + ' site unik' : '';
  $('kpi-total').title = 'Seluruh baris yang cocok dengan filter';

  $('kpi-sla').textContent = k.slaPct == null ? '—' : fmtPct(k.slaPct);
  $('kpi-sla-sub').textContent = (k.inSla + k.outSla) ? fmtInt(k.inSla) + ' IN · ' + fmtInt(k.outSla) + ' OUT' : 'Tidak ada data SLA';

  $('kpi-mttr').textContent = k.mttrAvg == null ? '—' : fmtNum2(k.mttrAvg) + ' jam';
  $('kpi-mttr-sub').textContent = k.mttrMedian != null ? 'Median ' + fmtNum2(k.mttrMedian) + ' jam' : '';
  $('kpi-mttr-hint').textContent = 'Tiket CLOSED saja · n=' + fmtInt(k.mttrN);

  $('kpi-open').textContent = fmtInt(k.open);
  $('kpi-open-sub').textContent = fmtPct(k.openPct) + ' dari total';
}

/** Tabel ringkas (alternatif aksesibel dari grafik). */
function miniTableHtml(data, col1, col2, emptyMsg) {
  if (!data.length) return '<div class="empty-inline">' + svgIcon('i-layers') + '<p>' + esc(emptyMsg || 'Tidak ada data.') + '</p></div>';
  var body = data.map(function (d) {
    return '<tr><td>' + esc(d.name) + '</td><td>' + fmtInt(d.value) + '</td></tr>';
  }).join('');
  return '<table class="mini-table"><thead><tr><th>' + esc(col1) + '</th><th>' + esc(col2) + '</th></tr></thead>' +
    '<tbody>' + body + '</tbody></table>' +
    '<div class="mini-back"><button class="ghost-btn" type="button" data-back>' +
    svgIcon('i-chart', 'icon-sm') + '<span>Kembali ke grafik</span></button></div>';
}

/** Render satu kartu grafik: SVG + tabel alternatif + label angka. */
function renderChartCard(name, svgHtml, tableHtml) {
  var host = $('chart-' + name);
  var viewChart = $('view-chart-' + name);
  var viewTable = $('view-table-' + name);
  if (host) {
    host.innerHTML = svgHtml;
    var s = host.querySelector('svg');
    if (s) bindChart(s);
  }
  if (viewTable) viewTable.innerHTML = tableHtml;
  applyView(name);
}

function applyView(name) {
  var mode = state.view[name] || 'chart';
  var viewChart = $('view-chart-' + name);
  var viewTable = $('view-table-' + name);
  if (viewChart) viewChart.hidden = mode !== 'chart';
  if (viewTable) viewTable.hidden = mode !== 'table';
  var btn = document.querySelector('[data-toggle="' + name + '"]');
  if (btn) {
    btn.querySelector('span').textContent = mode === 'chart' ? 'Lihat sebagai tabel' : 'Kembali ke grafik';
    btn.querySelector('use').setAttribute('href', mode === 'chart' ? '#i-table' : '#i-chart');
  }
}

function renderCharts() {
  var a = state.aggregates;
  if (!a.trend) return;

  // Pertahankan pilihan kategori yang masih tersedia; jika kosong, pilih 3 teratas.
  var available = a.trend.categories.map(function (d) { return d.name; });
  var retained = state.rootTrendCategories.filter(function (name) { return available.indexOf(name) !== -1; });
  if (!retained.length && available.length) {
    // Default memakai kategori berisi saja supaya perbandingan antar akar masalah
    // tidak tertutup satu kategori "Belum diisi" yang biasanya sangat besar.
    var filled = available.filter(function (name) { return name !== LABEL_EMPTY; });
    retained = (filled.length ? filled : available).slice(0, Math.min(3, MAX_ROOT_TREND_SERIES));
  }
  state.rootTrendCategories = retained.slice(0, MAX_ROOT_TREND_SERIES);
  renderRootTrendPicker(a.trend.categories);

  var selected = state.rootTrendCategories.slice();
  var tableHtml = rootTrendTableHtml(a.trend.data, selected);
  renderChartCard('trend',
    lineChart(a.trend.data, $('chart-trend').clientWidth || 560, selected),
    tableHtml);
  renderRootTrendLegend(selected);

  renderChartCard('status',
    barChart(a.status, $('chart-status').clientWidth || 480, 250),
    miniTableHtml(a.status, 'Status', 'Jumlah Tiket'));

  // Donat memakai HTML terpisah untuk legend-nya.
  var slaRes = donutChart(a.sla, a.kpis.slaPct == null ? '—' : fmtPct(a.kpis.slaPct), 'kepatuhan');
  if (typeof slaRes === 'string') {
    renderChartCard('sla', slaRes, miniTableHtml(a.sla, 'SLA', 'Jumlah Tiket', 'Kolom SLA tidak ditemukan pada file ini.'));
    $('legend-sla').innerHTML = '';
  } else {
    renderChartCard('sla', slaRes.svg, miniTableHtml(a.sla, 'SLA', 'Jumlah Tiket', 'Kolom SLA tidak ditemukan pada file ini.'));
    var sum = a.sla.reduce(function (s, d) { return s + d.value; }, 0);
    $('legend-sla').innerHTML = a.sla.map(function (d) {
      return '<li><span class="swatch" style="background:' + esc(slaRes.palette[d.name] || SERIES[0]) + '"></span>' +
        '<span class="lname">' + esc(d.name) + '</span>' +
        '<span class="lval">' + fmtInt(d.value) + '</span>' +
        '<span class="lpct">' + (sum ? ((d.value / sum) * 100).toFixed(1).replace('.', ',') + '%' : '') + '</span></li>';
    }).join('');
  }

  renderChartCard('severity',
    barChart(a.severity, $('chart-severity').clientWidth || 420, 240),
    miniTableHtml(a.severity, 'Severity', 'Jumlah Tiket'));

  renderChartCard('root',
    hbarChart(a.root, $('chart-root').clientWidth || 420),
    miniTableHtml(a.root, 'Akar Masalah', 'Jumlah Tiket'));

  renderChartCard('cluster',
    hbarChart(a.cluster, $('chart-cluster').clientWidth || 420),
    miniTableHtml(a.cluster, 'Cluster', 'Jumlah Tiket'));

  renderChartCard('nop',
    barChart(a.nop, $('chart-nop').clientWidth || 560, 220),
    miniTableHtml(a.nop, 'NOP', 'Jumlah Tiket'));

  // Kartu NOP disembunyikan bila kolomnya tidak ada.
  var nopCard = document.querySelector('[data-card="nop"]');
  if (nopCard) nopCard.hidden = a.nop.length === 0;

  $('trend-sub').textContent = 'Tiket per ' + a.trend.granularity + ' · bandingkan kategori akar masalah';
  $('trend-badge').textContent = a.trend.badge;
}

/** Buat pilihan checkbox kategori; batas 6 mencegah terlalu banyak garis. */
function renderRootTrendPicker(categories) {
  var menu = $('picker-menu');
  var button = $('picker-btn');
  var selected = state.rootTrendCategories;
  $('picker-count').textContent = selected.length + '/' + MAX_ROOT_TREND_SERIES + ' dipilih';
  if (!categories.length) {
    menu.innerHTML = '<p class="picker-empty">Kolom Rootcause Category tidak ditemukan.</p>';
    button.disabled = true;
    return;
  }
  button.disabled = false;
  var atLimit = selected.length >= MAX_ROOT_TREND_SERIES;
  menu.innerHTML = categories.map(function (item) {
    var checked = selected.indexOf(item.name) !== -1;
    return '<label class="picker-option' + (!checked && atLimit ? ' is-disabled' : '') + '">' +
      '<input type="checkbox" value="' + esc(item.name) + '"' + (checked ? ' checked' : '') +
      (!checked && atLimit ? ' disabled' : '') + '>' +
      '<span class="picker-swatch" style="background:' + SERIES[Math.max(0, selected.indexOf(item.name)) % MAX_ROOT_TREND_SERIES] + '"></span>' +
      '<span class="picker-name">' + esc(item.name) + '</span>' +
      '<span class="picker-value">' + fmtInt(item.value) + '</span></label>';
  }).join('');
  menu.querySelectorAll('input[type="checkbox"]').forEach(function (input) {
    input.addEventListener('change', function () {
      var name = input.value;
      if (input.checked) {
        if (state.rootTrendCategories.length >= MAX_ROOT_TREND_SERIES) { input.checked = false; return; }
        state.rootTrendCategories.push(name);
      } else {
        state.rootTrendCategories = state.rootTrendCategories.filter(function (item) { return item !== name; });
      }
      renderCharts();
    });
  });
}

/** Tabel aksesibel: periode + nilai setiap akar masalah terpilih. */
function rootTrendTableHtml(data, categories) {
  if (!data.length || !categories.length) return emptyChart('Pilih setidaknya satu kategori akar masalah.');
  var head = '<tr><th>Periode</th>' + categories.map(function (name) { return '<th>' + esc(name) + '</th>'; }).join('') + '</tr>';
  var body = data.map(function (point) {
    return '<tr><td>' + esc(point.label) + '</td>' + categories.map(function (name) {
      return '<td>' + fmtInt(point.counts[name] || 0) + '</td>';
    }).join('') + '</tr>';
  }).join('');
  return '<table class="mini-table root-trend-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>' +
    '<div class="mini-back"><button class="ghost-btn" type="button" data-back>' +
    svgIcon('i-chart', 'icon-sm') + '<span>Kembali ke grafik</span></button></div>';
}

/** Legend tetap menempel pada nama kategori, walau pilihan lain diubah. */
function renderRootTrendLegend(categories) {
  $('legend-trend').innerHTML = categories.map(function (name) {
    var color = SERIES[Math.max(0, state.rootTrendCategories.indexOf(name)) % MAX_ROOT_TREND_SERIES];
    return '<li><span class="swatch" style="background:' + color + '"></span><span class="lname">' + esc(name) + '</span></li>';
  }).join('');
}

/** Render seluruh dasbor dari data yang tersimpan di `state`. */
function renderAll() {
  if (!state.data) return;

  var rows = applyFilters(state.data.rows, state.data.schema, state.filters);
  state.filtered = rows;

  var k = computeKpis(rows, state.data.schema);
  var schema = state.data.schema;

  var slaCounts = countBy(rows, schema.sla).filter(function (d) { return d.name === 'IN SLA' || d.name === 'OUT SLA'; });

  state.aggregates = {
    kpis: k,
    trend: buildRootTrend(rows, schema),
    status: countBy(rows, schema.status),
    severity: sortSeverity(countBy(rows, schema.severity)),
    sla: slaCounts,
    root: topN(countBy(rows, schema.rootcause, { mapLabel: 'Belum diisi' }), 6),
    cluster: topN(countBy(rows, schema.cluster), 8),
    nop: countBy(rows, schema.nop)
  };

  state.page = Math.min(state.page, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1));

  renderKpis(k);
  renderCharts();
  renderTable();
  updateFilterBar();
}

function updateFilterBar() {
  $('f-count').textContent = fmtInt(state.filtered.length) + ' / ' + fmtInt(state.data.rows.length) + ' baris';
  var n = activeFilterCount(state.filters);
  $('btn-reset').disabled = n === 0;
  $('btn-reset-text').textContent = n ? 'Reset (' + n + ')' : 'Reset';
}

/* ---------------------------------------------------------
   8. Tabel data
   --------------------------------------------------------- */

var TABLE_COLS = [
  { key: 'date', label: 'Tanggal', sortable: true, render: function (r) { return r.date ? fmtDate(r.date) : '—'; }, cls: 'num' },
  { key: 'wo', label: 'No. WO', render: function (r) { return r.wo || '—'; } },
  { key: 'siteName', label: 'Site', render: function (r) { return r.siteName || '—'; } },
  { key: 'nop', label: 'NOP', render: function (r) { return r.nop || '—'; } },
  { key: 'cluster', label: 'Cluster', render: function (r) { return r.cluster || '—'; } },
  { key: 'status', label: 'Status', render: function (r) { return r.status || '—'; }, cls: 'st' },
  { key: 'severity', label: 'Severity', render: function (r) { return r.severity || '—'; } },
  { key: 'sla', label: 'SLA', render: function (r) { return r.sla || '—'; } },
  { key: 'mttr', label: 'MTTR (jam)', sortable: true, render: function (r) { return r.mttr == null ? '—' : fmtNum2(r.mttr); }, cls: 'num' },
  { key: 'rootcause1', label: 'Akar Masalah', render: function (r) { return r.rootcause1 || '—'; } },
  { key: 'pic', label: 'PIC', render: function (r) { return r.pic || '—'; } },
  { key: 'remarks', label: 'Remarks', render: function (r) { return r.remarks || '—'; } }
];

function fmtDate(ts) {
  var d = new Date(ts);
  return String(d.getDate()).padStart(2, '0') + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
}

function statusTone(v) {
  var s = String(v || '').toUpperCase();
  if (s === 'CLOSED' || s === 'RESOLVED') return COLOR_GOOD;
  if (s === 'ESCALATED TO INSERA') return COLOR_CRITICAL;
  if (s === 'IN PROGRESS' || s === 'ASSIGNED') return '#ec835a';
  return COLOR_INK2;
}

function tableRow(row, schema) {
  var c = function (k) { return schema[k] ? (row[schema[k]] == null ? '' : row[schema[k]]) : null; };
  return {
    date: row.__ts, wo: c('wo'), siteName: c('siteName'), nop: c('nop'), cluster: c('cluster'),
    status: c('status'), severity: c('severity'), sla: c('sla'), mttr: row.__mttr,
    rootcause1: c('rootcause1'), pic: c('pic'), remarks: c('remarks'), raw: row
  };
}

function renderTable() {
  var schema = state.data.schema;
  var rows = state.filtered;
  var totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  var page = Math.min(state.page, totalPages - 1);
  state.page = page;

  $('table-sub').textContent = rows.length
    ? fmtInt(rows.length) + ' baris cocok dengan filter · menampilkan ' + fmtInt(Math.min(PAGE_SIZE, rows.length)) + ' baris per halaman'
    : 'Tidak ada baris yang cocok dengan filter.';

  var tbody = $('data-tbody');
  var emptyEl = $('table-empty');
  var tableEl = $('data-table');
  var pagerEl = $('pager');

  if (!rows.length) {
    tbody.innerHTML = '';
    tableEl.hidden = true;
    emptyEl.hidden = false;
    pagerEl.hidden = true;
    return;
  }
  tableEl.hidden = false;
  emptyEl.hidden = true;
  pagerEl.hidden = false;

  // urut: tanggal / MTTR saja (yang lain tetap urutan file)
  var idx = rows.map(function (_, i) { return i; });
  if (state.sort.key === 'date') {
    idx.sort(function (a, b) {
      var x = rows[a].__ts == null ? -Infinity : rows[a].__ts;
      var y = rows[b].__ts == null ? -Infinity : rows[b].__ts;
      return (x - y) * (state.sort.dir === 'asc' ? 1 : -1);
    });
  } else if (state.sort.key === 'mttr') {
    idx.sort(function (a, b) {
      var x = rows[a].__mttr == null ? -Infinity : rows[a].__mttr;
      var y = rows[b].__mttr == null ? -Infinity : rows[b].__mttr;
      return (x - y) * (state.sort.dir === 'asc' ? 1 : -1);
    });
  }

  var start = page * PAGE_SIZE;
  var slice = idx.slice(start, start + PAGE_SIZE);

  tbody.innerHTML = slice.map(function (i) {
    var tr = tableRow(rows[i], schema);
    return '<tr>' + TABLE_COLS.map(function (col) {
      var text = col.render(tr);
      var cls = col.cls || '';
      if (col.cls === 'st') {
        return '<td style="color:' + statusTone(tr.status) + ';font-weight:600">' + esc(text) + '</td>';
      }
      return '<td class="' + cls + '">' + esc(text) + '</td>';
    }).join('') + '</tr>';
  }).join('');

  $('pager-info').textContent = 'Halaman ' + fmtInt(page + 1) + ' dari ' + fmtInt(totalPages);
  var btns = pagerEl.querySelectorAll('[data-page]');
  btns.forEach(function (b) {
    var kind = b.getAttribute('data-page');
    b.disabled =
      (kind === 'first' || kind === 'prev') ? page === 0
        : (kind === 'next' || kind === 'last') ? page >= totalPages - 1
          : false;
  });

  // indikator urutan di kepala kolom
  document.querySelectorAll('#data-table th').forEach(function (th) { th.removeAttribute('aria-sort'); });
  document.querySelectorAll('#data-table th button[data-sort]').forEach(function (b) {
    if (b.getAttribute('data-sort') === state.sort.key) {
      b.closest('th').setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending');
      b.querySelector('.sort-ind').textContent = state.sort.dir === 'asc' ? '↑' : '↓';
    } else {
      b.querySelector('.sort-ind').textContent = '↕';
    }
  });
}

function exportFilteredCsv() {
  var headers = state.data.headers;
  var out = Papa.unparse({
    fields: headers,
    data: state.filtered.map(function (r) { return headers.map(function (h) { return r[h] == null ? '' : r[h]; }); })
  }, { delimiter: ';' });
  var blob = new Blob(['﻿' + out], { type: 'text/csv;charset=utf-8;' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = (state.data.fileName || 'data').replace(/\.csv$/i, '') + '-tersaring.csv';
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------------------------------------------------------
   9. Unggah file
   --------------------------------------------------------- */

var uploadGeneration = 0;
// 'replace' mengganti seluruh data; 'append' menambahkan batch berikutnya.
var currentMode = 'replace';

function setBusy(busy, progress, label) {
  var dz = $('dropzone');
  dz.classList.toggle('is-busy', busy);
  $('dz-title').textContent = busy ? (label || 'Memproses file…') : 'Pilih atau seret satu atau beberapa file CSV/XLSX';
  $('dz-hint').textContent = busy
    ? 'Seluruh proses dilakukan di peramban'
    : 'Beberapa bulan bisa digabung sekaligus · duplikat dibuang otomatis · data tidak diunggah ke server';
  $('dz-progress').hidden = !busy;
  $('dz-browse').hidden = busy;
  $('dz-progress').querySelector('i').style.width = (busy ? (progress || 4) : 0) + '%';
}

function setError(msg) {
  var box = $('alert-error');
  if (!msg) { box.hidden = true; return; }
  $('alert-error-text').textContent = msg;
  box.hidden = false;
}

function setFileWarnings(list) {
  var box = $('alert-filewarn');
  if (!list || !list.length) { box.hidden = true; return; }
  $('alert-filewarn-text').textContent = list.length + ' file gagal dibaca dan dilewati: ' + list.join('; ');
  box.hidden = false;
}

/**
 * Proses beberapa file sekaligus secara berurutan (lebih hemat memori daripada
 * paralel). `append` menambahkan ke data yang sudah ada; `replace` mengganti.
 * Batch replace gagal total jika satu file gagal; batch append menyimpan file
 * yang berhasil dan melaporkan yang gagal.
 */
function processFiles(fileList, mode) {
  var list = Array.prototype.slice.call(fileList || []);
  setError('');
  setFileWarnings([]);
  if (!list.length) { currentMode = 'replace'; return; }

  var token = ++uploadGeneration; // batch lebih baru selalu menang
  currentMode = mode || 'replace';
  setBusy(true, 4, 'Menyiapkan ' + list.length + ' file…');

  var parsedFiles = [];
  var failed = [];
  var chain = Promise.resolve();

  list.forEach(function (file, i) {
    chain = chain.then(function () {
      if (token !== uploadGeneration) return; // dibatalkan batch baru
      var label = 'File ' + (i + 1) + ' dari ' + list.length + ' — ' + file.name;
      setBusy(true, 8 + (i / list.length) * 88, label);
      var isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
      var isXlsx = /\.xlsx$/i.test(file.name) || file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      if (!isCsv && !isXlsx) { failed.push(file.name + ' (format bukan .csv/.xlsx)'); return null; }
      if (file.size > MAX_MB * 1024 * 1024) { failed.push(file.name + ' (melebihi ' + MAX_MB + ' MB)'); return null; }
      return parseDataFile(file).then(function (parsed) {
        if (token !== uploadGeneration) return;
        if (parsed.error) { failed.push(file.name + ' (' + parsed.error + ')'); return; }
        if (!parsed.headers.length) { failed.push(file.name + ' (header tidak terbaca)'); return; }
        parsedFiles.push(parsed);
      });
    });
  });

  chain.then(function () {
    if (token !== uploadGeneration) return;
    setBusy(false, 0);

    if (!parsedFiles.length) {
      currentMode = 'replace';
      setFileWarnings(failed);
      setError(failed.length ? 'Tidak ada file yang berhasil dibaca.' : 'Tidak ada file yang dipilih.');
      if ($('file-input')) $('file-input').value = '';
      return;
    }
    if (mode === 'replace' && failed.length) {
      // replace adalah transaksi: file lama dipertahankan bila batch gagal sebagian
      currentMode = 'replace';
      setFileWarnings(failed);
      setError('Batch tidak diproses karena beberapa file gagal dibaca. File lama tetap tersimpan.');
      if ($('file-input')) $('file-input').value = '';
      return;
    }
    commitBatch(parsedFiles, failed, mode === 'append' && !!state.data);
  });
}

/**
 * Gabungkan batch parsed ke state: union header, align baris, dedupe exact-row,
 * lalu render sekali. Append memakai key dedupe dari batch sebelumnya.
 */
function commitBatch(parsedFiles, failed, isAppend) {
  var prior = isAppend && state.data ? state.data : null;
  var priorSources = (prior && prior.fileSources) ? prior.fileSources : [];
  var newSources = parsedFiles.map(function (p) {
    return { name: p.fileName, headers: p.headers, rows: p.rows, warnings: (p.errors || []).length };
  });
  var allSources = priorSources.concat(newSources);
  var headers = mergeHeaders(allSources);
  var rows = alignRows(allSources, headers);

  // Semua baris (lama lalu baru) duduk pada urutan header union yang sama,
  // sehingga dedupe exact-row bekerja setara di dalam maupun antar file.
  // Baris lama didahulukan sehingga yang dipertahankan adalah versi pertama.
  var dedup = dedupeRows(rows, headers);

  var errors = [];
  if (prior) errors = (prior.errors || []).slice();
  parsedFiles.forEach(function (p) { (p.errors || []).forEach(function (e) { errors.push(p.fileName + ': ' + e); }); });
  var previousDropped = prior && prior.dedupe ? prior.dedupe.dropped : 0;

  var combined = finalizeData(dedup.rows, headers, allSources.map(function (f) {
    return { name: f.name, rows: f.rows.length, warnings: f.warnings || 0 };
  }), {
    total: dedup.rows.length + dedup.dropped + previousDropped,
    dropped: dedup.dropped + previousDropped
  }, errors);
  combined.fileSources = allSources;

  onDataLoaded(combined, !!prior);
  setFileWarnings(failed);
  currentMode = 'replace';
}

function onDataLoaded(parsed, isAppend) {
  state.data = parsed;
  if (!isAppend) {
    state.filters = Object.assign({}, INITIAL_FILTERS);
    state.page = 0;
    state.sort = { key: 'date', dir: 'desc' };
    state.view = {};
    state.rootTrendCategories = [];
  }

  hide('dropzone');
  show('file-chip');
  hide('welcome');
  show('dashboard');
  hide('loaded-badge');

  var files = parsed.files || [{ name: parsed.fileName, rows: parsed.rowCount }];
  var names = files.map(function (f) { return f.name; });
  var nameEl = $('file-name');
  nameEl.textContent = files.length === 1 ? names[0] : files.length + ' file digabung';
    nameEl.title = names.join('\n');
  var totalRows = files.reduce(function (s, f) { return s + (f.rows || 0); }, 0);
  $('file-meta').textContent = files.length + ' file · ' + fmtInt(parsed.rowCount) + ' baris unik · ' +
    parsed.headers.length + ' kolom · diproses lokal' +
    (files.length > 1 ? ' (' + fmtInt(totalRows) + ' baris dibaca)' : '');

  var dedupeEl = $('file-dedupe');
  var dropped = parsed.dedupe ? parsed.dedupe.dropped : 0;
  if (dropped > 0) {
    // Konten di sini hanya ikon statis + angka, tanpa masukan pengguna.
    dedupeEl.innerHTML = svgIcon('i-copy', 'icon-xs') + ' <span>' + fmtInt(dropped) + ' baris duplikat identik dibuang otomatis</span>';
    dedupeEl.hidden = false;
  } else { dedupeEl.hidden = true; }

  $('loaded-badge-text').textContent = fmtInt(parsed.rowCount) + ' baris dimuat';
  show('loaded-badge');

  // peringatan pembacaan
  var warn = $('alert-warn');
  if (parsed.errors && parsed.errors.length) {
    $('alert-warn-text').textContent = parsed.errors.length + ' peringatan saat membaca file. Sebagian baris mungkin tidak lengkap: ' + parsed.errors.slice(0, 3).join('; ');
    warn.hidden = false;
  } else { warn.hidden = true; }

  // petunjuk kolom inti yang hilang
  var schema = parsed.schema;
  var missing = [];
  if (!schema.status) missing.push('Ticket Status / Status');
  if (!schema.date) missing.push('DateOccured / Date');
  var found = [schema.status, schema.sla, schema.severity, schema.mttr, schema.date].filter(Boolean).length;
  if (missing.length || found < 3) {
    $('alert-schema-text').textContent = 'Kolom yang dikenali: ' + found + ' / 5 metrik dasar.' +
      (missing.length ? ' Tidak ditemukan: ' + missing.join(', ') + '.' : '') +
      ' Grafik atau KPI yang memerlukan kolom tersebut tidak akan ditampilkan secara valid.';
    show('alert-schema');
  } else { hide('alert-schema'); }

  populateFilters();
  if (!isAppend) {
    ['f-from', 'f-to', 'f-duration-from', 'f-duration-to'].forEach(function (id) {
      var el = $(id);
      el.value = '';
      if (id.indexOf('f-duration') === 0) el.setAttribute('aria-invalid', 'false');
    });
    $('f-duration-hint').textContent = 'Cleared Time − DateOccured · bawah inklusif, atas eksklusif';
    $('f-duration-hint').classList.remove('is-error');
  }
  renderAll();
}

function resetAll() {
  uploadGeneration++;
  currentMode = 'replace';
  state.data = null;
  state.filtered = [];
  state.aggregates = {};
  state.view = {};
  setError('');
  setFileWarnings([]);
  setBusy(false, 0);
  hide('file-chip');
  hide('dashboard');
  hide('loaded-badge');
  hide('alert-warn');
  hide('alert-schema');
  show('dropzone');
  show('welcome');
}

/* ---------------------------------------------------------
   10. Data contoh (sintetis — bukan data produksi)
   --------------------------------------------------------- */

var SAMPLE_CSV = `NOP;SOW Num;INAP No;WO Ticket No;Site;Site Name;Ticket Status;DateOccured;SLA;Cluster;Cleared Time;Duration;Remarks;Severity;Fault Level;Ticket Type;MTTR (Hours);Is Checkin;Rootcause Category;Rootcause 1;Rootcause 2;PIC Name
NOP DEMO SELATAN;1;EM-20260901-00000001;WO-0001;SIT001;TOWER UTARA 1;CLOSED;01-09-2026 07:15:00;IN SLA;TO DEMO UTARA;01-09-2026 07:55:00;40m 0s;Take Over;Major;Enva Site;Event;0.67;Yes;Power;PLN Off;PLN OFF berulang;PIC A
NOP DEMO SELATAN;1;EM-20260901-00000002;WO-0002;SIT002;TOWER UTARA 2;CLOSED;01-09-2026 08:30:00;IN SLA;TO DEMO UTARA;01-09-2026 10:00:00;1h 30m 0s;Auto Clear;Minor;Enva Site;Event;1.5;No;Radio;BTS;Modul Rusak;PIC B
NOP DEMO SELATAN;1;EM-20260901-00000003;WO-0003;SIT003;TOWER SELATAN 1;CLOSED;01-09-2026 11:45:00;OUT SLA;TO DEMO SELATAN;01-09-2026 16:45:00;5h 0m 0s;Take Over;Critical;Enva Site Simpul;Incident;5;No;Transmisi;FO Telkom Putus;Aktivitas Pihak ke-3;PIC C
NOP DEMO SELATAN;1;EM-20260902-00000004;WO-0004;SIT004;TOWER SELATAN 2;RESOLVED;02-09-2026 09:10:00;IN SLA;TO DEMO SELATAN;02-09-2026 10:10:00;1h 0m 0s;Take Over;Major;Enva Site GSB;Event;1;Yes;Aktivitas;Aktivitas Telkomsel;Tidak ada CRQ;PIC A
NOP DEMO SELATAN;1;EM-20260902-00000005;WO-0005;SIT005;TOWER BARAT 1;CLOSED;02-09-2026 13:20:00;IN SLA;TO DEMO BARAT;02-09-2026 13:50:00;30m 0s;Auto Clear;Low;Enva Site;Event;0.5;No;Power;Rectifier;Rectifier modul rusak;PIC D
NOP DEMO UTARA;2.1;EM-20260902-00000006;WO-0006;SIT006;TOWER BARAT 2;CLOSED;02-09-2026 15:05:00;IN SLA;TO DEMO BARAT;02-09-2026 16:35:00;1h 30m 0s;Take Over;Minor;Enva Site GSB;Event;1.5;Yes;Power;Baterai;Baterai soak;PIC B
NOP DEMO UTARA;2.1;EM-20260903-00000007;WO-0007;SIT007;TOWER TIMUR 1;ASSIGNED;03-09-2026 06:45:00;IN SLA;TO DEMO TIMUR;;;Auto Clear;Major;Enva Site Simpul;Event;2.1;No;Radio;BSC;Konfigurasi Tidak Sesuai;PIC C
NOP DEMO UTARA;2.1;EM-20260903-00000008;WO-0008;SIT008;TOWER TIMUR 2;CLOSED;03-09-2026 12:30:00;OUT SLA;TO DEMO TIMUR;03-09-2026 18:30:00;6h 0m 0s;Take Over;Critical;Enva Site VIP;Incident;6;No;Power;Sewa Daya;Sewa daya habis;PIC D
NOP DEMO UTARA;2.1;EM-20260904-00000009;WO-0009;SIT009;TOWER PUSAT 1;CLOSED;04-09-2026 08:05:00;IN SLA;TO DEMO PUSAT;04-09-2026 08:35:00;30m 0s;Auto Clear;Very Low;Enva Site;Event;0.5;No;;;;PIC A
NOP DEMO UTARA;2.1;EM-20260904-00000010;WO-0010;SIT010;TOWER PUSAT 2;CLOSED;04-09-2026 14:15:00;IN SLA;TO DEMO PUSAT;04-09-2026 15:45:00;1h 30m 0s;Take Over;Major;Enva Site;Event;1.5;Yes;Power;PLN Off;PLN Off lebih dari 3 jam;PIC B
NOP DEMO PANTAI;2.3;EM-20260905-00000011;WO-0011;SIT011;TOWER PANTAI 1;CLOSED;05-09-2026 07:40:00;IN SLA;TO DEMO PANTAI;05-09-2026 08:10:00;30m 0s;Auto Clear;Low;Enva Site GSB;Event;0.5;No;Radio;OFDM Telkomsel Rusak;Modul rusak;PIC C
NOP DEMO PANTAI;2.3;EM-20260905-00000012;WO-0012;SIT012;TOWER PANTAI 2;IN PROGRESS;05-09-2026 10:25:00;IN SLA;TO DEMO PANTAI;;;Take Over;Major;Enva Site;Event;0.8;Yes;Lain - lain;Lain-lain;Menunggu sparepart;PIC D
NOP DEMO PANTAI;2.3;EM-20260906-00000013;WO-0013;SIT013;TOWER PANTAI 3;CLOSED;06-09-2026 09:50:00;IN SLA;TO DEMO PANTAI;06-09-2026 11:20:00;1h 30m 0s;Take Over;Minor;Enva Site Simpul;Event;1.5;Yes;Power;Baterai;Baterai lemah;PIC A
NOP DEMO PANTAI;2.3;EM-20260906-00000014;WO-0014;SIT014;TOWER PANTAI 4;CLOSED;06-09-2026 16:35:00;OUT SLA;TO DEMO PANTAI;06-09-2026 20:05:00;3h 30m 0s;Take Over;Major;Enva Site VIP;Incident;3.5;No;Transmisi;BSC;Kabel putus;PIC B
NOP DEMO PEGUNUNGAN;3;EM-20260907-00000015;WO-0015;SIT015;TOWER PEGUNUNGAN 1;CLOSED;07-09-2026 07:05:00;IN SLA;TO DEMO PEGUNUNGAN;07-09-2026 07:35:00;30m 0s;Auto Clear;Very Low;Enva Site;Event;0.5;No;Power;PLN Off;Sesekali padam;PIC C
NOP DEMO PEGUNUNGAN;3;EM-20260907-00000016;WO-0016;SIT016;TOWER PEGUNUNGAN 2;RESOLVED;07-09-2026 12:10:00;IN SLA;TO DEMO PEGUNUNGAN;07-09-2026 13:10:00;1h 0m 0s;Take Over;Minor;Enva Site GSB;Event;1;Yes;Aktivitas;Aktivitas Telkomsel;Upgrade perangkat;PIC D
NOP DEMO PEGUNUNGAN;3;EM-20260908-00000017;WO-0017;SIT017;TOWER PEGUNUNGAN 3;CLOSED;08-09-2026 08:55:00;IN SLA;TO DEMO PEGUNUNGAN;08-09-2026 10:25:00;1h 30m 0s;Auto Clear;Major;Enva Site;Event;1.5;No;Radio;BTS;Konfigurasi;PIC A
NOP DEMO PEGUNUNGAN;3;EM-20260908-00000018;WO-0018;SIT018;TOWER PEGUNUNGAN 4;SUBMITTED;08-09-2026 15:30:00;IN SLA;TO DEMO PEGUNUNGAN;;;Take Over;Major;Enva Site;Event;0.3;Yes;Power;Rectifier;Modul pengganti;PIC B
NOP DEMO SELATAN;1;EM-20260909-00000019;WO-0019;SIT019;TOWER UTARA 3;CLOSED;09-09-2026 07:20:00;IN SLA;TO DEMO UTARA;09-09-2026 08:05:00;45m 0s;Take Over;Critical;Enva Site Simpul;Incident;0.75;No;Power;Sewa Daya;Perubahan daya;PIC C
NOP DEMO SELATAN;1;EM-20260909-00000020;WO-0020;SIT020;TOWER UTARA 4;CLOSED;09-09-2026 10:45:00;IN SLA;TO DEMO UTARA;09-09-2026 11:45:00;1h 0m 0s;Auto Clear;Low;Enva Site;Event;1;No;;;;PIC D
NOP DEMO SELATAN;1;EM-20260910-00000021;WO-0021;SIT021;TOWER SELATAN 3;CLOSED;10-09-2026 09:15:00;OUT SLA;TO DEMO SELATAN;10-09-2026 12:45:00;3h 30m 0s;Take Over;Major;Enva Site GSB;Incident;3.5;Yes;Transmisi;FO Telkom Putus;Aktivitas pihak ke-3;PIC A
NOP DEMO SELATAN;1;EM-20260910-00000022;WO-0022;SIT022;TOWER SELATAN 4;CLOSED;10-09-2026 14:00:00;IN SLA;TO DEMO SELATAN;10-09-2026 15:00:00;1h 0m 0s;Auto Clear;Minor;Enva Site;Event;1;No;Power;Baterai;Baterai diganti;PIC B
NOP DEMO UTARA;2.1;EM-20260911-00000023;WO-0023;SIT023;TOWER BARAT 3;CLOSED;11-09-2026 08:35:00;IN SLA;TO DEMO BARAT;11-09-2026 09:05:00;30m 0s;Auto Clear;Very Low;Enva Site;Event;0.5;No;Lain - lain;Lain-lain;Pemeliharaan rutin;PIC C
NOP DEMO UTARA;2.1;EM-20260911-00000024;WO-0024;SIT024;TOWER BARAT 4;ESCALATED TO INSERA;11-09-2026 17:10:00;OUT SLA;TO DEMO BARAT;;;Take Over;Critical;Enva Site VIP;Incident;12;No;Radio;BSC;Escalated vendor;PIC D
NOP DEMO PANTAI;2.3;EM-20260912-00000025;WO-0025;SIT025;TOWER PANTAI 5;CLOSED;12-09-2026 07:55:00;IN SLA;TO DEMO PANTAI;12-09-2026 08:55:00;1h 0m 0s;Take Over;Major;Enva Site;Event;1;Yes;Power;PLN Off;PLN OFF berulang;PIC A
NOP DEMO PANTAI;2.3;EM-20260912-00000026;WO-0026;SIT026;TOWER PANTAI 6;CLOSED;12-09-2026 13:40:00;IN SLA;TO DEMO PANTAI;12-09-2026 14:10:00;30m 0s;Auto Clear;Low;Enva Site GSB;Event;0.5;No;Radio;BTS;Modul rusak;PIC B
NOP DEMO PEGUNUNGAN;3;EM-20260913-00000027;WO-0027;SIT027;TOWER PEGUNUNGAN 5;CLOSED;13-09-2026 09:30:00;IN SLA;TO DEMO PEGUNUNGAN;13-09-2026 11:00:00;1h 30m 0s;Take Over;Minor;Enva Site;Event;1.5;Yes;Power;Baterai;Baterai soak;PIC C
NOP DEMO PEGUNUNGAN;3;EM-20260913-00000028;WO-0028;SIT028;TOWER PEGUNUNGAN 6;CLOSED;13-09-2026 16:20:00;OUT SLA;TO DEMO PEGUNUNGAN;13-09-2026 19:50:00;3h 30m 0s;Auto Clear;Major;Enva Site Simpul;Incident;3.5;No;Transmisi;FO Telkom Putus;Gangguan serat optik;PIC D
NOP DEMO SELATAN;1;EM-20260914-00000029;WO-0029;SIT029;TOWER UTARA 5;CLOSED;14-09-2026 08:25:00;IN SLA;TO DEMO UTARA;14-09-2026 08:55:00;30m 0s;Auto Clear;Low;Enva Site;Event;0.5;No;;;;PIC A
NOP DEMO SELATAN;1;EM-20260914-00000030;WO-0030;SIT030;TOWER UTARA 6;CLOSED;14-09-2026 11:50:00;IN SLA;TO DEMO UTARA;14-09-2026 13:20:00;1h 30m 0s;Take Over;Major;Enva Site;Event;1.5;Yes;Aktivitas;Aktivitas Telkomsel;CRQ terlambat;PIC B`;

/* ---------------------------------------------------------
   Pemasangan acara (dijalankan sekali saat halaman dibuka)
   --------------------------------------------------------- */

function init() {
  $('footer-year').textContent = '© ' + new Date().getFullYear() + ' Telkominfra';

  // --- unggah ---
  var input = $('file-input');
  var dz = $('dropzone');
  dz.addEventListener('click', function () { if (!dz.classList.contains('is-busy')) { currentMode = 'replace'; input.click(); } });
  dz.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); currentMode = 'replace'; input.click(); }
  });
  dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('is-drag'); });
  dz.addEventListener('dragleave', function (e) { e.preventDefault(); dz.classList.remove('is-drag'); });
  dz.addEventListener('drop', function (e) {
    e.preventDefault();
    dz.classList.remove('is-drag');
    processFiles(e.dataTransfer.files, currentMode);
  });
  input.addEventListener('change', function () { processFiles(input.files, currentMode); });
  $('btn-add').addEventListener('click', function () { currentMode = 'append'; input.click(); });
  $('btn-replace').addEventListener('click', function () { currentMode = 'replace'; input.click(); });
  $('btn-clear').addEventListener('click', resetAll);
  $('btn-sample').addEventListener('click', function () {
    var btn = $('btn-sample');
    btn.disabled = true;
    btn.textContent = 'Memuat contoh…';
    currentMode = 'replace';
    uploadGeneration++;
    parseCsvText(SAMPLE_CSV, 'sample.csv')
      .then(function (parsed) {
        if (parsed.error) setError(parsed.error);
        else {
          var files = [{ name: parsed.fileName, headers: parsed.headers, rows: parsed.rows, warnings: (parsed.errors || []).length }];
          var dedup = dedupeRows(alignRows(files, parsed.headers), parsed.headers);
          var normalized = finalizeData(dedup.rows, parsed.headers, [{
            name: parsed.fileName, rows: parsed.rowCount, warnings: (parsed.errors || []).length
          }], { total: parsed.rowCount, dropped: dedup.dropped }, parsed.errors);
          normalized.fileSources = files;
          onDataLoaded(normalized, false);
        }
      })
      .catch(function (err) { setError('Gagal memuat contoh: ' + (err && err.message)); })
      .then(function () {
        currentMode = 'replace';
        btn.disabled = false;
        btn.textContent = 'Belum punya file? Muat contoh data demo';
      });
  });

  // --- pilih akar masalah untuk garis tren ---
  var pickerBtn = $('picker-btn');
  var pickerMenu = $('picker-menu');
  function closePicker() {
    pickerMenu.hidden = true;
    pickerBtn.setAttribute('aria-expanded', 'false');
    $('picker-root').classList.remove('is-open');
  }
  pickerBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var open = pickerMenu.hidden;
    pickerMenu.hidden = !open;
    pickerBtn.setAttribute('aria-expanded', String(open));
    $('picker-root').classList.toggle('is-open', open);
  });
  // klik di luar menu menutup menu
  document.addEventListener('click', function (e) {
    if (pickerMenu.hidden) return;
    if (!$('picker-root').contains(e.target)) closePicker();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePicker(); });

  // --- filter ---
  var filterDefs = [
    ['f-nop', 'nop'], ['f-cluster', 'cluster'], ['f-severity', 'severity'],
    ['f-status', 'status'], ['f-sla', 'sla']
  ];
  filterDefs.forEach(function (def) {
    $(def[0]).addEventListener('change', function (e) {
      state.filters[def[1]] = e.target.value;
      e.target.classList.toggle('is-set', !!e.target.value);
      state.page = 0;
      renderAll();
    });
  });
  ['f-from', 'f-to'].forEach(function (id) {
    $(id).addEventListener('change', function (e) {
      state.filters[id === 'f-from' ? 'from' : 'to'] = e.target.value;
      state.page = 0;
      renderAll();
    });
  });

  // --- filter durasi (jam) ---
  // Nilai tidak valid tidak pernah menimpa filter terakhir yang sah.
  function updateDuration(key, otherKey, id) {
    var input = $(id);
    var hint = $('f-duration-hint');
    var raw = input.value.trim();
    if (raw === '') {
      state.filters[key] = '';
      input.setAttribute('aria-invalid', 'false');
      hint.textContent = 'Cleared Time − DateOccured · bawah inklusif, atas eksklusif';
      hint.classList.remove('is-error');
      state.page = 0;
      renderAll();
      return;
    }
    var n = Number(raw);
    if (!isFinite(n) || n < 0) {
      hint.textContent = 'Durasi harus angka jam yang valid (≥ 0).';
      hint.classList.add('is-error');
      input.setAttribute('aria-invalid', 'true');
      return;
    }
    var other = state.filters[otherKey];
    if (other !== '' && key === 'durationFrom' && n >= Number(other)) {
      hint.textContent = 'Durasi "dari" harus lebih kecil dari "sampai".';
      hint.classList.add('is-error');
      input.setAttribute('aria-invalid', 'true');
      return;
    }
    if (other !== '' && key === 'durationTo' && n <= Number(other)) {
      hint.textContent = 'Durasi "sampai" harus lebih besar dari "dari".';
      hint.classList.add('is-error');
      input.setAttribute('aria-invalid', 'true');
      return;
    }
    state.filters[key] = raw;
    input.setAttribute('aria-invalid', 'false');
    hint.textContent = 'Cleared Time − DateOccured · bawah inklusif, atas eksklusif';
    hint.classList.remove('is-error');
    state.page = 0;
    renderAll();
  }
  var durationDebounce = {};
  ['f-duration-from', 'f-duration-to'].forEach(function (id) {
    var key = id === 'f-duration-from' ? 'durationFrom' : 'durationTo';
    var otherKey = id === 'f-duration-from' ? 'durationTo' : 'durationFrom';
    $(id).addEventListener('input', function () {
      clearTimeout(durationDebounce[id]);
      durationDebounce[id] = setTimeout(function () { updateDuration(key, otherKey, id); }, 250);
    });
    $(id).addEventListener('change', function () {
      clearTimeout(durationDebounce[id]);
      updateDuration(key, otherKey, id);
    });
  });

  $('btn-reset').addEventListener('click', function () {
    state.filters = Object.assign({}, INITIAL_FILTERS);
    ['f-nop', 'f-cluster', 'f-severity', 'f-status', 'f-sla'].forEach(function (id) {
      var el = $(id);
      el.value = '';
      el.classList.remove('is-set');
    });
    $('f-from').value = '';
    $('f-to').value = '';
    ['f-duration-from', 'f-duration-to'].forEach(function (id) {
      var el = $(id);
      el.value = '';
      el.setAttribute('aria-invalid', 'false');
    });
    $('f-duration-hint').textContent = 'Cleared Time − DateOccured · bawah inklusif, atas eksklusif';
    $('f-duration-hint').classList.remove('is-error');
    state.page = 0;
    renderAll();
  });

  // --- alih grafik ⇄ tabel ---
  document.querySelectorAll('[data-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var name = btn.getAttribute('data-toggle');
      state.view[name] = (state.view[name] || 'chart') === 'chart' ? 'table' : 'chart';
      applyView(name);
    });
  });
  document.addEventListener('click', function (e) {
    var back = e.target.closest ? e.target.closest('[data-back]') : null;
    if (!back) return;
    var card = back.closest('[data-card]');
    if (!card) return;
    var name = card.getAttribute('data-card');
    state.view[name] = 'chart';
    applyView(name);
  });

  // --- tabel ---
  document.querySelectorAll('#data-table th button[data-sort]').forEach(function (b) {
    b.addEventListener('click', function () {
      var key = b.getAttribute('data-sort');
      state.sort = state.sort.key === key
        ? { key: key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
        : { key: key, dir: 'desc' };
      state.page = 0;
      renderTable();
    });
  });
  document.querySelectorAll('[data-page]').forEach(function (b) {
    b.addEventListener('click', function () {
      var totalPages = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
      var kind = b.getAttribute('data-page');
      if (kind === 'first') state.page = 0;
      else if (kind === 'prev') state.page = Math.max(0, state.page - 1);
      else if (kind === 'next') state.page = Math.min(totalPages - 1, state.page + 1);
      else state.page = totalPages - 1;
      renderTable();
    });
  });
  $('btn-export').addEventListener('click', exportFilteredCsv);

  // --- gambar ulang grafik bila lebar layar berubah ---
  window.addEventListener('resize', debounce(function () {
    if (state.data) renderCharts();
  }, 180));
}

if (typeof document !== 'undefined' && document.addEventListener) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
