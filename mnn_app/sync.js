/* =========================================================
   Minna no Nihongo — Sinkronisasi Akun (opsional, via Supabase)
   =========================================================
   File ini BEKERJA DI LUAR app.js -- tidak mengubah satu baris
   pun kode app.js. Caranya:

   1. Sebelum app.js dimuat, file ini menampilkan pintu masuk
      (login / daftar / lanjut tanpa akun). Kalau user sudah
      login, progres dari cloud ditulis dulu ke localStorage,
      BARU app.js dimuat -- jadi app.js membaca data yang sudah
      tersinkron seolah itu data lokal biasa.
   2. Selama sesi berjalan, setiap kali app.js menyimpan progres
      (lewat localStorage.setItem, seperti biasa) file ini
      "menyadap" panggilan itu dan mengirim salinannya ke cloud
      beberapa saat kemudian (debounced), supaya progres selalu
      tersinkron ke akunmu.
   3. Sebuah tombol akun (ikon orang) disisipkan ke deretan
      tombol ikon yang sudah ada di halaman utama (sebaris
      dengan tombol tema/statistik/cari/reset) -- tidak ada
      elemen mengambang terpisah yang bisa menutupi tampilan.

   Kalau config.js belum diisi (lihat file itu), fitur akun ini
   otomatis nonaktif dan aplikasi berjalan seperti versi lokal
   biasa -- tidak ada yang rusak.
   ========================================================= */
(function () {
  "use strict";

  var LS_SRS = "mnn:srs:v1";
  var LS_STREAK = "mnn:streak:v1";
  var LS_PREFS = "mnn:prefs:v1";
  var LS_REVIEWLOG = "mnn:reviewlog:v1";
  var LS_GUEST = "mnn:sync:guest:v1";
  var TRACKED_KEYS = [LS_SRS, LS_STREAK, LS_PREFS, LS_REVIEWLOG];

  var cfg = window.SUPABASE_CONFIG || {};
  var supabase = null;
  var currentUser = null;
  var pushTimer = null;
  var topbarObserver = null;
  var suppressPush = false; // true sesaat ketika kita sendiri yang menulis (hasil tarikan dari cloud)

  /* Terapkan tema tersimpan sedini mungkin, supaya modal login
     memakai tema yang sama dengan yang terakhir dipilih user. */
  try {
    var savedPrefsRaw = localStorage.getItem(LS_PREFS);
    var savedPrefs = savedPrefsRaw ? JSON.parse(savedPrefsRaw) : null;
    if (savedPrefs && savedPrefs.theme) {
      document.documentElement.setAttribute("data-theme", savedPrefs.theme);
    }
  } catch (e) { /* abaikan */ }

  function configReady() {
    return !!(cfg.url && cfg.anonKey &&
      cfg.url.indexOf("GANTI_DENGAN_") === -1 &&
      cfg.anonKey.indexOf("GANTI_DENGAN_") === -1);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function loadAppScript() {
    if (document.getElementById("mnn-app-script")) return;
    var s = document.createElement("script");
    s.id = "mnn-app-script";
    s.src = "app.js";
    document.body.appendChild(s);
  }

  /* ---------------- Bundle helpers (4 key localStorage <-> 1 row Supabase) ---------------- */
  function readLocalBundle() {
    var out = {};
    TRACKED_KEYS.forEach(function (k) {
      var raw = localStorage.getItem(k);
      try { out[k] = raw ? JSON.parse(raw) : null; } catch (e) { out[k] = null; }
    });
    return out;
  }
  function writeLocalBundle(bundle) {
    suppressPush = true;
    try {
      TRACKED_KEYS.forEach(function (k) {
        if (bundle[k] !== undefined && bundle[k] !== null) {
          localStorage.setItem(k, JSON.stringify(bundle[k]));
        }
      });
    } finally {
      suppressPush = false;
    }
  }
  function hasAnyLocalProgress() {
    return TRACKED_KEYS.some(function (k) { return !!localStorage.getItem(k); });
  }
  function bundleToRow(userId, bundle) {
    return {
      user_id: userId,
      srs: bundle[LS_SRS] || {},
      streak: bundle[LS_STREAK] || { lastDate: null, count: 0, longest: 0 },
      prefs: bundle[LS_PREFS] || { showFuriganaFront: false, theme: "dark" },
      reviewlog: bundle[LS_REVIEWLOG] || {},
      updated_at: new Date().toISOString()
    };
  }
  function rowToBundle(row) {
    var out = {};
    out[LS_SRS] = row.srs || {};
    out[LS_STREAK] = row.streak || { lastDate: null, count: 0, longest: 0 };
    out[LS_PREFS] = row.prefs || { showFuriganaFront: false, theme: "dark" };
    out[LS_REVIEWLOG] = row.reviewlog || {};
    return out;
  }

  /* ---------------- Push otomatis ke cloud ---------------- */
  function schedulePush() {
    if (!currentUser || !supabase) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      var row = bundleToRow(currentUser.id, readLocalBundle());
      supabase.from("progress").upsert(row).then(function (res) {
        if (res && res.error) console.warn("[sinkron] gagal menyimpan ke cloud:", res.error.message);
      });
    }, 1500);
  }

  // Sadap SEMUA localStorage.setItem di halaman ini. Kalau kuncinya salah
  // satu dari 4 kunci progres MNN, jadwalkan pengiriman ke cloud.
  // app.js tidak tahu-menahu soal ini dan tidak perlu diubah.
  var nativeSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    nativeSetItem.apply(this, arguments);
    if (!suppressPush && TRACKED_KEYS.indexOf(key) !== -1) schedulePush();
  };

  /* ---------------- Tarik data dari cloud ---------------- */
  function pullAndApply(userId) {
    return supabase.from("progress").select("*").eq("user_id", userId).maybeSingle()
      .then(function (res) {
        if (res.error) throw res.error;
        if (res.data) {
          writeLocalBundle(rowToBundle(res.data));
        } else if (hasAnyLocalProgress()) {
          // Akun baru & sudah ada progres lokal (mis. dari mode tamu) -> migrasikan ke cloud
          return supabase.from("progress").insert(bundleToRow(userId, readLocalBundle()));
        }
      });
  }

  /* ---------------- Gaya tambahan -----------------------------------------
     Sengaja HANYA dipakai untuk elemen form (input/tab) yang belum ada
     komponennya di app ini. Untuk kartu, judul, teks, dan tombol, kita
     pakai ulang class .modal-box/.modal-btn/.iconbtn yang SUDAH ada di
     style.css -- supaya warnanya otomatis benar & konsisten di ketiga
     tema (dark/light/japanese), sama seperti tombol/modal bawaan app. */
  function injectStyle() {
    if (document.getElementById("mnn-sync-style")) return;
    var css = ""
      + ".mnn-auth-field{width:100%;box-sizing:border-box;margin-bottom:10px;padding:12px 14px;"
      + "border-radius:12px;border:1.5px solid var(--line-on-paper);background:rgba(0,0,0,0.035);"
      + "color:var(--sumi);font-family:var(--font-ui);font-size:14px;}"
      + ".mnn-auth-field:focus{outline:2px solid var(--indigo);outline-offset:1px;}"
      + ".mnn-auth-tabs{display:flex;gap:8px;margin-bottom:16px;}"
      + ".mnn-auth-tab{flex:1;border:none;border-radius:12px;padding:9px 6px;font-family:var(--font-ui);"
      + "font-weight:700;font-size:12.5px;cursor:pointer;background:rgba(33,29,23,0.06);color:var(--sumi-soft);}"
      + ".mnn-auth-tab.active{background:var(--indigo);color:var(--kinari);}"
      + ".mnn-auth-err{color:var(--shu);font-size:12.5px;margin:-6px 0 12px;min-height:1em;text-align:left;}"
      + ".mnn-auth-msg{color:var(--matcha);font-size:12.5px;margin:-6px 0 12px;min-height:1em;text-align:left;}"
      + ".mnn-auth-guest{background:none;border:none;color:var(--sumi-soft);font-size:12.5px;"
      + "text-decoration:underline;cursor:pointer;margin-top:14px;font-family:var(--font-ui);}"
      + ".mnn-account-email{font-weight:700;color:var(--sumi);word-break:break-all;}"
      // Di layar sempit, tombol akun (ditambahkan sebagai anak ke-5 di deretan
      // ikon) bisa terdorong keluar layar karena barisnya tidak membungkus.
      // Izinkan membungkus ke baris baru supaya semua tombol tetap terlihat,
      // tanpa perlu geser layar.
      + "@media (max-width:560px){.topbar-actions{flex-wrap:wrap;justify-content:flex-end;row-gap:8px;}}";
    var style = document.createElement("style");
    style.id = "mnn-sync-style";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function accountIcon() {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>';
  }

  /* ---------------- Modal login/daftar ---------------- */
  function showAuthModal(onDone) {
    injectStyle();
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.zIndex = "99999";

    var html = '<div class="modal-box">';
    html += '<div class="modal-seal">口</div>';
    html += '<h3>Masuk untuk Sinkronkan Progres</h3>';
    html += '<p>Simpan progres belajarmu ke akun supaya bisa dibuka dari HP, laptop, atau browser mana saja.</p>';
    html += '<div class="mnn-auth-tabs">';
    html += '  <button type="button" class="mnn-auth-tab active" data-tab="login">Masuk</button>';
    html += '  <button type="button" class="mnn-auth-tab" data-tab="signup">Daftar Akun Baru</button>';
    html += '</div>';
    html += '<input type="email" class="mnn-auth-field" id="mnn-auth-email" placeholder="Alamat email" autocomplete="email" />';
    html += '<input type="password" class="mnn-auth-field" id="mnn-auth-pass" placeholder="Kata sandi" autocomplete="current-password" />';
    html += '<div class="mnn-auth-err" id="mnn-auth-err"></div>';
    html += '<div class="mnn-auth-msg" id="mnn-auth-msg"></div>';
    html += '<div class="modal-actions">';
    html += '  <button type="button" class="modal-btn confirm" id="mnn-auth-submit">Masuk</button>';
    html += '</div>';
    html += '<button type="button" class="mnn-auth-guest" id="mnn-auth-guest">Lanjutkan tanpa akun (offline saja, di browser ini)</button>';
    html += '</div>';
    overlay.innerHTML = html;
    document.body.appendChild(overlay);

    var mode = "login";
    var tabs = overlay.querySelectorAll(".mnn-auth-tab");
    var submitBtn = document.getElementById("mnn-auth-submit");
    var errEl = document.getElementById("mnn-auth-err");
    var msgEl = document.getElementById("mnn-auth-msg");
    var emailEl = document.getElementById("mnn-auth-email");
    var passEl = document.getElementById("mnn-auth-pass");

    Array.prototype.forEach.call(tabs, function (tab) {
      tab.addEventListener("click", function () {
        mode = tab.getAttribute("data-tab");
        Array.prototype.forEach.call(tabs, function (t) { t.classList.remove("active"); });
        tab.classList.add("active");
        submitBtn.textContent = mode === "login" ? "Masuk" : "Daftar & Masuk";
        errEl.textContent = "";
        msgEl.textContent = "";
      });
    });

    function finish() {
      document.body.removeChild(overlay);
      onDone();
    }

    function setBusy(busy) {
      submitBtn.disabled = busy;
      submitBtn.style.opacity = busy ? "0.6" : "1";
    }

    submitBtn.addEventListener("click", function () {
      var email = (emailEl.value || "").trim();
      var pass = passEl.value || "";
      errEl.textContent = "";
      msgEl.textContent = "";
      if (!email || !pass) { errEl.textContent = "Isi email dan kata sandi dulu, ya."; return; }
      if (pass.length < 6) { errEl.textContent = "Kata sandi minimal 6 karakter."; return; }
      setBusy(true);

      var action = mode === "login"
        ? supabase.auth.signInWithPassword({ email: email, password: pass })
        : supabase.auth.signUp({ email: email, password: pass });

      action.then(function (res) {
        if (res.error) { setBusy(false); errEl.textContent = terjemahkanError(res.error.message); return; }
        if (mode === "signup" && !res.data.session) {
          // Konfirmasi email masih aktif di project Supabase ini
          setBusy(false);
          msgEl.textContent = "Akun dibuat! Cek email kamu untuk konfirmasi, lalu masuk lagi di sini.";
          mode = "login";
          tabs[0].click();
          return;
        }
        currentUser = res.data.session.user;
        pullAndApply(currentUser.id).catch(function (e) {
          console.warn("[sinkron] gagal mengambil data cloud:", e);
        }).then(finish);
      });
    });

    document.getElementById("mnn-auth-guest").addEventListener("click", function () {
      localStorage.setItem(LS_GUEST, "1");
      document.body.removeChild(overlay);
      onDone();
    });

    // Enter key submits
    [emailEl, passEl].forEach(function (el) {
      el.addEventListener("keydown", function (e) { if (e.key === "Enter") submitBtn.click(); });
    });
  }

  function terjemahkanError(msg) {
    if (/already registered|already exists/i.test(msg)) return "Email ini sudah terdaftar. Coba tab \"Masuk\".";
    if (/invalid login credentials/i.test(msg)) return "Email atau kata sandi salah.";
    if (/rate limit/i.test(msg)) return "Terlalu banyak percobaan. Coba lagi sebentar lagi.";
    return msg;
  }

  /* ---------------- Modal info akun (saat sudah login) ---------------- */
  function showAccountModal() {
    injectStyle();
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.zIndex = "99999";

    var html = '<div class="modal-box">';
    html += '<div class="modal-seal">口</div>';
    html += '<h3>Akun Kamu</h3>';
    html += '<p>Masuk sebagai:<br><span class="mnn-account-email">' + esc(currentUser.email) + '</span><br>Progres belajar otomatis tersinkron ke akun ini.</p>';
    html += '<div class="modal-actions">';
    html += '  <button type="button" class="modal-btn cancel" id="mnn-acc-close">Tutup</button>';
    html += '  <button type="button" class="modal-btn danger" id="mnn-acc-logout">Keluar</button>';
    html += '</div></div>';
    overlay.innerHTML = html;
    document.body.appendChild(overlay);

    function close() { document.body.removeChild(overlay); }
    document.getElementById("mnn-acc-close").addEventListener("click", close);
    document.getElementById("mnn-acc-logout").addEventListener("click", function () {
      close();
      if (!confirm("Keluar dari akun? Progres di cloud aman, hanya salinan di browser ini yang dihapus.")) return;
      clearTimeout(pushTimer);
      supabase.auth.signOut().then(function () {
        TRACKED_KEYS.forEach(function (k) { localStorage.removeItem(k); });
        localStorage.removeItem(LS_GUEST);
        location.reload();
      });
    });
  }

  /* ---------------- Tombol akun terintegrasi (di deretan tombol ikon) ---------------- */
  function injectAccountButton() {
    injectStyle(); // pastikan CSS (termasuk perbaikan wrap di layar sempit) selalu ada
    var actions = document.querySelector(".topbar-actions");
    if (!actions || document.getElementById("mnn-account-btn")) return;
    var btn = document.createElement("button");
    btn.className = "iconbtn";
    btn.id = "mnn-account-btn";
    btn.title = currentUser ? "Akun (" + currentUser.email + ")" : "Masuk / buat akun";
    btn.innerHTML = accountIcon();
    btn.addEventListener("click", function () {
      if (currentUser) showAccountModal();
      else showAuthModal(function () { location.reload(); });
    });
    actions.appendChild(btn);
  }

  function startWatchingTopbar() {
    var root = document.getElementById("app-root");
    if (!root || topbarObserver) return;
    injectAccountButton();
    topbarObserver = new MutationObserver(function () { injectAccountButton(); });
    topbarObserver.observe(root, { childList: true, subtree: true });
  }

  /* ---------------- Bootstrap ---------------- */
  function boot() {
    if (!configReady() || typeof window.supabase === "undefined") {
      // Belum dikonfigurasi (atau CDN Supabase gagal dimuat, mis. offline)
      // -> jalankan versi lokal murni seperti semula, tanpa akun.
      loadAppScript();
      return;
    }
    supabase = window.supabase.createClient(cfg.url, cfg.anonKey);

    supabase.auth.getSession().then(function (res) {
      var session = res.data && res.data.session;
      if (session) {
        currentUser = session.user;
        pullAndApply(session.user.id).catch(function (e) {
          console.warn("[sinkron] gagal mengambil data cloud:", e);
        }).then(function () {
          loadAppScript();
          startWatchingTopbar();
        });
      } else if (localStorage.getItem(LS_GUEST) === "1") {
        loadAppScript();
        startWatchingTopbar();
      } else {
        showAuthModal(function () {
          loadAppScript();
          startWatchingTopbar();
        });
      }
    }).catch(function (e) {
      console.warn("[sinkron] tidak bisa menghubungi Supabase, jalan offline:", e);
      loadAppScript();
    });
  }

  boot();
})();
