export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Guest access</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; margin: 0; background: #111; color: #eee; }
  main { max-width: 900px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 1.4rem; margin: 0 0 24px; }
  h2 { font-size: 1.1rem; margin: 32px 0 12px; }
  section { background: #1b1b1b; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  label { display: block; margin: 10px 0 4px; font-size: .9rem; color: #bbb; }
  input, select, textarea, button { font: inherit; }
  input[type=text], input[type=password], select, textarea { width: 100%; box-sizing: border-box; padding: 8px; border-radius: 6px; border: 1px solid #333; background: #0d0d0d; color: #eee; }
  textarea { min-height: 80px; font-family: ui-monospace, monospace; }
  button { padding: 8px 14px; border-radius: 6px; border: 0; background: #2d7ff9; color: #fff; cursor: pointer; margin-right: 8px; margin-top: 12px; }
  button.secondary { background: #333; }
  button.danger { background: #a33; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  td, th { text-align: left; padding: 8px 6px; border-bottom: 1px solid #2a2a2a; vertical-align: top; }
  .row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid #2a2a2a; }
  .row:last-child { border-bottom: 0; }
  .pill { display: inline-flex; gap: 2px; }
  .pill label { margin: 0; }
  .pill input { display: none; }
  .pill span { padding: 4px 10px; background: #222; color: #aaa; cursor: pointer; font-size: .85rem; }
  .pill label:first-child span { border-radius: 6px 0 0 6px; }
  .pill label:last-child span { border-radius: 0 6px 6px 0; }
  .pill input:checked + span { background: #2d7ff9; color: #fff; }
  .muted { color: #888; font-size: .85rem; }
  .error { color: #f77; margin-top: 8px; }
  pre { background: #0d0d0d; padding: 12px; border-radius: 6px; overflow: auto; font-size: .85rem; max-height: 320px; }
  #qr svg { width: 220px; height: 220px; background: #fff; padding: 8px; border-radius: 8px; }
  code { word-break: break-all; }
  .hidden { display: none; }
</style>
</head>
<body>
<main>
  <h1>Guest access</h1>

  <section id="login">
    <label for="secret">Admin secret</label>
    <input id="secret" type="password" autocomplete="current-password">
    <button id="loginBtn">Continue</button>
    <div id="loginError" class="error"></div>
  </section>

  <div id="app" class="hidden">
    <section>
      <h2 style="margin-top:0">New guest</h2>
      <label for="name">Name</label>
      <input id="name" type="text" maxlength="64" placeholder="Who is this for?">
      <label for="duration">Access lasts</label>
      <select id="duration">
        <option value="60">1 hour</option>
        <option value="180">3 hours</option>
        <option value="720">12 hours</option>
        <option value="1440" selected>1 day</option>
        <option value="4320">3 days</option>
        <option value="10080">1 week</option>
        <option value="43200">30 days</option>
      </select>
      <label>Dashboards</label>
      <div id="dashboards"></div>
      <label>Areas</label>
      <div id="areas"></div>
      <label for="overrides">Entity overrides, one per line: <code>light.hallway view</code>, <code>lock.front control</code>, <code>switch.heater none</code></label>
      <textarea id="overrides" list="entityList"></textarea>
      <datalist id="entityList"></datalist>
      <button id="previewBtn" class="secondary">Preview</button>
      <button id="createBtn">Create link</button>
      <div id="formError" class="error"></div>
      <pre id="preview" class="hidden"></pre>
    </section>

    <section id="result" class="hidden">
      <h2 style="margin-top:0">Link for <span id="resultName"></span></h2>
      <p class="muted">Anyone with this link has the access above until it expires. Send it directly.</p>
      <p><code id="link"></code></p>
      <button id="copyBtn" class="secondary">Copy link</button>
      <div id="qr"></div>
    </section>

    <section>
      <h2 style="margin-top:0">Guests</h2>
      <table><thead><tr><th>Name</th><th>Access</th><th>Expires</th><th></th></tr></thead><tbody id="guests"></tbody></table>
    </section>
  </div>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var secret = sessionStorage.getItem("adminSecret") || "";
  var options = null;

  function api(method, path, body) {
    return fetch("/admin/api" + path, {
      method: method,
      headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (res) {
      return res.json().then(function (data) {
        if (res.status === 401) { logout(); throw new Error("Wrong admin secret"); }
        if (!res.ok) throw new Error(data.error || ("Request failed (" + res.status + ")"));
        return data;
      });
    });
  }

  function logout() {
    secret = "";
    sessionStorage.removeItem("adminSecret");
    $("app").classList.add("hidden");
    $("login").classList.remove("hidden");
  }

  function esc(text) { return String(text).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function pill(name, values, checked) {
    return '<span class="pill">' + values.map(function (v) {
      return '<label><input type="radio" name="' + esc(name) + '" value="' + v + '"' + (v === checked ? " checked" : "") + '><span>' + v + '</span></label>';
    }).join("") + '</span>';
  }

  function renderOptions() {
    $("dashboards").innerHTML = options.dashboards.map(function (d) {
      return '<div class="row"><span>' + esc(d) + '</span><input type="checkbox" name="dashboard" value="' + esc(d) + '"></div>';
    }).join("");
    $("areas").innerHTML = options.areas.map(function (a) {
      return '<div class="row"><span>' + esc(a.name) + ' <span class="muted">' + esc(a.id) + '</span></span>' + pill("area:" + a.id, ["none", "view", "control"], "none") + '</div>';
    }).join("");
    $("entityList").innerHTML = options.entities.map(function (e) { return '<option value="' + esc(e) + '">'; }).join("");
  }

  function definition() {
    var dashboards = Array.prototype.map.call(document.querySelectorAll('input[name=dashboard]:checked'), function (el) { return el.value; });
    var areas = {};
    options.areas.forEach(function (a) {
      var v = document.querySelector('input[name="area:' + a.id + '"]:checked').value;
      if (v !== "none") areas[a.id] = v;
    });
    var entities = {};
    $("overrides").value.split("\\n").forEach(function (line) {
      var parts = line.trim().split(/\\s+/);
      if (parts.length === 2) entities[parts[0]] = parts[1];
      else if (parts[0]) throw new Error("Override line must be: entity_id view|control|none");
    });
    return { dashboards: dashboards, areas: areas, entities: entities };
  }

  function showError(id, err) { $(id).textContent = err.message; }

  function renderGuests(guests) {
    var now = Date.now();
    $("guests").innerHTML = guests.map(function (g) {
      var state = g.revokedAt ? "revoked" : g.expiresAt < now ? "expired" : "active";
      var access = g.entityCount + " entities, " + g.dashboards.join(", ");
      var action = state === "active" ? '<button class="danger" data-revoke="' + esc(g.id) + '">Revoke</button>' : '<span class="muted">' + state + '</span>';
      return '<tr><td>' + esc(g.name) + '</td><td>' + esc(access) + '</td><td>' + new Date(g.expiresAt).toLocaleString() + '</td><td>' + action + '</td></tr>';
    }).join("") || '<tr><td colspan="4" class="muted">No guests yet.</td></tr>';
  }

  function loadGuests() { return api("GET", "/guests").then(renderGuests); }

  function start() {
    $("login").classList.add("hidden");
    $("app").classList.remove("hidden");
    return api("GET", "/options").then(function (o) { options = o; renderOptions(); return loadGuests(); }).catch(function (e) { showError("loginError", e); });
  }

  $("loginBtn").onclick = function () {
    secret = $("secret").value.trim();
    sessionStorage.setItem("adminSecret", secret);
    start();
  };

  $("previewBtn").onclick = function () {
    $("formError").textContent = "";
    try {
      api("POST", "/preview", definition()).then(function (r) {
        var lines = Object.keys(r.entities).sort().map(function (id) { return id + "  " + r.entities[id] + "  (" + r.sources[id] + ")"; });
        $("preview").textContent = (lines.join("\\n") || "Nothing granted.") + "\\n\\ndashboards: " + (r.dashboards.join(", ") || "none");
        $("preview").classList.remove("hidden");
      }).catch(function (e) { showError("formError", e); });
    } catch (e) { showError("formError", e); }
  };

  $("createBtn").onclick = function () {
    $("formError").textContent = "";
    try {
      var body = { name: $("name").value, durationMinutes: Number($("duration").value), definition: definition(), origin: location.origin };
      api("POST", "/guests", body).then(function (r) {
        $("resultName").textContent = r.guest.name;
        $("link").textContent = r.link;
        $("qr").innerHTML = r.qrSvg;
        $("result").classList.remove("hidden");
        $("copyBtn").onclick = function () { navigator.clipboard.writeText(r.link); };
        return loadGuests();
      }).catch(function (e) { showError("formError", e); });
    } catch (e) { showError("formError", e); }
  };

  $("guests").onclick = function (ev) {
    var id = ev.target.getAttribute("data-revoke");
    if (!id) return;
    api("DELETE", "/guests/" + id).then(loadGuests).catch(function (e) { alert(e.message); });
  };

  if (secret) start();
})();
</script>
</body>
</html>`;
