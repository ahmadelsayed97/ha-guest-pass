export const EXPIRY_SCRIPT_PATH = "/guest/expiry.js";

const SCRIPT_TAG = `<script src="${EXPIRY_SCRIPT_PATH}"></script>`;

const rewriter = new HTMLRewriter().on("body", {
  element(element) {
    element.append(SCRIPT_TAG, { html: true });
  },
});

export function withExpiryNotice(response: Response): Response {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("text/html") ? rewriter.transform(response) : response;
}

export const EXPIRY_SCRIPT = `(function () {
  var WARNING_MS = 600000;
  var CHECK_MS = 300000;
  var RETRY_MS = 10000;
  var expiresAt = 0;
  var banner = null;
  var ticker = null;

  function storedSession() {
    try {
      return JSON.parse(localStorage.getItem("hassTokens"));
    } catch (e) {
      return null;
    }
  }

  function endSession() {
    try {
      localStorage.removeItem("hassTokens");
    } catch (e) {}
    location.replace("/auth/authorize");
  }

  function remainingText(ms) {
    var seconds = Math.max(0, Math.round(ms / 1000));
    var minutes = Math.floor(seconds / 60);
    if (minutes > 0) return minutes + " min " + (seconds % 60) + " s";
    return seconds + " s";
  }

  function showBanner(ms) {
    if (!banner) {
      banner = document.createElement("div");
      banner.setAttribute("role", "status");
      banner.setAttribute("aria-live", "polite");
      banner.setAttribute(
        "style",
        "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:calc(100% - 32px);padding:10px 18px;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.3);background:#b71c1c;color:#fff;font:500 14px/1.4 system-ui,sans-serif"
      );
      document.body.appendChild(banner);
    }
    banner.textContent = "Guest access ends in " + remainingText(ms);
  }

  function countdown() {
    var remaining = expiresAt - Date.now();
    if (remaining <= 0) return endSession();
    showBanner(remaining);
  }

  function schedule() {
    var remaining = expiresAt - Date.now();
    if (remaining <= 0) return endSession();
    if (remaining > WARNING_MS) return setTimeout(check, Math.min(CHECK_MS, remaining - WARNING_MS));
    if (ticker) return;
    countdown();
    ticker = setInterval(countdown, 1000);
  }

  function check() {
    var session = storedSession();
    if (!session) return;
    fetch("/guest/session", { headers: { authorization: "Bearer " + session.access_token } })
      .then(function (res) {
        if (!res.ok) return endSession();
        return res.json().then(function (fresh) {
          expiresAt = fresh.expiresAt;
          schedule();
        });
      })
      .catch(function () {
        setTimeout(check, RETRY_MS);
      });
  }

  var stored = storedSession();
  if (stored && stored.expires) {
    expiresAt = stored.expires;
    schedule();
  }
  check();
})();
`;
