# ha-guest-pass

## What this is

A LAN-only reverse proxy that gives Home Assistant guests scoped, temporary,
password-free access to specific dashboards and entities.

Home Assistant's dashboard "visibility" is UI concealment, not access control.
A hidden entity is still reachable through the REST API, the media browser,
direct URLs, or the browser inspector. HA has no per-entity access control and
no RBAC. This proxy provides the enforcement HA does not.

## Stack

Bun and TypeScript, no framework. The proxy speaks HA's WebSocket API, which
is JSON over a socket; holding many guest connections and filtering a busy
event stream is what a JS runtime's async I/O is good at. We are an external
client, not a custom component, so HA being Python is irrelevant.

Runtime dependencies are `jose` (HS256 JWT) and `qrcode`. Do not add more
without a reason that survives review.

## Security rules

This is a security tool. Weak enforcement is worse than none because it gives
a false sense of safety. Every decision goes through a security lens before a
convenience or speed lens.

1. **Deny by default.** Any request, message type, entity, endpoint or field
   not explicitly allowed for the guest's scope is rejected. Allowlist, never
   blocklist.
2. **Never trust the client.** Every entity id, service call, target, path and
   parameter is validated server-side against the scope before it is
   forwarded. Assume raw WebSocket frames and direct REST calls.
3. **The real HA token never reaches the guest.** Not in responses, not in
   client code, not in logs, not in error messages.
4. **Close every channel.** WebSocket filtering alone is not enough. REST,
   history, logbook, media browser, camera proxy, templates and config
   endpoints are each blocked or scoped. Unsure whether an endpoint can leak?
   Treat it as if it can.
5. **Fail closed.** Errors, ambiguity, unparseable messages, unknown types,
   expired tokens: deny. Never allow-on-error to keep the UI working.
6. **No security theater.** Nothing that only hides in the UI while the data
   stays reachable.
7. **Tokens are signed, scoped, expiring, revocable** and validated on every
   request. Vetted crypto only, nothing hand-rolled.
8. **LAN-only, enforced in code** by socket address. Never by headers the
   client controls.
9. **No secrets in the repo.** Environment or gitignored files only.
10. **Every rule has an adversarial test** that tries to get around it. A rule
    without one is not done.

If a secure approach is more work, do the more work. If unsure whether
something is safe, stop and flag it.

## Scope model

Areas are shortcuts that resolve to entities. Entity overrides sit on top, at
`view`, `control` or `none`. Area `control` only reaches operable domains
(light, switch, fan, cover, media_player, climate, humidifier, vacuum);
everything else in the area gets `view`. Scopes are resolved when a guest is
created and stored with the record: snapshot, not dynamic. A device added to
an area later is not granted to existing guests.

## Enforcement

`docs/enforcement.md` is the authoritative list of what is forwarded,
rewritten, answered locally or denied. Update it in the same commit as any
policy change.

## Conventions

- No code comments. Names carry the meaning; rationale goes in the README or
  `docs/`. Before finishing, `grep -rn "//\|/\*" src tests` should show only
  URL literals.
- Test first. Write the test, watch it fail, then implement. Security rules
  get tests that attempt the bypass.
- Tests use invented entity ids, never ids from a real installation.
- Commits: conventional commits, one line, imperative, no trailers.
- Prose in README and docs is plain and short. No status labels, no filler.
- Verify against a real Home Assistant before calling frontend-facing work
  done; the frontend's boot sequence has gates that unit tests do not model.
