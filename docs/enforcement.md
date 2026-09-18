# Enforcement

Default deny. Anything not listed is answered by the proxy and never reaches HA.

A credential resolves to a session: guest id plus scope. Scope is entity ids
(`view` or `control`) and dashboard url paths. See `scope.example.json`.

Scopes are written as areas plus entity overrides (`guest-scope.example.json`)
and resolved against HA's registries by `bun run resolve`, which writes the
entity list the proxy loads. Nothing is re-resolved until you run it again.
Area `control` grants control to light, switch, fan, cover, media_player,
climate, humidifier and vacuum entities; everything else in the area gets
view. Locks, scenes, scripts, automations, buttons and input helpers need an
entity override. Disabled, hidden, config and diagnostic entities are skipped.
An override grants any level to any entity, or `none` to remove one.

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
`auth/current_user` (guest, non-admin), `frontend/get_user_data` (null),
area/device/floor/label registry lists (empty).

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
`/guest/session` and `/auth/token` are handled by the proxy. Everything else
is 404.

## Dashboard config

Cards, sections, views and elements mentioning an unscoped entity are removed.
Containers left with no entity are removed. `visibility` with a `user`
condition is enforced by the proxy: the guest id must be listed. Other
conditions pass through.

History, logbook, `auth/sign_path` and media browser are denied for now.
