export const GUEST_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Guest access</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#111;color:#eee}</style>
</head>
<body>
<p id="msg">Signing you in…</p>
<script>
(async function () {
  var msg = document.getElementById("msg");
  var token = location.hash.replace(/^#/, "");
  if (!token) {
    msg.textContent = "This guest link is missing its access code.";
    return;
  }
  var res = await fetch("/guest/session", { headers: { authorization: "Bearer " + token } });
  if (!res.ok) {
    msg.textContent = "This guest link is not valid or has expired.";
    return;
  }
  var session = await res.json();
  var tokens = {
    hassUrl: location.origin,
    clientId: location.origin + "/",
    access_token: token,
    refresh_token: token,
    expires_in: Math.floor((session.expiresAt - Date.now()) / 1000),
    expires: session.expiresAt
  };
  try {
    localStorage.setItem("hassTokens", JSON.stringify(tokens));
    if (session.dashboards[0]) localStorage.setItem("defaultPanel", JSON.stringify(session.dashboards[0]));
  } catch (e) {
    msg.textContent = "Browser storage is unavailable; cannot sign in.";
    return;
  }
  history.replaceState(null, "", "/guest");
  location.replace("/");
})();
</script>
</body>
</html>`;

const ACCESS_ENDED = { title: "This guest access has ended", text: "Ask your host for a new link." };
const NOT_AVAILABLE = { title: "This page is not available to guests", text: "If your access has ended, ask your host for a new link." };

function notice(title: string, text: string, script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#111;color:#eee;text-align:center}</style>
</head>
<body>
<div>
<h1 id="title">${title}</h1>
<p id="text">${text}</p>
</div>
<script>${script}</script>
</body>
</html>`;
}

const FORGET_TOKENS = `try { localStorage.removeItem("hassTokens"); } catch (e) {}`;

const EXPLAIN_THEN_FORGET = `(async function () {
  var token = null;
  try { token = JSON.parse(localStorage.getItem("hassTokens")).access_token; } catch (e) {}
  if (token) {
    try {
      var res = await fetch("/guest/session", { headers: { authorization: "Bearer " + token } });
      if (res.status === 401) {
        document.title = ${JSON.stringify(ACCESS_ENDED.title)};
        document.getElementById("title").textContent = ${JSON.stringify(ACCESS_ENDED.title)};
        document.getElementById("text").textContent = ${JSON.stringify(ACCESS_ENDED.text)};
        ${FORGET_TOKENS}
      }
    } catch (e) {}
  }
})();`;

export const ACCESS_ENDED_HTML = notice(ACCESS_ENDED.title, ACCESS_ENDED.text, FORGET_TOKENS);
export const NOT_AVAILABLE_HTML = notice(NOT_AVAILABLE.title, NOT_AVAILABLE.text, EXPLAIN_THEN_FORGET);
