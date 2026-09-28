# Enforcement

Default deny. Anything not listed here is answered by the proxy and never
reaches Home Assistant.

## Sessions

A guest link carries a signed token (HS256, `SIGNING_KEY`) holding the guest
id, a token id and an expiry. On every request the proxy verifies the
signature and expiry, loads the guest record, and checks that it is not
revoked and that the record's own expiry has not passed. The result is a
session: guest id plus scope. Tokens are never stored. Open sockets are closed
at expiry and on revoke.

## Scope

A scope is a set of entity ids, each `view` or `control`, plus the dashboard
paths the guest may open. It is resolved from areas and overrides when the
guest is created and stored with the record, so later changes to areas do not
reach existing guests.

Area `control` grants control to light, switch, fan, cover, media_player,
climate, humidifier and vacuum entities; everything else in the area gets
`view`. Locks, scenes, scripts, automations, buttons and input helpers need an
explicit override. Disabled, hidden, config and diagnostic entities are
skipped. An override grants any level to any entity, or `none` to remove one.

## Admin access

The admin page and API under `/admin` need `ADMIN_SECRET` as a bearer token
on the public port. The admin secret is not a guest credential and vice
versa.

As an add-on, the same page is also served through Home Assistant Ingress on
a second listener bound to the Supervisor-facing interface. That listener
accepts connections only from the Supervisor's address, reads the user id the
Supervisor attaches, and confirms with Home Assistant that the user is an
active administrator before serving anything. Those identity headers are
ignored on the public port, so a LAN client cannot claim to be an
administrator.

## Lockout

Failed credential checks are counted per source address. Ten bad admin
secrets in five minutes, or twenty bad guest tokens in a minute, and that
address gets 429 with `Retry-After` until the window ends; a WebSocket from it
is closed before the token is examined. Only failures count and a success
clears the count, so normal browsing never trips it. The admin page itself
still loads, so a locked-out address can read why.

## WebSocket, guest to Home Assistant

Forwarded as-is: `ping`, `unsubscribe_events`, `lovelace/resources`,
`frontend/get_themes`, `frontend/get_translations`, `frontend/get_icons`.

Forwarded with the result filtered to scope: `get_states`, `get_services`,
`get_panels`, `lovelace/dashboards/list`, `config/entity_registry/list` and
`config/entity_registry/list_for_display` (both also stripped of device, area
and label links, since guests get none of those registries), `get_config`
(redacted), `lovelace/config` (see Dashboards).

Rewritten before forwarding:

- `subscribe_entities` gets `entity_ids` replaced with the scope.
- `subscribe_events` only for `state_changed`, `lovelace_updated`,
  `panels_updated`, `themes_updated`, `core_config_updated`. Registry and
  service-registry subscriptions are accepted but never deliver.
- `history/stream` needs an explicit `entity_ids` list with every id scoped,
  a string `start_time`, and only the known optional fields. Each event has
  its `states` reduced to scope.
- `call_service` needs entity ids only (no area, device, floor or label
  targets), every one scoped `control`, a service domain matching the entity
  domain or `homeassistant.turn_on|turn_off|toggle`, and no `return_response`.

Answered locally: `supported_features` (success, so HA never coalesces
frames), `auth/current_user` (guest, non-admin), `frontend/get_user_data` and
`frontend/subscribe_user_data` (null, the latter with one event so the
sidebar stops waiting), area, device, floor and label registry lists (empty).

Everything else: `unknown_command`. A listed type that fails a check:
`unauthorized`.

## WebSocket, Home Assistant to guest

`state_changed` and `lovelace_updated` are dropped unless scoped.
`subscribe_entities` events are filtered. Results are filtered by the request
type they answer. `core_config_updated` is redacted. Arrays, binary frames or
unparseable frames close the guest socket.

## HTTP

GET and HEAD only. Allowed: `/`, `/<scoped dashboard>/...`, Home Assistant's
static paths, `/local/`, `/hacsfiles/`, and `/api/camera_proxy`,
`/api/media_player_proxy` and `/api/image/serve` for a scoped entity with a
valid credential. `/guest/session`, `/auth/token`, `/auth/authorize` (the
access-ended page), `/health` and `/admin` are handled by the proxy.
Everything else, including logbook, `auth/sign_path` and the media browser,
is 404.

## Dashboards

Cards, sections, views and elements mentioning an unscoped entity are
removed. Containers left with no entity are removed, and so is a heading or
other entity-less card whose following group of cards was removed entirely.
`visibility` with a `user` condition is enforced by the proxy: the guest id
must be listed. Other conditions pass through to the frontend.
