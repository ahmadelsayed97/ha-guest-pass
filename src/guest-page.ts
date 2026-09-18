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

function notice(title: string, text: string): string {
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
<h1>${title}</h1>
<p>${text}</p>
</div>
<script>try { localStorage.removeItem("hassTokens"); } catch (e) {}</script>
</body>
</html>`;
}

export const ACCESS_ENDED_HTML = notice("This guest access has ended", "Ask your host for a new link.");
export const NOT_AVAILABLE_HTML = notice("This page is not available to guests", "If your access has ended, ask your host for a new link.");
