// UniNotepad 랜딩 페이지 공용 스크립트.
// index.html(영어)과 ko.html(한국어)이 이 파일 하나를 공유한다. 본문 문구는
// 각 HTML에 있고, 여기에는 JS가 만들어 내는 문구만 사전(T)으로 들어 있다.
// 고칠 때는 두 HTML의 ?v= 숫자를 함께 올릴 것 — Vercel 엣지가 자산을 캐시한다.
//
// <head>에서 defer로 불린다. DOM은 완성된 뒤에 실행되지만 첫 페인트보다는
// 늦으므로, 언어 리다이렉트 가드만은 각 HTML의 <head> 인라인에 남아 있다.

(function () {
  "use strict";

  var LANG = document.documentElement.lang === "ko" ? "ko" : "en";
  var LANG_KEY = "uninotepad-lang";

  var T = {
    en: {
      recommended: "Recommended",
      copy: "Copy",
      copied: "Copied!",
      selected: "Selected",
      shot: function (n) { return "Screenshot " + n; },
      hero: {
        mac: { href: "/download/mac-arm", label: "Download for macOS (Apple Silicon)" },
        windows: { href: "/download/windows", label: "Download for Windows (.msi)" },
        linux: { href: "/download/linux-appimage", label: "Download for Linux (.AppImage)" },
      },
    },
    ko: {
      recommended: "추천",
      copy: "복사",
      copied: "복사됨!",
      selected: "선택됨",
      shot: function (n) { return "화면 " + n; },
      hero: {
        mac: { href: "/download/mac-arm", label: "macOS용 내려받기 (Apple Silicon)" },
        windows: { href: "/download/windows", label: "Windows용 내려받기 (.msi)" },
        linux: { href: "/download/linux-appimage", label: "Linux용 내려받기 (.AppImage)" },
      },
    },
  }[LANG];

  function storedLang() {
    try { return localStorage.getItem(LANG_KEY); } catch (e) { return null; }
  }

  // ---- 언어 전환 -------------------------------------------------------
  // 스위처와 안내 줄 모두 [data-lang]을 달고 있어 이동/해시는 한 곳에서 처리한다.
  // 선택은 여기서만 기록된다 — 그래서 첫 방문자는 항상 기본 언어(영어)를 본다.
  (function () {
    var links = document.querySelectorAll("[data-lang]");
    // 기억되는 것은 스위처(EN/한국어) 클릭뿐이다. 안내 줄("이 페이지를 한국어로
    // 보기")은 이번 한 번만 넘어가는 링크다 — 그 한 번의 클릭으로 이후 모든 방문이
    // /ko로 튕기면, 영어 URL을 직접 열어도 되돌아오지 않아 고장으로 읽힌다.
    var switcher = document.querySelectorAll(".lang-switch [data-lang]");

    function syncHash() {
      for (var i = 0; i < links.length; i++) {
        var base = links[i].getAttribute("href").split("#")[0];
        // #download에서 언어를 바꾸면 상대 페이지의 같은 섹션으로 이어진다.
        links[i].setAttribute("href", base + location.hash);
      }
    }
    syncHash();
    window.addEventListener("hashchange", syncHash);

    for (var i = 0; i < switcher.length; i++) {
      switcher[i].addEventListener("click", function () {
        try { localStorage.setItem(LANG_KEY, this.getAttribute("data-lang")); } catch (e) {}
      });
    }

    // 한국어 브라우저 방문자에게만 한 줄 안내 (영어 페이지에만 존재).
    // 이미 언어를 고른 사람에게는 띄우지 않는다 — 그 선택이 곧 대답이다.
    var nudge = document.getElementById("langNudge");
    if (!nudge || storedLang()) return;
    var list = navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || ""];
    for (var j = 0; j < list.length; j++) {
      if (String(list[j]).toLowerCase().indexOf("ko") === 0) { nudge.hidden = false; return; }
    }
  })();

  // ---- 방문 OS 추정 + 최신 버전 ----------------------------------------
  // (1) 해당 다운로드 카드를 강조하고 (2) 히어로 버튼을 그 OS로 연결.
  // macOS의 Apple Silicon/Intel 구분은 브라우저로 불가능하므로 Apple Silicon을 기본 추천.
  (function () {
    function detectOS() {
      var ua = navigator.userAgent || "";
      var p = navigator.platform || "";
      if (/Mac/i.test(p) || /Mac OS X/i.test(ua)) return "mac";
      if (/Win/i.test(p) || /Windows/i.test(ua)) return "windows";
      if (/Linux|X11/i.test(p) || /Linux/i.test(ua)) return "linux";
      return null;
    }
    var os = detectOS();
    var hero = document.getElementById("heroDownload");
    if (os && T.hero[os] && hero) {
      hero.setAttribute("href", T.hero[os].href);
      hero.textContent = T.hero[os].label;
      var card = document.querySelector('.dl-card[data-os="' + os + '"]');
      if (card) {
        card.classList.add("recommended");
        var tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = T.recommended;
        card.querySelector("h3").appendChild(tag);
      }
    }

    // macOS 방문자에게는 첫 실행 안내를 히어로에서부터 알리고 카드도 강조.
    if (os === "mac") {
      var hint = document.getElementById("macHint");
      if (hint) hint.hidden = false;
      var guide = document.getElementById("macos-first-run");
      if (guide) guide.classList.add("for-you");
    }

    // 최신 버전 표시 (실패해도 조용히 넘어감 — 기본 문구 유지).
    fetch("https://api.github.com/repos/ilphs/UniNotepad/releases/latest")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.tag_name) {
          var els = document.querySelectorAll("[data-version]");
          for (var i = 0; i < els.length; i++) els[i].textContent = d.tag_name;
        }
      })
      .catch(function () {});
  })();

  // ---- xattr 명령 복사 버튼 --------------------------------------------
  // 손으로 옮겨 적다 틀리는 것이 가장 흔한 실패 원인이다.
  // 클립보드 API가 막힌 환경(비-HTTPS 등)에서는 명령 전체를 선택해 주는 것으로 대체.
  (function () {
    var btns = document.querySelectorAll(".copy-btn");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
        var btn = this;
        var code = document.querySelector(btn.getAttribute("data-copy"));
        if (!code) return;
        function done(label) {
          btn.textContent = label;
          setTimeout(function () { btn.textContent = T.copy; }, 1600);
        }
        function selectFallback() {
          var range = document.createRange();
          range.selectNodeContents(code);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          done(T.selected);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard
            .writeText(code.textContent)
            .then(function () { done(T.copied); })
            .catch(selectFallback);
        } else {
          selectFallback();
        }
      });
    }
  })();

  // ---- #faq-macos로 들어온 방문자에게는 해당 FAQ를 펼쳐 둔다 -------------
  (function () {
    function openIfTargeted() {
      if (location.hash !== "#faq-macos") return;
      var d = document.getElementById("faq-macos");
      if (d) d.open = true;
    }
    openIfTargeted();
    window.addEventListener("hashchange", openIfTargeted);
  })();

  // ---- 라이트박스 ------------------------------------------------------
  // 스크린샷 클릭 → 크게 보기. 열린 채로 화살표·키보드·썸네일·스와이프로
  // 다른 화면까지 넘겨볼 수 있다. Esc 닫기·포커스 트랩은 <dialog>가 기본 제공.
  (function () {
    var lightbox = document.getElementById("lightbox");
    var lbImg = document.getElementById("lightboxImg");
    var lbCap = document.getElementById("lightboxCaption");
    var lbCount = document.getElementById("lbCount");
    var lbThumbs = document.getElementById("lbThumbs");
    if (!lightbox) return;
    var all = Array.prototype.slice.call(
      document.querySelectorAll(".grid figure img, .hero .shot img")
    );
    // 히어로와 미리보기 섹션에 같은 스크린샷이 겹쳐 있다 — 넘겨볼 목록에서는 한 번만.
    var seen = {};
    var shots = all.filter(function (img) {
      if (seen[img.src]) return false;
      seen[img.src] = true;
      return true;
    });
    if (!shots.length) return;
    var current = 0;

    // 썸네일은 페이지의 스크린샷에서 그대로 생성 — 나중에 이미지를 늘려도 여기는 손댈 필요 없다.
    var thumbs = shots.map(function (img, i) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("aria-label", img.alt || T.shot(i + 1));
      var t = document.createElement("img");
      t.src = img.src;
      t.alt = "";
      t.loading = "lazy";
      btn.appendChild(t);
      btn.addEventListener("click", function () { show(i); });
      lbThumbs.appendChild(btn);
      return btn;
    });

    function preload(i) { new Image().src = shots[i].src; }

    function show(i) {
      var n = shots.length;
      current = (i % n + n) % n; // 양끝에서 순환
      var img = shots[current];
      lbImg.src = img.src;
      lbImg.alt = img.alt;
      var fig = img.closest("figure");
      var cap = fig && fig.querySelector("figcaption");
      if (cap) lbCap.innerHTML = cap.innerHTML;
      else lbCap.textContent = img.alt;
      lbCount.textContent = current + 1 + " / " + n;
      for (var j = 0; j < thumbs.length; j++) {
        thumbs[j].setAttribute("aria-current", j === current ? "true" : "false");
      }
      thumbs[current].scrollIntoView({ block: "nearest", inline: "center" });
      preload((current + 1) % n); // 넘길 때 흰 깜빡임 방지
      preload((current - 1 + n) % n);
    }

    // 클릭은 중복 포함 모든 이미지가 받고, 목록에서는 같은 화면의 첫 항목으로 연다.
    all.forEach(function (img) {
      img.addEventListener("click", function () {
        var i = 0;
        for (var j = 0; j < shots.length; j++) {
          if (shots[j].src === img.src) { i = j; break; }
        }
        show(i);
        lightbox.showModal();
      });
    });

    document.getElementById("lbPrev").addEventListener("click", function () { show(current - 1); });
    document.getElementById("lbNext").addEventListener("click", function () { show(current + 1); });
    lightbox.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") { e.preventDefault(); show(current - 1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); show(current + 1); }
    });

    // 모바일 스와이프. 스와이프 뒤 따라오는 click이 라이트박스를 닫지 않도록 한 번 흘려보낸다.
    var touchX = null;
    var swiped = false;
    lbImg.addEventListener("touchstart", function (e) {
      touchX = e.changedTouches[0].clientX;
    }, { passive: true });
    lbImg.addEventListener("touchend", function (e) {
      if (touchX === null) return;
      var dx = e.changedTouches[0].clientX - touchX;
      touchX = null;
      if (Math.abs(dx) > 40) { swiped = true; show(current + (dx < 0 ? 1 : -1)); }
    }, { passive: true });

    // 배경이나 본 이미지를 눌렀을 때만 닫는다 — 화살표·썸네일 클릭까지 닫히면 안 되므로.
    lightbox.addEventListener("click", function (e) {
      if (swiped) { swiped = false; return; }
      if (e.target === lightbox || e.target === lbImg) lightbox.close();
    });
  })();
})();
