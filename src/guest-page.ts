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
(function () {
  var token = location.hash.replace(/^#/, "");
  if (!token) {
    document.getElementById("msg").textContent = "This guest link is missing its access code.";
    return;
  }
  var expiresIn = 1800;
  var tokens = {
    hassUrl: location.origin,
    clientId: location.origin + "/",
    access_token: token,
    refresh_token: token,
    expires_in: expiresIn,
    expires: Date.now() + expiresIn * 1000
  };
  try {
    localStorage.setItem("hassTokens", JSON.stringify(tokens));
  } catch (e) {
    document.getElementById("msg").textContent = "Browser storage is unavailable; cannot sign in.";
    return;
  }
  history.replaceState(null, "", "/guest");
  location.replace("/");
})();
</script>
</body>
</html>`;
