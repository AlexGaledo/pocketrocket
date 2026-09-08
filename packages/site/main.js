// PocketRocket site: no framework, no build step. Two jobs only:
// 1. fill in the download button with the latest Windows release
// 2. copy-to-clipboard for install command snippets

(function latestRelease() {
  var btn = document.getElementById("download-btn");
  var versionEl = document.getElementById("download-version");
  if (!btn) return;

  fetch("https://api.github.com/repos/AlexGaledo/pocketrocket/releases/latest")
    .then(function (res) {
      if (!res.ok) throw new Error("no release yet");
      return res.json();
    })
    .then(function (release) {
      var asset = (release.assets || []).find(function (a) {
        return /\.exe$/i.test(a.name);
      });
      if (asset) {
        btn.href = asset.browser_download_url;
        if (versionEl) versionEl.textContent = release.tag_name || "";
      }
      // else: keep the fallback link to the Releases page already in the href
    })
    .catch(function () {
      // graceful fallback: button already points at the Releases page
    });
})();

(function copyButtons() {
  var buttons = document.querySelectorAll(".copy-btn[data-copy]");
  buttons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy") || "";
      var done = function () {
        var original = btn.textContent;
        btn.classList.add("copied");
        btn.textContent = "Copied!";
        setTimeout(function () {
          btn.classList.remove("copied");
          btn.textContent = original;
        }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else {
        done();
      }
    });
  });
})();
