# Enforcement

Default deny. Anything not listed is answered by the proxy and never reaches HA.

A guest link carries a signed token (HS256, `SIGNING_KEY`) with the guest id,
a token id and an expiry. On every request the proxy verifies the signature
and expiry, loads the guest record, and checks it is not revoked and its own
expiry has not passed. That yields a session: guest id plus scope. Scope is
entity ids (`view` or `control`) and dashboard url paths, resolved from areas
and overrides when the guest is created and stored with the record. Tokens are
never stored. Open sockets are closed at expiry and on revoke.

Area `control` grants control to light, switch, fan, cover, media_player,
climate, humidifier and vacuum entities; everything else in the area gets
view. Locks, scenes, scripts, automations, buttons and input helpers need an
entity override. Disabled, hidden, config and diagnostic entities are skipped.
An override grants any level to any entity, or `none` to remove one.

The admin page and API under `/admin` need `ADMIN_SECRET` as a bearer token.
The admin secret is not a guest credential and vice versa.

Failed credential checks are counted per source address. Ten bad admin secrets
in five minutes, or twenty bad guest tokens in a minute, and that address gets
429 with `Retry-After` until the window ends; a WebSocket from it is closed
before the token is looked at. Only failures count and a success clears the
count, so a guest browsing normally never trips it. The admin page itself
still loads, so a locked out address can read why.

## WebSocket, guest to HA

Forwarded as-is: `ping`, `unsubscribe_events`, `lovelace/resources`,
`frontend/get_themes`, `frontend/get_translations`, `frontend/get_icons`.

Forwarded, result filtered to scope: `get_states`, `get_services`,
`get_panels`, `lovelace/dashboards/list`, `config/entity_registry/list`,
`config/entity_registry/list_for_display`, `get_config` (redacted),
`lovelace/config` (see below).

Rewritten: `subscribe_entities` gets `entity_ids` set to the scope.
`subscribe_events` only for `state_changed`, `lovelace_updated`,
`panels_updated`, `themes_updated`, `core_config_updated`. Registry and
service-registry subscriptions are accepted but never deliver.

Answered locally: `supported_features` (success, so HA never coalesces),
`auth/current_user` (guest, non-admin), `frontend/get_user_data` and
`frontend/subscribe_user_data` (null, the latter with one event so the
sidebar stops waiting), area/device/floor/label registry lists (empty).

Everything else: `unknown_command`. Listed types failing a check:
`unauthorized`.

`call_service` needs entity ids only (no area, device, floor, label targets),
all scoped `control`, service domain matching the entity domain or
`homeassistant.turn_on|turn_off|toggle`, and no `return_response`.

## WebSocket, HA to guest

`state_changed` and `lovelace_updated` dropped unless scoped.
`subscribe_entities` events filtered. Results filtered by the request type
they answer. `core_config_updated` redacted. Arrays, binary or unparseable
frames close the guest socket.

## HTTP

GET and HEAD only. Allowed: `/`, `/<scoped dashboard>/...`, HA static paths,
`/local/`, `/hacsfiles/`, and `/api/camera_proxy`, `/api/media_player_proxy`,
`/api/image/serve` for a scoped entity with a valid credential.
`/guest/session`, `/auth/token`, `/auth/authorize` (the access-ended page) and
`/admin` are handled by the proxy. Everything else is 404.

## Dashboard config

Cards, sections, views and elements mentioning an unscoped entity are removed.
Containers left with no entity are removed. `visibility` with a `user`
condition is enforced by the proxy: the guest id must be listed. Other
conditions pass through.

History, logbook, `auth/sign_path` and media browser are denied for now.
