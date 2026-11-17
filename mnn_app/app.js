/* =========================================================
   Minna no Nihongo — Kartu Kosakata
   Aplikasi flashcard dengan penjadwalan spasi (SRS ringan)
   ========================================================= */

(function () {
  "use strict";

  /* ---------------- Constants ---------------- */
  var BOOK1_RANGE = [1, 25];
  var BOOK2_RANGE = [26, 50];
  var MASTER_INTERVAL_DAYS = 21; // dianggap "dikuasai" jika interval >= ini
  var MAX_INTERVAL_DAYS = 730;   // batas atas interval (2 tahun) -- cegah "meledak" ke puluhan tahun
  var MAX_EASE = 3.0;            // batas atas faktor kemudahan -- cegah interval membesar tanpa kendali
  var DAY_MS = 24 * 60 * 60 * 1000;

  var LS_SRS = "mnn:srs:v1";
  var LS_STREAK = "mnn:streak:v1";
  var LS_PREFS = "mnn:prefs:v1";
  var LS_REVIEWLOG = "mnn:reviewlog:v1";
  var REVIEWLOG_KEEP_DAYS = 120;

  /* ---------------- DOM root ---------------- */
  var root = document.getElementById("app-root");

  /* ---------------- Flattened deck index ---------------- */
  var DECKS = Object.keys(MNN_DATA).sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); });
  var CARD_BY_ID = {};
  DECKS.forEach(function (bab) {
    MNN_DATA[bab].forEach(function (c) { CARD_BY_ID[c.id] = c; c._bab = bab; });
  });

  var EXTRA_META = {
    kata_sifat: { label: "Kata Sifat", icon: "形", desc: "Adjektiva tambahan di luar 50 bab" },
    kata_benda: { label: "Kata Benda", icon: "名", desc: "Nomina tambahan di luar 50 bab" },
    kata_kerja: { label: "Kata Kerja", icon: "動", desc: "Verba tambahan di luar 50 bab" }
  };
  var EXTRA_KEYS = typeof EXTRA_DATA !== "undefined" ? Object.keys(EXTRA_DATA) : [];
  EXTRA_KEYS.forEach(function (key) {
    (EXTRA_DATA[key] || []).forEach(function (c) { CARD_BY_ID[c.id] = c; c._bab = key; });
  });
  var ALL_DECK_KEYS = DECKS.concat(EXTRA_KEYS);

  function getDeck(key) {
    return MNN_DATA[key] || (typeof EXTRA_DATA !== "undefined" ? EXTRA_DATA[key] : null) || [];
  }
  function babLabel(key) {
    if (/^\d+$/.test(key)) return "Bab " + key;
    return (EXTRA_META[key] && EXTRA_META[key].label) || key;
  }
  function sessionLabel(key) {
    if (key === "campuran") return "Campuran Lintas Bab";
    return babLabel(key);
  }

  /* ---------------- Persistence helpers ---------------- */
  function loadJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {
      console.warn("[MNN] localStorage penuh, progres mungkin tidak tersimpan:", e);
    }
  }

  var srsState = loadJSON(LS_SRS, {});      // { cardId: {ease,interval,reps,lapses,due,lastReview} }
  (function sanitizeLegacyIntervals() {
    // Perbaiki data lama yang sempat kena bug interval "meledak" (ratusan/
    // ribuan hari) sebelum batas atas MAX_INTERVAL_DAYS/MAX_EASE ditambahkan.
    var changed = false;
    Object.keys(srsState).forEach(function (id) {
      var s = srsState[id];
      if (!s) return;
      if (s.ease > MAX_EASE) { s.ease = MAX_EASE; changed = true; }
      if (s.interval > MAX_INTERVAL_DAYS) {
        s.interval = MAX_INTERVAL_DAYS;
        if (s.lastReview) s.due = s.lastReview + MAX_INTERVAL_DAYS * DAY_MS;
        changed = true;
      }
    });
    if (changed) saveJSON(LS_SRS, srsState);
  })();
  var prefs = loadJSON(LS_PREFS, { showFuriganaFront: false, theme: "dark" });
  if (!prefs.theme) prefs.theme = "dark";
  document.documentElement.setAttribute("data-theme", prefs.theme);
  var streak = loadJSON(LS_STREAK, { lastDate: null, count: 0, longest: 0 });
  var reviewLog = loadJSON(LS_REVIEWLOG, {}); // { "YYYY-MM-DD": {again,hard,good,easy} }

  function persistSrs() { saveJSON(LS_SRS, srsState); }
  function persistPrefs() { saveJSON(LS_PREFS, prefs); }
  function persistStreak() { saveJSON(LS_STREAK, streak); }
  function persistReviewLog() {
    var cutoff = dateKey(new Date(Date.now() - REVIEWLOG_KEEP_DAYS * DAY_MS));
    Object.keys(reviewLog).forEach(function (k) { if (k < cutoff) delete reviewLog[k]; });
    saveJSON(LS_REVIEWLOG, reviewLog);
  }

  function dateKey(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function todayStr() { return dateKey(new Date()); }

  function logReview(rating) {
    var k = todayStr();
    if (!reviewLog[k]) reviewLog[k] = { again: 0, hard: 0, good: 0, easy: 0 };
    reviewLog[k][rating] = (reviewLog[k][rating] || 0) + 1;
    persistReviewLog();
  }

  function touchStreak() {
    var t = todayStr();
    if (streak.lastDate === t) return;
    var yStr = dateKey(new Date(Date.now() - DAY_MS));
    if (streak.lastDate === yStr) {
      streak.count += 1;
    } else {
      streak.count = 1;
    }
    if (streak.count > (streak.longest || 0)) streak.longest = streak.count;
    streak.lastDate = t;
    persistStreak();
  }

  /* ---------------- SRS scheduling (SM-2 sederhana) ---------------- */
  function getCardState(id) {
    return srsState[id] || { ease: 2.5, interval: 0, reps: 0, lapses: 0, due: 0, lastReview: 0 };
  }

  function isNew(id) {
    var s = srsState[id];
    return !s || !s.lastReview;
  }

  function isDue(id) {
    var s = srsState[id];
    if (!s || !s.lastReview) return false;
    return s.due <= Date.now();
  }

  function isMastered(id) {
    var s = srsState[id];
    return !!s && s.interval >= MASTER_INTERVAL_DAYS;
  }

  function computeNextState(prev, rating, now) {
    var s = { ease: prev.ease, interval: prev.interval, reps: prev.reps, lapses: prev.lapses };
    var dueMs;

    if (rating === "again") {
      s.lapses += 1;
      s.reps = 0;
      s.ease = Math.max(1.3, s.ease - 0.2);
      s.interval = 0;
      dueMs = 12 * 60 * 1000; // 12 menit lagi (relearning cepat)
    } else if (rating === "hard") {
      s.ease = Math.max(1.3, s.ease - 0.15);
      s.interval = s.interval <= 0 ? 1 : Math.min(MAX_INTERVAL_DAYS, Math.max(1, Math.round(s.interval * 1.2)));
      s.reps += 1;
      dueMs = s.interval * DAY_MS;
    } else if (rating === "good") {
      if (s.reps === 0) s.interval = 1;
      else if (s.reps === 1) s.interval = 6;
      else s.interval = Math.min(MAX_INTERVAL_DAYS, Math.round(Math.max(s.interval, 1) * s.ease));
      s.reps += 1;
      dueMs = s.interval * DAY_MS;
    } else { // easy
      if (s.reps === 0) s.interval = 4;
      else s.interval = Math.min(MAX_INTERVAL_DAYS, Math.round(Math.max(s.interval, 1) * s.ease * 1.3));
      s.ease = Math.min(MAX_EASE, s.ease + 0.15);
      s.reps += 1;
      dueMs = s.interval * DAY_MS;
    }

    s.due = now + dueMs;
    s.dueMs = dueMs;
    return s;
  }

  function schedule(id, rating) {
    var prev = getCardState(id);
    var now = Date.now();
    var next = computeNextState(prev, rating, now);
    next.lastReview = now;
    next.lastRating = rating;
    srsState[id] = next;
    persistSrs();
    touchStreak();
    logReview(rating);
    return next;
  }

  // Pratinjau jarak waktu tanpa mengubah state — untuk label di tombol nilai (persis seperti Anki)
  function previewIntervalMs(id, rating) {
    var prev = getCardState(id);
    return computeNextState(prev, rating, Date.now()).dueMs;
  }

  function formatInterval(ms) {
    var min = ms / 60000;
    if (min < 60) return Math.max(1, Math.round(min)) + "mnt";
    var hr = min / 60;
    if (hr < 24) return Math.round(hr) + "jam";
    var day = hr / 24;
    if (day < 30) return Math.round(day) + "hr";
    var month = day / 30;
    if (month < 12) return Math.round(month) + "bln";
    var year = month / 12;
    return (Math.round(year * 10) / 10) + "th";
  }

  /* ---------------- Deck stats ---------------- */
  function deckStats(bab) {
    var list = getDeck(bab);
    var total = list.length, newCount = 0, dueCount = 0, mastered = 0;
    var now = Date.now();
    var nextDueMs = null;
    for (var i = 0; i < list.length; i++) {
      var id = list[i].id;
      var s = srsState[id];
      if (isNew(id)) newCount++;
      else if (isDue(id)) dueCount++;
      else if (s && s.due) {
        var delta = s.due - now;
        if (nextDueMs === null || delta < nextDueMs) nextDueMs = delta;
      }
      if (isMastered(id)) mastered++;
    }
    return { total: total, newCount: newCount, dueCount: dueCount, mastered: mastered, nextDueMs: nextDueMs };
  }

  function globalDueCount() {
    var due = 0;
    ALL_DECK_KEYS.forEach(function (bab) { due += deckStats(bab).dueCount; });
    return due;
  }
  function globalNewCount() {
    var n = 0;
    ALL_DECK_KEYS.forEach(function (bab) { n += deckStats(bab).newCount; });
    return n;
  }
  function globalMasteredCount() {
    var n = 0;
    ALL_DECK_KEYS.forEach(function (bab) { n += deckStats(bab).mastered; });
    return n;
  }

  /* ---------------- Small render helpers ---------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function stripTags(s) {
    return String(s == null ? "" : s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  function escArti(s) {
    // escape untuk keamanan, tapi pertahankan <br> sebagai baris baru sungguhan
    var withBreaks = String(s == null ? "" : s).replace(/<br\s*\/?>/gi, "\u0001");
    return esc(withBreaks).replace(/\u0001/g, "<br>");
  }

  function ringSVG(percent, size, stroke, colorVar, trackVar) {
    size = size || 40;
    stroke = stroke || 4;
    var r = (size - stroke) / 2;
    var c = 2 * Math.PI * r;
    var offset = c * (1 - Math.max(0, Math.min(1, percent)));
    return (
      '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + " " + size + '">' +
      '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="' + (trackVar || "rgba(241,232,214,0.14)") + '" stroke-width="' + stroke + '"/>' +
      '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="' + (colorVar || "var(--matcha-light)") + '" stroke-width="' + stroke + '" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + offset + '" transform="rotate(-90 ' + size / 2 + " " + size / 2 + ')"/>' +
      "</svg>"
    );
  }

  function playIconSVG() {
    return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  }

  /* ---------------- View state ---------------- */
  var view = { name: "home" };
  var session = null; // { bab, queue: [ids], pos, initialTotal, results:{again,hard,good,easy}, flipped }

  function go(v) { view = v; render(); window.scrollTo({ top: 0, behavior: "instant" }); }

  /* ================= HOME VIEW ================= */
  function renderHome() {
    var due = globalDueCount();
    var newC = globalNewCount();
    var mastered = globalMasteredCount();
    var totalCards = Object.keys(CARD_BY_ID).length;
    var pct = totalCards ? mastered / totalCards : 0;

    var html = "";
    html += '<div class="topbar">';
    html += '  <div class="brand">';
    html += '    <div class="seal">皆</div>';
    html += '    <div><h1>Matcha no Nihongo<span class="sub">Kartu Kosakata &middot; Jilid I &amp; II</span></h1></div>';
    html += "  </div>";
    html += '  <div class="topbar-actions">';
    html += '    <button class="iconbtn" id="btn-theme" title="Ganti tema">' + themeIcon() + "</button>";
    html += '    <button class="iconbtn" id="btn-stats" title="Statistik belajar">' + statsIcon() + "</button>";
    html += '    <button class="iconbtn" id="btn-search" title="Cari kosakata">' + searchIcon() + "</button>";
    html += '    <button class="iconbtn" id="btn-reset" title="Reset progres belajar">' + resetIcon() + "</button>";
    html += '    <div class="streak-pill">🔥 <b>' + streak.count + "</b> hari beruntun</div>";
    html += "  </div>";
    html += "</div>";

    html += '<div class="hero">';
    html += '  <div class="hero-desk">';
    html += '    <p class="hero-eyebrow">Meja belajar &middot; ' + totalCards + " kosakata &middot; 50 bab</p>";
    html += '    <h2 class="hero-title">Buka buku, balik kartu, <em>bubuhkan cap</em> tiap kali ingat.</h2>';
    html += '    <button class="hero-cta" id="btn-start-due">';
    html += '      <span class="stamp-count">' + due + "</span>";
    html += '      <span class="label"><span class="k">Mulai Sesi Hari Ini</span><span class="d">' + due + " perlu diulang &middot; " + newC + " kosakata baru</span></span>";
    html += "    </button>";
    html += '    <p class="hero-note">Nilai jujur tiap kartu — jadwal ulang otomatis menyesuaikan.</p>';
    html += "  </div>";

    html += '  <div class="hero-side">';
    html += "    <h3>Progres keseluruhan</h3>";
    html += '    <div class="progress-row">';
    html += '      <div class="progress-ring">' + ringSVG(pct, 56, 6, "var(--matcha)") + "</div>";
    html += '      <div class="txt"><b>' + mastered + " / " + totalCards + "</b><span>kosakata sudah lancar</span></div>";
    html += "    </div>";
    html += '    <hr class="hairline"/>';
    html += '    <div class="progress-row"><div class="txt"><b>' + due + '</b><span>kartu jatuh tempo hari ini</span></div></div>';
    html += '    <hr class="hairline"/>';
    html += '    <div class="progress-row"><div class="txt"><b>' + newC + '</b><span>kosakata belum pernah dipelajari</span></div></div>';
    html += "  </div>";
    html += "</div>";

    html += renderBookSection("Jilid I", "上", BOOK1_RANGE);
    html += renderBookSection("Jilid II", "下", BOOK2_RANGE);
    html += renderExtraSection();

    html += '<div class="app-footer">By Matchaaugust / Watanabe Hodaka &middot; audio asli NHK / Shinmeikai &middot; @matchaaugust__</div>';

    root.innerHTML = html;

    document.getElementById("btn-start-due").addEventListener("click", function () {
      startMixedDueSession();
    });
    document.getElementById("btn-theme").addEventListener("click", function () {
      showThemePicker();
    });
    document.getElementById("btn-search").addEventListener("click", function () {
      go({ name: "search" });
    });
    document.getElementById("btn-stats").addEventListener("click", function () {
      go({ name: "stats" });
    });
    document.getElementById("btn-reset").addEventListener("click", function () {
      showConfirm({
        icon: "忘",
        title: "Reset semua progres?",
        message: "Jadwal pengulangan, status setiap kartu, riwayat statistik, dan streak harian akan dihapus permanen. Kosakata itu sendiri tidak terhapus — hanya progres belajarmu yang dimulai dari nol lagi.",
        confirmLabel: "Ya, Mulai dari Nol",
        danger: true,
        onConfirm: resetAllProgress
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll(".chapter-card"), function (el) {
      el.addEventListener("click", function () { openModeSheet(el.getAttribute("data-bab")); });
    });
  }

  function searchIcon() {
    return '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
  }

  function resetIcon() {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v5h5"/></svg>';
  }

  function statsIcon() {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10"/><path d="M12 20V4"/><path d="M20 20v-7"/></svg>';
  }

  function themeIcon() {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none"/></svg>';
  }

  /* ---------------- Themed confirm modal ---------------- */
  function showConfirm(opts) {
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML =
      '<div class="modal-box">' +
      '<div class="modal-seal">' + (opts.icon || "印") + "</div>" +
      "<h3>" + esc(opts.title) + "</h3>" +
      "<p>" + esc(opts.message) + "</p>" +
      '<div class="modal-actions">' +
      '<button class="modal-btn cancel" id="modal-cancel">Batal</button>' +
      '<button class="modal-btn ' + (opts.danger ? "danger" : "confirm") + '" id="modal-confirm">' + esc(opts.confirmLabel) + "</button>" +
      "</div></div>";
    document.body.appendChild(overlay);
    function close() { document.body.removeChild(overlay); }
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    document.getElementById("modal-cancel").addEventListener("click", close);
    document.getElementById("modal-confirm").addEventListener("click", function () {
      close();
      opts.onConfirm();
    });
  }

  function resetAllProgress() {
    srsState = {};
    streak = { lastDate: null, count: 0, longest: 0 };
    reviewLog = {};
    persistSrs();
    persistStreak();
    persistReviewLog();
    go({ name: "home" });
  }

  var THEME_INFO = {
    dark: { label: "Dark", desc: "Kota malam, bulan sabit & bintang", swatch: ["#12161f", "#3c5c8c", "#f1e8d6"] },
    light: { label: "Light", desc: "Pastel cerah, lembut di mata", swatch: ["#f8f0ea", "#7a93c9", "#7d5468"] },
    japanese: { label: "Japanese", desc: "Washi krem & gerbang torii sakura", swatch: ["#f7e4d9", "#c23b2a", "#a8503f"] }
  };

  function showThemePicker() {
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    var html = '<div class="modal-box theme-box">';
    html += '<div class="modal-seal">色</div>';
    html += "<h3>Pilih Tema</h3>";
    html += '<div class="theme-opts">';
    Object.keys(THEME_INFO).forEach(function (key) {
      var t = THEME_INFO[key];
      var active = prefs.theme === key ? " active" : "";
      html += '<button class="theme-opt' + active + '" data-theme-choice="' + key + '">';
      html += '  <span class="theme-swatch">';
      t.swatch.forEach(function (c) { html += '<i style="background:' + c + '"></i>'; });
      html += "  </span>";
      html += '  <span class="theme-name">' + t.label + "</span>";
      html += '  <span class="theme-desc">' + t.desc + "</span>";
      html += "</button>";
    });
    html += "</div>";
    html += '<button class="modal-btn cancel" id="theme-close" style="margin-top:14px;width:100%;">Tutup</button>';
    html += "</div>";
    overlay.innerHTML = html;
    document.body.appendChild(overlay);

    function close() { document.body.removeChild(overlay); }
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    document.getElementById("theme-close").addEventListener("click", close);
    Array.prototype.forEach.call(overlay.querySelectorAll(".theme-opt"), function (btn) {
      btn.addEventListener("click", function () {
        var choice = btn.getAttribute("data-theme-choice");
        prefs.theme = choice;
        persistPrefs();
        document.documentElement.setAttribute("data-theme", choice);
        Array.prototype.forEach.call(overlay.querySelectorAll(".theme-opt"), function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
      });
    });
  }

  function renderBookSection(title, roman, range) {
    var html = '<div class="book-section">';
    html += '  <div class="book-heading"><span class="roman">' + roman + '</span><h2>' + title + '</h2><span class="range">Bab ' + pad(range[0]) + '–' + pad(range[1]) + '</span></div>';
    html += '  <div class="chapter-grid">';
    for (var n = range[0]; n <= range[1]; n++) {
      var bab = pad(n);
      if (!MNN_DATA[bab]) continue;
      var st = deckStats(bab);
      var pct = st.total ? st.mastered / st.total : 0;
      var masteredClass = pct >= 0.999 ? " mastered" : "";
      html += '<button class="chapter-card' + masteredClass + '" data-bab="' + bab + '">';
      html += '  <div class="num">Bab ' + bab + "</div>";
      html += '  <div class="count">' + st.total + " kosakata</div>";
      if (st.dueCount === 0 && st.nextDueMs !== null && st.nextDueMs !== undefined) {
        html += '  <div class="next-due">berikutnya ' + formatInterval(st.nextDueMs) + " lagi</div>";
      }
      html += '  <div class="foot">';
      html += '    <div class="mini-ring">' + ringSVG(pct, 30, 4, pct >= 0.999 ? "var(--matcha-light)" : "var(--indigo-light)") + "</div>";
      if (st.dueCount > 0) html += '<span class="due-badge">' + st.dueCount + "</span>";
      html += "  </div>";
      html += "</button>";
    }
    html += "  </div>";
    html += "</div>";
    return html;
  }

  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  function renderExtraSection() {
    if (EXTRA_KEYS.length === 0) return "";
    var html = '<div class="book-section">';
    html += '  <div class="book-heading"><span class="roman">＋</span><h2>Kosakata Tambahan</h2><span class="range">Di luar 50 bab</span></div>';
    html += '  <div class="chapter-grid extra-grid">';
    EXTRA_KEYS.forEach(function (key) {
      var meta = EXTRA_META[key] || { label: key, icon: "字" };
      var st = deckStats(key);
      var pct = st.total ? st.mastered / st.total : 0;
      var masteredClass = pct >= 0.999 ? " mastered" : "";
      html += '<button class="chapter-card extra-card' + masteredClass + '" data-bab="' + key + '">';
      html += '  <div class="extra-icon">' + meta.icon + "</div>";
      html += '  <div class="num extra-num">' + esc(meta.label) + "</div>";
      html += '  <div class="count">' + st.total + " kosakata</div>";
      if (st.dueCount === 0 && st.nextDueMs !== null && st.nextDueMs !== undefined) {
        html += '  <div class="next-due">berikutnya ' + formatInterval(st.nextDueMs) + " lagi</div>";
      }
      html += '  <div class="foot">';
      html += '    <div class="mini-ring">' + ringSVG(pct, 30, 4, pct >= 0.999 ? "var(--matcha-light)" : "var(--indigo-light)") + "</div>";
      if (st.dueCount > 0) html += '<span class="due-badge">' + st.dueCount + "</span>";
      html += "  </div>";
      html += "</button>";
    });
    html += "  </div>";
    html += "</div>";
    return html;
  }

  /* ================= MODE SHEET ================= */
  function openModeSheet(bab) {
    var st = deckStats(bab);
    var allIds = getDeck(bab).map(function (c) { return c.id; });
    var html = "";
    html += '<div class="topbar">';
    html += '  <button class="iconbtn" id="btn-back">' + backIcon() + "</button>";
    html += '  <div class="study-title"><div class="b">' + esc(babLabel(bab)) + '</div><div class="p">' + st.total + " kosakata</div></div>";
    html += '  <div style="width:40px"></div>';
    html += "</div>";
    html += '<div class="mode-sheet">';
    html += "  <h3>Pilih mode belajar</h3>";
    html += '  <div class="opt" data-mode="due"><div><b>Perlu Diulang</b><span>Kartu yang jatuh tempo hari ini</span></div><div class="n">' + st.dueCount + "</div></div>";
    html += '  <div class="opt" data-mode="new"><div><b>Kosakata Baru</b><span>Belum pernah dipelajari</span></div><div class="n">' + st.newCount + "</div></div>";
    html += '  <div class="opt" data-mode="all"><div><b>Semua Kosakata Bab Ini</b><span>Latihan bebas, tidak memengaruhi jadwal jika sudah dikuasai</span></div><div class="n">' + st.total + "</div></div>";
    html += "</div>";
    root.innerHTML = html;

    document.getElementById("btn-back").addEventListener("click", function () { go({ name: "home" }); });
    Array.prototype.forEach.call(document.querySelectorAll(".mode-sheet .opt"), function (el) {
      el.addEventListener("click", function () {
        var mode = el.getAttribute("data-mode");
        var ids;
        if (mode === "due") ids = allIds.filter(isDue);
        else if (mode === "new") ids = allIds.filter(isNew);
        else ids = allIds.slice();
        if (ids.length === 0) {
          ids = allIds.slice();
          alert("Tidak ada kartu untuk mode ini. Menampilkan semua kosakata bab ini.");
        }
        beginSession(bab, ids);
      });
    });
  }

  function startMixedDueSession() {
    var ids = [];
    ALL_DECK_KEYS.forEach(function (bab) {
      getDeck(bab).forEach(function (c) { if (isDue(c.id)) ids.push(c.id); });
    });
    if (ids.length === 0) {
      ALL_DECK_KEYS.forEach(function (bab) {
        getDeck(bab).forEach(function (c) { if (isNew(c.id)) ids.push(c.id); });
      });
    }
    if (ids.length === 0) { alert("Tidak ada kartu jatuh tempo atau baru saat ini. Pilih sebuah bab untuk latihan bebas!"); return; }
    beginSession("campuran", ids);
  }

  function backIcon() {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
  }

  /* ================= STUDY SESSION ================= */
  function shuffleArray(arr) {
    // Fisher-Yates -- mengacak posisi kartu secara merata
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function beginSession(bab, ids) {
    shuffleArray(ids); // acak dulu urutannya...
    // ...baru urutkan menurut prioritas: due lebih dulu, lalu baru, lalu sisanya
    // (karena sort JS stabil, urutan acak di dalam tiap kelompok prioritas tetap terjaga)
    ids.sort(function (a, b) {
      var da = isDue(a) ? 0 : isNew(a) ? 1 : 2;
      var db = isDue(b) ? 0 : isNew(b) ? 1 : 2;
      return da - db;
    });
    session = {
      bab: bab,
      queue: ids.slice(),
      initialTotal: ids.length,
      pos: 0,
      results: { again: 0, hard: 0, good: 0, easy: 0 },
      flipped: false,
      currentAudio: null
    };
    go({ name: "study" });
  }

  function currentCard() {
    if (!session || session.queue.length === 0) return null;
    return CARD_BY_ID[session.queue[0]];
  }

  function renderStudy() {
    var card = currentCard();
    if (!card) { renderDone(); return; }

    var completed = session.initialTotal - session.queue.length;
    var pct = session.initialTotal ? completed / session.initialTotal : 0;

    var html = "";
    html += '<div class="study-topbar">';
    html += '  <button class="iconbtn" id="btn-exit">' + backIcon() + "</button>";
    html += '  <div class="study-title"><div class="b">' + esc(babLabel(card._bab)) + '</div><div class="p">' + (completed + 1) + " / " + session.initialTotal + "</div></div>";
    html += '  <div class="furigana-toggle">Furigana&nbsp;<div class="switch' + (prefs.showFuriganaFront ? " on" : "") + '" id="furigana-switch"><div class="knob"></div></div></div>';
    html += "</div>";
    html += '<div class="session-bar"><div class="fill" style="width:' + (pct * 100) + '%"></div></div>';

    html += '<div class="card-stage"><div class="flashcard' + (session.flipped ? " flipped" : "") + '" id="flashcard"><div class="flashcard-inner">';
    html += renderFrontFace(card);
    html += renderBackFace(card);
    html += '<div class="stamp-mark" id="stamp-mark"></div>';
    html += "</div></div></div>";

    html += '<div class="flip-hint-row" id="flip-row" style="' + (session.flipped ? "display:none" : "") + '"><button class="flip-hint-btn" id="btn-flip">Ketuk kartu atau tekan spasi untuk membalik</button></div>';

    html += '<div class="rate-row" id="rate-row" style="visibility:' + (session.flipped ? "visible" : "hidden") + '">';
    html += rateBtn("again", "忘", "Lupa", "1", session.flipped, formatInterval(previewIntervalMs(card.id, "again")));
    html += rateBtn("hard", "難", "Sulit", "2", session.flipped, formatInterval(previewIntervalMs(card.id, "hard")));
    html += rateBtn("good", "良", "Ingat", "3", session.flipped, formatInterval(previewIntervalMs(card.id, "good")));
    html += rateBtn("easy", "楽", "Mudah", "4", session.flipped, formatInterval(previewIntervalMs(card.id, "easy")));
    html += "</div>";

    root.innerHTML = html;

    document.getElementById("btn-exit").addEventListener("click", function () { session = null; go({ name: "home" }); });
    document.getElementById("furigana-switch").addEventListener("click", function () {
      prefs.showFuriganaFront = !prefs.showFuriganaFront;
      persistPrefs();
      renderStudy();
    });

    var flashcardEl = document.getElementById("flashcard");
    flashcardEl.addEventListener("click", function (e) {
      if (e.target.closest(".play-btn")) return;
      doFlip();
    });
    document.getElementById("btn-flip").addEventListener("click", function (e) { e.stopPropagation(); doFlip(); });

    Array.prototype.forEach.call(document.querySelectorAll(".play-btn"), function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        playAudioBtn(btn);
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll(".rate-btn"), function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!session.flipped) return;
        rate(btn.getAttribute("data-rating"));
      });
    });
  }

  function renderFrontFace(card) {
    var showFuri = prefs.showFuriganaFront && card.kanji;
    var html = '<div class="face front">';
    if (showFuri) {
      html += '<div class="b-furigana" style="margin-bottom:8px;">' + card.furigana_html + "</div>";
    }
    if (card.kanji) {
      html += '<div class="f-kanji">' + esc(card.kanji) + "</div>";
    } else {
      html += '<div class="f-hiragana-only">' + (card.hiragana || "") + "</div>";
    }
    html += '<div class="face-hint">' + esc(babLabel(card._bab)).toUpperCase() + "</div>";
    html += "</div>";
    return html;
  }

  function renderBackFace(card) {
    var html = '<div class="face back">';
    if (card.kanji) {
      html += '<div class="b-furigana">' + card.furigana_html + "</div>";
      html += '<div class="b-hiragana-small">' + (card.hiragana || "") + "</div>";
    } else {
      html += '<div class="f-hiragana-only" style="margin-bottom:14px;">' + (card.hiragana || "") + "</div>";
    }
    html += '<div class="b-divider"></div>';
    html += '<div class="b-arti">' + escArti(card.arti || "") + "</div>";
    if (card.pitch_html) {
      html += '<div class="b-pitch">' + card.pitch_html + "</div>";
    }
    if (card.audio && card.audio.length) {
      html += '<div class="b-audio">';
      card.audio.forEach(function (a, idx) {
        var pitchNum = extractPitchNum(a.label);
        var text = idx === 0 ? "Dengar" : ("Lafal " + (idx + 1) + (pitchNum !== null ? " &middot; [" + pitchNum + "]" : ""));
        html += '<button class="play-btn" data-audio-id="' + a.id + '" data-audio-ext="' + a.ext + '">' + playIconSVG() + "<span>" + text + "</span></button>";
      });
      html += "</div>";
    }
    html += "</div>";
    return html;
  }

  function extractPitchNum(label) {
    if (!label) return null;
    var parts = label.split("_");
    if (parts.length >= 3) {
      var n = parseInt(parts[parts.length - 2], 10);
      if (!isNaN(n)) return n;
    }
    return null;
  }

  function rateBtn(rating, kanji, label, key, enabled, intervalLabel) {
    return (
      '<button class="rate-btn ' + rating + '" data-rating="' + rating + '"' + (enabled ? "" : " disabled") + ">" +
      '<span class="kj">' + kanji + "</span><span>" + label + '</span><span class="ivl">' + esc(intervalLabel || "") + '</span><span class="key">' + key + "</span>" +
      "</button>"
    );
  }

  function doFlip() {
    if (session.flipped) return;
    session.flipped = true;
    document.getElementById("flashcard").classList.add("flipped");
    document.getElementById("flip-row").style.display = "none";
    var rateRow = document.getElementById("rate-row");
    rateRow.style.visibility = "visible";
    Array.prototype.forEach.call(rateRow.querySelectorAll(".rate-btn"), function (b) { b.disabled = false; });
  }

  function playAudioBtn(btn) {
    var id = btn.getAttribute("data-audio-id");
    var ext = btn.getAttribute("data-audio-ext");
    var src = "audio/" + id + ext;
    if (session.currentAudio) { session.currentAudio.pause(); }
    var audio = new Audio(src);
    session.currentAudio = audio;
    btn.classList.add("playing");
    audio.addEventListener("ended", function () { btn.classList.remove("playing"); });
    audio.play().catch(function () { btn.classList.remove("playing"); });
  }

  function rate(rating) {
    var card = currentCard();
    if (!card) return;

    var rateRow = document.getElementById("rate-row");
    if (rateRow) {
      Array.prototype.forEach.call(rateRow.querySelectorAll(".rate-btn"), function (b) { b.disabled = true; });
    }

    session.results[rating] = (session.results[rating] || 0) + 1;
    schedule(card.id, rating);

    // stamp animation
    var stampChar = { again: "忘", hard: "難", good: "良", easy: "楽" }[rating];
    var stampEl = document.getElementById("stamp-mark");
    stampEl.textContent = stampChar;
    stampEl.classList.add("show");

    session.queue.shift();
    if (rating === "again") {
      var reinsertAt = Math.min(3, session.queue.length);
      session.queue.splice(reinsertAt, 0, card.id);
    }
    session.flipped = false;

    setTimeout(function () {
      renderStudy();
    }, 420);
  }

  /* ================= DONE VIEW ================= */
  function renderDone() {
    var r = session ? session.results : { again: 0, hard: 0, good: 0, easy: 0 };
    var bab = session ? session.bab : "";
    var totalAnswered = r.again + r.hard + r.good + r.easy;
    session = null;

    var html = "";
    html += '<div class="done-view">';
    html += '<div class="done-stamp">済</div>';
    html += "<h2>Sesi selesai — kerja bagus!</h2>";
    html += "<p>" + esc(sessionLabel(bab)) + " &middot; " + totalAnswered + " kartu dinilai</p>";
    html += '<div class="done-stats">';
    html += '<div class="done-stat"><b style="color:var(--muted-accent)">' + r.again + '</b><span>Lupa</span></div>';
    html += '<div class="done-stat"><b style="color:var(--gold)">' + r.hard + '</b><span>Sulit</span></div>';
    html += '<div class="done-stat"><b style="color:var(--indigo)">' + r.good + '</b><span>Ingat</span></div>';
    html += '<div class="done-stat"><b style="color:var(--matcha)">' + r.easy + '</b><span>Mudah</span></div>';
    html += "</div>";
    html += '<button class="primary-btn" id="btn-home">Kembali ke Rak Buku</button>';
    html += "</div>";
    root.innerHTML = html;
    document.getElementById("btn-home").addEventListener("click", function () { go({ name: "home" }); });
  }

  /* ================= SEARCH VIEW ================= */
  var ALL_CARDS_FLAT = ALL_DECK_KEYS.reduce(function (acc, bab) {
    return acc.concat(getDeck(bab));
  }, []);

  function renderSearch() {
    var html = "";
    html += '<div class="study-topbar">';
    html += '  <button class="iconbtn" id="btn-back">' + backIcon() + "</button>";
    html += '  <div class="study-title"><div class="b">Cari Kosakata</div><div class="p">' + ALL_CARDS_FLAT.length + " total</div></div>";
    html += '  <div style="width:40px"></div>';
    html += "</div>";
    html += '<div class="search-wrap">';
    html += '  <input type="text" id="search-input" class="search-input" placeholder="Ketik kanji, hiragana, atau arti (mis. \'makan\', \'食\', \'tabemasu\')" autocomplete="off" />';
    html += '  <div class="search-list" id="search-list"></div>';
    html += "</div>";
    root.innerHTML = html;

    document.getElementById("btn-back").addEventListener("click", function () { go({ name: "home" }); });
    var input = document.getElementById("search-input");
    input.addEventListener("input", function () { renderSearchResults(input.value); });
    input.focus();
    renderSearchResults("");
  }

  function renderSearchResults(q) {
    var listEl = document.getElementById("search-list");
    if (!listEl) return;
    q = q.trim().toLowerCase();
    var results;
    if (!q) {
      results = [];
    } else {
      results = ALL_CARDS_FLAT.filter(function (c) {
        return (
          (c.kanji && stripTags(c.kanji).toLowerCase().indexOf(q) !== -1) ||
          (c.hiragana && stripTags(c.hiragana).toLowerCase().indexOf(q) !== -1) ||
          (c.arti && stripTags(c.arti).toLowerCase().indexOf(q) !== -1)
        );
      }).slice(0, 60);
    }

    if (!q) {
      listEl.innerHTML = '<div class="search-empty">Mulai ketik untuk mencari di seluruh 50 bab.</div>';
      return;
    }
    if (results.length === 0) {
      listEl.innerHTML = '<div class="search-empty">Tidak ditemukan kosakata yang cocok.</div>';
      return;
    }

    var html = "";
    results.forEach(function (c) {
      html += '<div class="search-row">';
      html += '  <div class="sr-word">';
      html += c.kanji ? esc(stripTags(c.kanji)) : esc(stripTags(c.hiragana));
      html += '  </div>';
      html += '  <div class="sr-mid"><div class="sr-hira">' + esc(stripTags(c.hiragana)) + '</div><div class="sr-arti">' + esc(stripTags(c.arti)) + "</div></div>";
      html += '  <div class="sr-bab">' + esc(babLabel(c._bab)) + "</div>";
      if (c.audio && c.audio.length) {
        html += '<button class="iconbtn sr-play" data-audio-id="' + c.audio[0].id + '" data-audio-ext="' + c.audio[0].ext + '">' + playIconSVG() + "</button>";
      }
      html += "</div>";
    });
    listEl.innerHTML = html;

    Array.prototype.forEach.call(listEl.querySelectorAll(".sr-play"), function (btn) {
      btn.addEventListener("click", function () { playAudioBtnSimple(btn); });
    });
  }

  var searchAudioEl = null;
  function playAudioBtnSimple(btn) {
    var id = btn.getAttribute("data-audio-id");
    var ext = btn.getAttribute("data-audio-ext");
    if (searchAudioEl) searchAudioEl.pause();
    searchAudioEl = new Audio("audio/" + id + ext);
    searchAudioEl.play().catch(function () {});
  }

  /* ================= STATS VIEW ================= */
  function globalDistribution() {
    var newC = 0, learning = 0, mastered = 0;
    ALL_DECK_KEYS.forEach(function (bab) {
      getDeck(bab).forEach(function (c) {
        if (isNew(c.id)) newC++;
        else if (isMastered(c.id)) mastered++;
        else learning++;
      });
    });
    return { newC: newC, learning: learning, mastered: mastered };
  }

  function reviewTotals() {
    var t = { again: 0, hard: 0, good: 0, easy: 0 };
    Object.keys(reviewLog).forEach(function (k) {
      var d = reviewLog[k];
      t.again += d.again || 0; t.hard += d.hard || 0; t.good += d.good || 0; t.easy += d.easy || 0;
    });
    return t;
  }

  var WEEKDAY_ID = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

  function last14Days() {
    var out = [];
    for (var i = 13; i >= 0; i--) {
      var d = new Date(Date.now() - i * DAY_MS);
      var k = dateKey(d);
      var counts = reviewLog[k] || { again: 0, hard: 0, good: 0, easy: 0 };
      out.push({
        key: k,
        label: WEEKDAY_ID[d.getDay()],
        again: counts.again || 0, hard: counts.hard || 0, good: counts.good || 0, easy: counts.easy || 0
      });
    }
    return out;
  }

  function reviewBarChartSVG(days) {
    var w = 700, h = 168, padBottom = 22, padTop = 8;
    var totals = days.map(function (d) { return d.again + d.hard + d.good + d.easy; });
    var maxVal = Math.max(1, Math.max.apply(null, totals));
    var gap = w / days.length;
    var barW = Math.min(30, gap * 0.55);
    var scale = (h - padBottom - padTop) / maxVal;
    var yBase = h - padBottom;
    var colors = { again: "var(--muted-accent)", hard: "var(--gold)", good: "var(--indigo)", easy: "var(--matcha)" };
    var svg = '<svg viewBox="0 0 ' + w + " " + h + '" width="100%" height="' + h + '" preserveAspectRatio="xMidYMid meet">';
    svg += '<line x1="0" y1="' + yBase + '" x2="' + w + '" y2="' + yBase + '" stroke="rgba(241,232,214,0.14)" stroke-width="1"/>';
    days.forEach(function (d, i) {
      var x = i * gap + (gap - barW) / 2;
      var yCursor = yBase;
      ["again", "hard", "good", "easy"].forEach(function (key) {
        var v = d[key];
        var segH = v * scale;
        if (segH > 0) {
          svg += '<rect x="' + x.toFixed(1) + '" y="' + (yCursor - segH).toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + segH.toFixed(1) + '" fill="' + colors[key] + '" rx="2"/>';
          yCursor -= segH;
        }
      });
      if (totals[i] === 0) {
        svg += '<rect x="' + x.toFixed(1) + '" y="' + (yBase - 2) + '" width="' + barW.toFixed(1) + '" height="2" fill="rgba(241,232,214,0.16)" rx="1"/>';
      }
      svg += '<text x="' + (x + barW / 2).toFixed(1) + '" y="' + (h - 6) + '" text-anchor="middle" font-size="9.5" fill="rgba(241,232,214,0.55)">' + esc(d.label) + "</text>";
    });
    svg += "</svg>";
    return svg;
  }

  function distributionBarSVG(dist) {
    var total = Math.max(1, dist.newC + dist.learning + dist.mastered);
    var segs = [
      { v: dist.newC, color: "var(--indigo-light)" },
      { v: dist.learning, color: "var(--gold)" },
      { v: dist.mastered, color: "var(--matcha)" }
    ];
    var w = 100, h = 14;
    var svg = '<svg viewBox="0 0 ' + w + " " + h + '" width="100%" height="' + h + '" preserveAspectRatio="none">';
    var x = 0;
    segs.forEach(function (s) {
      var sw = (s.v / total) * w;
      if (sw > 0) {
        svg += '<rect x="' + x.toFixed(2) + '" y="0" width="' + sw.toFixed(2) + '" height="' + h + '" fill="' + s.color + '"/>';
        x += sw;
      }
    });
    svg += "</svg>";
    return svg;
  }

  function progressBarRow(label, pct, count, total) {
    return (
      '<div class="pbar-row"><div class="pbar-top"><span>' + esc(label) + '</span><span>' + count + " / " + total + '</span></div>' +
      '<div class="pbar-track"><div class="pbar-fill" style="width:' + Math.round(pct * 100) + '%"></div></div></div>'
    );
  }

  function renderStats() {
    var totals = reviewTotals();
    var totalReviews = totals.again + totals.hard + totals.good + totals.easy;
    var accuracy = totalReviews ? Math.round(((totals.good + totals.easy) / totalReviews) * 100) : 0;
    var dist = globalDistribution();
    var totalCards = Object.keys(CARD_BY_ID).length;
    var days = last14Days();

    var html = "";
    html += '<div class="study-topbar">';
    html += '  <button class="iconbtn" id="btn-back">' + backIcon() + "</button>";
    html += '  <div class="study-title"><div class="b">Statistik Belajar</div><div class="p">' + totalReviews + " kartu telah direview</div></div>";
    html += '  <div style="width:40px"></div>';
    html += "</div>";

    html += '<div class="stats-wrap">';

    html += '<div class="stat-grid">';
    html += '  <div class="stat-tile"><b>' + streak.count + '</b><span>Streak sekarang</span></div>';
    html += '  <div class="stat-tile"><b>' + (streak.longest || 0) + '</b><span>Streak terpanjang</span></div>';
    html += '  <div class="stat-tile"><b>' + accuracy + '%</b><span>Akurasi jawaban</span></div>';
    html += '  <div class="stat-tile"><b>' + dist.mastered + '</b><span>Kosakata lancar</span></div>';
    html += "</div>";

    html += '<div class="stats-card">';
    html += "  <h3>Aktivitas 14 Hari Terakhir</h3>";
    html += reviewBarChartSVG(days);
    html += '  <div class="chart-legend">';
    html += '    <span><i style="background:var(--muted-accent)"></i>Lupa ' + totals.again + '</span>';
    html += '    <span><i style="background:var(--gold)"></i>Sulit ' + totals.hard + '</span>';
    html += '    <span><i style="background:var(--indigo)"></i>Ingat ' + totals.good + '</span>';
    html += '    <span><i style="background:var(--matcha)"></i>Mudah ' + totals.easy + '</span>';
    html += "  </div>";
    html += "</div>";

    html += '<div class="stats-card">';
    html += "  <h3>Sebaran Penguasaan (" + totalCards + " kosakata)</h3>";
    html += distributionBarSVG(dist);
    html += '  <div class="chart-legend">';
    html += '    <span><i style="background:var(--indigo-light)"></i>Baru ' + dist.newC + '</span>';
    html += '    <span><i style="background:var(--gold)"></i>Belajar ' + dist.learning + '</span>';
    html += '    <span><i style="background:var(--matcha)"></i>Lancar ' + dist.mastered + '</span>';
    html += "  </div>";
    html += "</div>";

    html += '<div class="stats-card">';
    html += "  <h3>Progres per Kelompok</h3>";
    var s1 = groupStats(BOOK1_RANGE), s2 = groupStats(BOOK2_RANGE);
    html += progressBarRow("Jilid I (Bab 01–25)", s1.total ? s1.mastered / s1.total : 0, s1.mastered, s1.total);
    html += progressBarRow("Jilid II (Bab 26–50)", s2.total ? s2.mastered / s2.total : 0, s2.mastered, s2.total);
    if (EXTRA_KEYS.length) {
      var s3 = { total: 0, mastered: 0 };
      EXTRA_KEYS.forEach(function (k) { var st = deckStats(k); s3.total += st.total; s3.mastered += st.mastered; });
      html += progressBarRow("Kosakata Tambahan", s3.total ? s3.mastered / s3.total : 0, s3.mastered, s3.total);
    }
    html += "</div>";

    html += "</div>";
    root.innerHTML = html;

    document.getElementById("btn-back").addEventListener("click", function () { go({ name: "home" }); });
  }

  function groupStats(range) {
    var total = 0, mastered = 0;
    for (var n = range[0]; n <= range[1]; n++) {
      var bab = pad(n);
      if (!MNN_DATA[bab]) continue;
      var st = deckStats(bab);
      total += st.total; mastered += st.mastered;
    }
    return { total: total, mastered: mastered };
  }

  /* ================= Router / render ================= */
  function render() {
    if (view.name === "home") renderHome();
    else if (view.name === "study") renderStudy();
    else if (view.name === "search") renderSearch();
    else if (view.name === "stats") renderStats();
    else renderHome();
  }

  /* ================= Keyboard shortcuts ================= */
  document.addEventListener("keydown", function (e) {
    if (view.name !== "study" || !session) return;
    if (e.code === "Space") {
      e.preventDefault();
      if (!session.flipped) { doFlip(); }
      else { rate("good"); }
      return;
    }
    if (session.flipped) {
      if (e.key === "1") rate("again");
      else if (e.key === "2") rate("hard");
      else if (e.key === "3") rate("good");
      else if (e.key === "4") rate("easy");
    }
    if (e.key === "Escape") { session = null; go({ name: "home" }); }
  });

  /* ================= Init ================= */
  render();
})();
