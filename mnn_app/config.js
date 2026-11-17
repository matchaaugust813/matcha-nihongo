/* =========================================================
   KONFIGURASI AKUN & SINKRONISASI (Supabase)
   =========================================================
   Ganti DUA nilai di bawah ini dengan milik proyek Supabase-mu
   sendiri (gratis). Cara mendapatkannya ada di panduan
   "CARA_DEPLOY_ONLINE.txt".

   1. Buka https://supabase.com -> New Project (gratis)
   2. Buka Project Settings -> API
   3. Salin "Project URL" -> tempel di bawah sebagai `url`
   4. Salin "anon public" key -> tempel di bawah sebagai `anonKey`

   Selama nilai di bawah masih "GANTI_DENGAN_...", aplikasi akan
   otomatis berjalan seperti versi lokal biasa (progres hanya
   tersimpan di browser ini, tanpa akun) -- jadi aman untuk
   dites dulu sebelum kamu setting Supabase.
   ========================================================= */
window.SUPABASE_CONFIG = {
  url: "YOUR URL",
  anonKey: "YOUR ANONKEY"
};
