# Fitur Admin Prestasi MTSN 3 Banyuwangi - Design Spec

**Tanggal:** 2026-05-22
**Pendekatan:** B - Moderat (5 fitur baru)
**Prinsip:** Tidak mengubah fitur yang sudah berjalan (#jurnal, #laporan, #billing, /today, /menu)

---

## Fitur Baru

### 1. `/prestasi` — Input & Query Data Prestasi Siswa

**Deskripsi:** Admin prestasi dapat menambahkan data prestasi siswa dan menampilkan daftar/rekap prestasi.

**Command Format:**
```
/prestasi add <nama_siswa> <kelas> <jenis_lomba> <tingkat> <hasil>
/prestasi list [bulan] [tahun]
/prestasi detail <id_prestasi>
```

**Contoh:**
```
/prestasi add Ahmad Rizky 8A Olimpiade MTK kabupaten juara1
/prestasi list maret 2026
/prestasi detail 15
```

**Akses:** Hanya admin prestasi (AUTHORIZED_NUMBERS + role-based)

---

### 2. `/absensi` — Monitor Kehadiran Siswa & Guru

**Deskripsi:** Memantau data kehadiran siswa/guru per hari atau minggu. Admin bisa cek summary absensi dan guru bisa input absensi siswa.

**Command Format:**
```
/absensi siswa <kelas> [tanggal]
/absensi guru [tanggal]
/absensi rekap <kelas> <bulan> [tahun]
/absensi input <kelas> <nis> <status>
```

**Contoh:**
```
/absensi siswa 8A              (hari ini)
/absensi siswa 8A 2026-05-20   (tanggal tertentu)
/absensi guru                  (hari ini)
/absensi rekap 8A mei 2026     (rekap bulanan)
/absensi input 8A 12345 sakit  (input absensi)
```

**Akses:**
- `list/rekap` — admin prestasi + guru
- `input` — hanya guru wali kelas (AUTHORIZED_NUMBERS)

---

### 3. `/ekstra-monitor` — Tracking Kegiatan Ekstrakurikuler

**Deskripsi:** Monitor kehadiran dan status kegiatan ekstrakurikuler. Pembina ekstra bisa input kehadiran, admin bisa cek rekap.

**Command Format:**
```
/ekstra-monitor kehadiran <nama_ekstra> [tanggal]
/ekstra-monitor rekap <nama_ekstra> <bulan> [tahun]
/ekstra-monitor input <nama_ekstra> <nis_list> <status>
/ekstra-monitor list
```

**Contoh:**
```
/ekstra-monitor kehadiran Pramuka             (hari ini)
/ekstra-monitor rekap Pramuka mei 2026        (rekap bulanan)
/ekstra-monitor input Pramuka 12345,12346 hadir
/ekstra-monitor list                           (daftar semua ekstra)
```

**Akses:**
- `list/kehadiran/rekap` — admin + pembina ekstra
- `input` — hanya pembina ekstra (AUTHORIZED_NUMBERS)

---

### 4. `/rapor-status` — Cek Status Pengisian Rapor

**Deskripsi:** Mirip `/today` untuk jurnal, tapi untuk memantau status pengisian rapor oleh wali kelas. Admin bisa lihat mana kelas yang sudah/sebelum mengisi rapor.

**Command Format:**
```
/rapor-status [semester] [tahun_ajaran]
```

**Contoh:**
```
/rapor-status                (semester aktif, tahun ajaran aktif)
/rapor-status 2 2025/2026    (semester 2 tahun ajaran 2025/2026)
```

**Akses:** Hanya admin prestasi (AUTHORIZED_NUMBERS)

---

### 5. `/pengumuman` — Kirim Pengumuman ke Grup Tertentu

**Deskripsi:** Admin/kepala sekolah dapat mengirim pengumuman ke grup WhatsApp tertentu (grup guru, grup wali murid per kelas, dll).

**Command Format:**
```
/pengumuman <target_grup> <isi_pengumuman>
```

**Target grup yang didukung:**
- `guru` — kirim ke semua grup guru
- `wali_<kelas>` — kirim ke grup wali murid kelas tertentu (contoh: `wali_8A`)
- `all` — kirim ke semua grup

**Contoh:**
```
/pengumuman guru Rapat koordinasi jumat 10:00 di ruang guru
/pengumuman wali_8A Pengambilan rapor tanggal 25 Mei
/pengumuman all Libur nasional 1 Juni, sekolah tutup
```

**Akses:** Hanya admin prestasi + kepala sekolah (AUTHORIZED_NUMBERS)

---

## Kebutuhan API Endpoint untuk Backend

### 1. Prestasi Siswa API

#### POST /api/prestasi/add
Tambah data prestasi siswa baru.

**Headers:**
```
Content-Type: application/json
X-API-Key: whatsapp_bot_key_2024
```

**Request Body:**
```json
{
  "nama_siswa": "Ahmad Rizky",
  "nis": "12345",
  "kelas": "8A",
  "jenis_lomba": "Olimpiade MTK",
  "tingkat": "kabupaten",
  "hasil": "juara1",
  "tanggal": "2026-05-20",
  "pembina": "Budi Santoso",
  "catatan": ""
}
```

**Response Success (200):**
```json
{
  "status": "success",
  "data": {
    "id": 15,
    "nama_siswa": "Ahmad Rizky",
    "nis": "12345",
    "kelas": "8A",
    "jenis_lomba": "Olimpiade MTK",
    "tingkat": "kabupaten",
    "hasil": "juara1",
    "tanggal": "2026-05-20",
    "pembina": "Budi Santoso",
    "catatan": ""
  }
}
```

**Response Error (400):**
```json
{
  "status": "error",
  "message": "Data prestasi tidak valid"
}
```

---

#### GET /api/prestasi/list
Daftar prestasi berdasarkan bulan/tahun.

**Headers:**
```
Content-Type: application/json
X-API-Key: whatsapp_bot_key_2024
```

**Query Parameters:**
| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `bulan` | integer | No | Bulan (1-12). Default: bulan saat ini | `5` |
| `tahun` | integer | No | Tahun. Default: tahun saat ini | `2026` |
| `kelas` | string | No | Filter per kelas | `8A` |
| `tingkat` | string | No | Filter per tingkat (kabupaten/provinsi/nasional/internasional) | `kabupaten` |

**Response Success (200):**
```json
{
  "status": "success",
  "data": [
    {
      "id": 15,
      "nama_siswa": "Ahmad Rizky",
      "nis": "12345",
      "kelas": "8A",
      "jenis_lomba": "Olimpiade MTK",
      "tingkat": "kabupaten",
      "hasil": "juara1",
      "tanggal": "2026-05-20",
      "pembina": "Budi Santoso"
    }
  ],
  "total": 1
}
```

**Response Success — Tidak Ada Data:**
```json
{
  "status": "success",
  "data": [],
  "total": 0
}
```

---

#### GET /api/prestasi/detail/{id}
Detail prestasi berdasarkan ID.

**Headers:**
```
Content-Type: application/json
X-API-Key: whatsapp_bot_key_2024
```

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer | Yes | ID prestasi |

**Response Success (200):**
```json
{
  "status": "success",
  "data": {
    "id": 15,
    "nama_siswa": "Ahmad Rizky",
    "nis": "12345",
    "kelas": "8A",
    "jenis_lomba": "Olimpiade MTK",
    "tingkat": "kabupaten",
    "hasil": "juara1",
    "tanggal": "2026-05-20",
    "pembina": "Budi Santoso",
    "catatan": "",
    "foto_url": null
  }
}
```

**Response Error (404):**
```json
{
  "status": "error",
  "message": "Prestasi tidak ditemukan"
}
```

---

### 2. Absensi API

#### GET /api/absensi/siswa
Data absensi siswa per kelas per tanggal.

**Headers:**
```
Content-Type: application/json
X-API-Key: whatsapp_bot_key_2024
```

**Query Parameters:**
| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `kelas` | string | Yes | Nama kelas | `8A` |
| `tanggal` | string | No | Tanggal (YYYY-MM-DD). Default: hari ini | `2026-05-20` |

**Response Success (200):**
```json
{
  "status": "success",
  "data": {
    "kelas": "8A",
    "tanggal": "2026-05-20",
    "total_siswa": 30,
    "hadir": 25,
    "sakit": 3,
    "izin": 1,
    "alfa": 1,
    "detail": [
      {
        "nis": "12345",
        "nama_siswa": "Ahmad Rizky",
        "status": "hadir"
      }
    ]
  }
}
```

---

#### GET /api/absensi/guru
Data absensi guru per tanggal.

**Headers:**
```
Content-Type: application/json
X-API-Key: whatsapp_bot_key_2024
```

**Query Parameters:**
| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `tanggal` | string | No | Tanggal (YYYY-MM-DD). Default: hari ini | `2026-05-20` |

**Response Success (200):**
```json
{
  "status": "success",
  "data": {
    "tanggal": "2026-05-20",
    "total_guru": 20,
    "hadir": 18,
    "sakit": 1,
    "izin": 1,
    "alfa": 0,
    "detail": [
      {
        "nip": "198501012010011001",
        "nama_guru": "Budi Santoso",
        "status": "hadir"
      }
    ]
  }
}
```

---

#### POST /api/absensi/input
Input absensi siswa oleh wali kelas.

**Headers:**
```
Content-Type: application/json
X-API-Key: whatsapp_bot_key_2024
```

**Request Body:**
```json
{
  "kelas": "8A",
  "tanggal": "2026-05-20",
  "data": [
    {
      "nis": "12345",
      "status": "sakit"
    },
    {
      "nis": "12346",
      "status": "izin"
    }
  ]
}
```

**Response Success (200):**
```json
{
  "status": "success",
  "message": "Absensi berhasil diinput",
  "data": {
    "kelas": "8A",
    "tanggal": "2026-05-20",
    "jumlah_input": 2
  }
}
```

---

#### GET /api/absensi/rekap
Rekap absensi bulanan per kelas.

**Headers:**
```
Content-Type: application/json
X-API-Key: whatsapp_bot_key_2024
```

**Query Parameters:**
| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `kelas` | string | Yes | Nama kelas | `8A` |
| `bulan` | integer | Yes | Bulan (1-12) | `5` |
| `tahun` | integer | No | Tahun. Default: tahun saat ini | `2026` |

**Response Success (200):**
```json
{
  "status": "success",
  "data": {
    "kelas": "8A",
    "bulan": 5,
    "tahun": 2026,
    "total_hari_efektif": 22,
    "rata_rata_hadir": 0.92,
    "siswa_alfa_tertinggi": [
      {
        "nis": "12350",
        "nama_siswa": "Dian Pratama",
        "jumlah_alfa": 5
      }
    ]
  }
}
```

---

### 3. Ekstra Monitor API

#### GET /api/ekstra/kehadiran
Kehadiran ekstrakurikuler per tanggal.

**Headers:**
```
Content-Type: application/json
X-API-Key: whatsapp_bot_key_2024
```

**Query Parameters:**
| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `nama_ekstra` | string | Yes | Nama ekstrakurikuler | `Pramuka` |
| `tanggal` | string | No | Tanggal (YYYY-MM-DD). Default: hari ini | `2026-05-20` |

**Response Success (200):**
```json
{
  "status": "success",
  "data": {
    "nama_ekstra": "Pramuka",
    "pembina": "Ahmad Fauzi",
    "tanggal": "2026-05-20",
    "total_peserta": 25,
    "hadir": 20,
    "tidak_hadir": 5,
    "detail": [
      {
        "nis": "12345",
        "nama_siswa": "Ahmad Rizky",
        "status": "hadir"
      }
    ]
  }
}
```

---

#### GET /api/ekstra/rekap
Rekap kehadiran ekstra bulanan.

**Headers:**
```
Content-Type: application/json
X-API-Key: whatsapp_bot_key_2024
```

**Query Parameters:**
| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `nama_ekstra` | string | Yes | Nama ekstrakurikuler | `Pramuka` |
| `bulan` | integer | Yes | Bulan (1-12) | `5` |
| `tahun` | integer | No | Tahun. Default: tahun saat ini | `2026` |

**Response Success (200):**
```json
{
  "status": "success",
  "data": {
    "nama_ekstra": "Pramuka",
    "bulan": 5,
    "tahun": 2026,
    "total_pertemuan": 4,
    "rata_rata_hadir": 0.85,
    "peserta_tidak_aktif": [
      {
        "nis": "12350",
        "nama_siswa": "Dian Pratama",
        "jumlah_tidak_hadir": 3
      }
    ]
  }
}
```

---

#### POST /api/ekstra/input
Input kehadiran ekstra oleh pembina.

**Headers:**
```
Content-Type: application/json
X-API-Key: whatsapp_bot_key_2024
```

**Request Body:**
```json
{
  "nama_ekstra": "Pramuka",
  "tanggal": "2026-05-20",
  "data": [
    {
      "nis": "12345",
      "status": "hadir"
    },
    {
      "nis": "12350",
      "status": "tidak_hadir"
    }
  ]
}
```

**Response Success (200):**
```json
{
  "status": "success",
  "message": "Kehadiran ekstra berhasil diinput",
  "data": {
    "nama_ekstra": "Pramuka",
    "tanggal": "2026-05-20",
    "jumlah_input": 2
  }
}
```

---

#### GET /api/ekstra/list
Daftar semua ekstrakurikuler.

**Headers:**
```
Content-Type: application/json
X-API-Key: whatsapp_bot_key_2024
```

**Query Parameters:** Tidak ada

**Response Success (200):**
```json
{
  "status": "success",
  "data": [
    {
      "id": 1,
      "nama_ekstra": "Pramuka",
      "pembina": "Ahmad Fauzi",
      "total_peserta": 25,
      "jadwal": "Selasa, 14:00-16:00"
    },
    {
      "id": 2,
      "nama_ekstra": "PMR",
      "pembina": "Siti Aminah",
      "total_peserta": 15,
      "jadwal": "Kamis, 14:00-16:00"
    }
  ]
}
```

---

### 4. Rapor Status API

#### GET /api/rapor/status
Status pengisian rapor per kelas.

**Headers:**
```
Content-Type: application/json
X-API-Key: whatsapp_bot_key_2024
```

**Query Parameters:**
| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `semester` | integer | No | Semester (1 atau 2). Default: semester aktif | `2` |
| `tahun_ajaran` | string | No | Tahun ajaran. Default: tahun ajaran aktif | `2025/2026` |

**Response Success (200):**
```json
{
  "status": "success",
  "data": {
    "semester": 2,
    "tahun_ajaran": "2025/2026",
    "total_kelas": 8,
    "sudah_isi": 3,
    "belum_isi": 5,
    "detail": [
      {
        "kelas": "7A",
        "wali_kelas": "Budi Santoso",
        "status": "selesai",
        "tanggal_isi": "2026-05-15"
      },
      {
        "kelas": "7B",
        "wali_kelas": "Siti Aminah",
        "status": "belum",
        "tanggal_isi": null
      }
    ]
  }
}
```

---

### 5. Pengumuman API

#### POST /api/pengumuman/send
Kirim pengumuman (backend menyimpan & mengarahkan ke grup target).

**Headers:**
```
Content-Type: application/json
X-API-Key: whatsapp_bot_key_2024
```

**Request Body:**
```json
{
  "target": "guru",
  "isi": "Rapat koordinasi jumat 10:00 di ruang guru",
  "pengirim": "6285212870484",
  "prioritas": "normal"
}
```

**Target yang didukung:** `guru`, `wali_<kelas>` (contoh: `wali_8A`), `all`

**Response Success (200):**
```json
{
  "status": "success",
  "message": "Pengumuman berhasil dikirim",
  "data": {
    "id": 10,
    "target": "guru",
    "isi": "Rapat koordinasi jumat 10:00 di ruang guru",
    "jumlah_grup": 3,
    "tanggal": "2026-05-20T10:00:00"
  }
}
```

---

#### GET /api/pengumuman/history
Riwayat pengumuman.

**Headers:**
```
Content-Type: application/json
X-API-Key: whatsapp_bot_key_2024
```

**Query Parameters:**
| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `limit` | integer | No | Jumlah pengumuman. Default: 10 | `10` |
| `target` | string | No | Filter per target | `guru` |

**Response Success (200):**
```json
{
  "status": "success",
  "data": [
    {
      "id": 10,
      "target": "guru",
      "isi": "Rapat koordinasi jumat 10:00 di ruang guru",
      "pengirim": "Admin Prestasi",
      "tanggal": "2026-05-20T10:00:00"
    }
  ]
}
```

---

## Mapping Grup WhatsApp

Untuk fitur `/pengumuman`, bot harus mengetahui mapping target ke grup WhatsApp JID:

```javascript
// Konfigurasi mapping grup (ditambahkan di commandHandler.js)
const GROUP_MAPPING = {
    guru: ['123456789-1234567890@g.us'],        // Grup guru
    wali_7A: ['123456789-1111111111@g.us'],      // Grup wali murid 7A
    wali_7B: ['123456789-2222222222@g.us'],      // Grup wali murid 7B
    wali_8A: ['123456789-3333333333@g.us'],      // Grup wali murid 8A
    // ... dst per kelas
    all: [] // akan dikirim ke semua grup di mapping
}
```

Konfigurasi ini bisa disimpan di `.env` atau file config terpisah.

---

## Implementasi Bot (Tidak Mengubah Fitur Existing)

**Perubahan hanya di:**
1. `src/modules/commandHandler.js` — tambahkan case baru di switch statement untuk 5 command baru
2. `.env` — tambahkan config GROUP_MAPPING (optional)
3. `KNOWN_COMMANDS` array — tambahkan 5 command baru

**Tidak diubah:**
- Semua handler existing (#jurnal, #laporan, #billing, /today, /menu)
- Routes, controllers, whatsapp.js, sessionManager, dll

---

## Field Enum/Referensi

### tingkat lomba
- `kabupaten`
- `provinsi`
- `nasional`
- `internasional`

### hasil lomba
- `juara1`
- `juara2`
- `juara3`
- `harapan`
- `peserta`

### status absensi
- `hadir`
- `sakit`
- `izin`
- `alfa`

### status ekstra kehadiran
- `hadir`
- `tidak_hadir`

### prioritas pengumuman
- `normal`
- `penting`
- `mendesak`
