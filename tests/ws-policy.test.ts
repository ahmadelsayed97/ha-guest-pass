import { describe, expect, test } from "bun:test";
import { parseScope } from "../src/scope.ts";
import type { Session } from "../src/guest-auth.ts";
import { filterOutbound, inspectInbound, type InboundDecision } from "../src/ws-policy.ts";

const scope = parseScope({
  dashboards: ["lovelace-guest"],
  entities: { "light.kitchen": "control", "switch.pool": "control", "sensor.temp": "view", "lock.front": "view" },
});
const session: Session = { user: { id: "guest-7", name: "Ada" }, scope };
const sessionFor = (s: Session["scope"]): Session => ({ user: session.user, scope: s });

const inbound = (msg: unknown, kindOf: (id: number) => string | undefined = () => undefined): InboundDecision =>
  inspectInbound(msg, session, kindOf);

function expectDenied(decision: InboundDecision, id = 1) {
  expect(decision.action).toBe("reply");
  if (decision.action !== "reply") return;
  expect(decision.message).toMatchObject({ id, type: "result", success: false, error: { code: "unauthorized" } });
}

function expectUnknown(decision: InboundDecision, id = 1) {
  expect(decision.action).toBe("reply");
  if (decision.action !== "reply") return;
  expect(decision.message).toMatchObject({ id, type: "result", success: false, error: { code: "unknown_command" } });
}

function expectForwarded(decision: InboundDecision) {
  expect(decision.action).toBe("forward");
  if (decision.action !== "forward") throw new Error("not forwarded");
  return decision;
}

describe("inbound framing", () => {
  test.each([
    [null, "null"],
    ["get_states", "string"],
    [[{ id: 1, type: "get_states" }], "array"],
    [{ type: "get_states" }, "missing id"],
    [{ id: "1", type: "get_states" }, "string id"],
    [{ id: 1.5, type: "get_states" }, "fractional id"],
    [{ id: 0, type: "get_states" }, "zero id"],
    [{ id: -1, type: "get_states" }, "negative id"],
    [{ id: 1 }, "missing type"],
    [{ id: 1, type: 42 }, "non-string type"],
  ])("closes on malformed frame %p (%s)", (msg) => {
    expect(inbound(msg).action).toBe("close");
  });

  test("unlisted types are answered as unknown commands, never forwarded", () => {
    expectUnknown(inbound({ id: 1, type: "render_template", template: "{{ states }}" }));
    expectUnknown(inbound({ id: 1, type: "execute_script", sequence: [] }));
    expectUnknown(inbound({ id: 1, type: "auth/sign_path", path: "/api/camera_proxy/camera.x" }));
    expectUnknown(inbound({ id: 1, type: "history/history_during_period", entity_ids: ["sensor.temp"] }));
    expectUnknown(inbound({ id: 1, type: "logbook/get_events" }));
    expectUnknown(inbound({ id: 1, type: "config/entity_registry/update", entity_id: "light.kitchen" }));
    expectUnknown(inbound({ id: 1, type: "frontend/set_user_data", key: "x", value: 1 }));
    expectUnknown(inbound({ id: 1, type: "subscribe_trigger", trigger: {} }));
    expectUnknown(inbound({ id: 1, type: "media_source/browse_media" }));
    expectUnknown(inbound({ id: 1, type: "camera/stream", entity_id: "camera.x" }));
    expectUnknown(inbound({ id: 1, type: "search/related", item_type: "entity", item_id: "light.kitchen" }));
    expectUnknown(inbound({ id: 1, type: "recorder/info" }));
    expectUnknown(inbound({ id: 1, type: "GET_STATES" }));
    expectUnknown(inbound({ id: 1, type: "get_states " }));
    expectUnknown(inbound({ id: 1, type: "auth", access_token: "x" }));
  });
});

describe("plain forwards", () => {
  test.each(["ping", "get_states", "get_config", "get_services", "get_panels", "lovelace/resources", "frontend/get_themes"])(
    "%s is forwarded as a fresh message with only id and type",
    (type) => {
      const d = expectForwarded(inbound({ id: 7, type, extra: "junk" }));
      expect(d.message).toEqual({ id: 7, type });
      expect(d.kind).toBe(type);
    },
  );

  test("frontend/get_translations keeps its parameters", () => {
    const d = expectForwarded(inbound({ id: 1, type: "frontend/get_translations", language: "en", category: "state", integration: ["light"] }));
    expect(d.message).toEqual({ id: 1, type: "frontend/get_translations", language: "en", category: "state", integration: ["light"] });
  });

  test("unsubscribe_events forwards the subscription id", () => {
    const d = expectForwarded(inbound({ id: 9, type: "unsubscribe_events", subscription: 3 }));
    expect(d.message).toEqual({ id: 9, type: "unsubscribe_events", subscription: 3 });
  });
});

describe("local replies", () => {
  test("supported_features is answered, not forwarded", () => {
    const d = inbound({ id: 2, type: "supported_features", features: { coalesce_messages: 1 } });
    expect(d).toEqual({ action: "reply", message: { id: 2, type: "result", success: true, result: null } });
  });

  test("auth/current_user returns the session's guest as a non-admin", () => {
    expect(inbound({ id: 3, type: "auth/current_user" })).toEqual({
      action: "reply",
      message: {
        id: 3,
        type: "result",
        success: true,
        result: { id: "guest-7", name: "Ada", is_owner: false, is_admin: false, credentials: [], mfa_modules: [] },
      },
    });
  });

  test("frontend/get_user_data returns null", () => {
    expect(inbound({ id: 4, type: "frontend/get_user_data", key: "sidebar" })).toEqual({
      action: "reply",
      message: { id: 4, type: "result", success: true, result: { value: null } },
    });
  });

  test.each(["config/area_registry/list", "config/device_registry/list", "config/floor_registry/list", "config/label_registry/list"])(
    "%s returns an empty list",
    (type) => {
      expect(inbound({ id: 5, type })).toEqual({ action: "reply", message: { id: 5, type: "result", success: true, result: [] } });
    },
  );
});

describe("subscribe_entities", () => {
  test("entity_ids is overwritten with the scoped list", () => {
    const d = expectForwarded(inbound({ id: 1, type: "subscribe_entities", entity_ids: ["lock.back", "light.kitchen"] }));
    expect(d.message.type).toBe("subscribe_entities");
    expect((d.message.entity_ids as string[]).sort()).toEqual(["light.kitchen", "lock.front", "sensor.temp", "switch.pool"]);
  });

  test("a request without entity_ids still gets the scoped list", () => {
    const d = expectForwarded(inbound({ id: 1, type: "subscribe_entities" }));
    expect(d.message.entity_ids).toHaveLength(4);
  });
});

describe("subscribe_events", () => {
  test.each(["state_changed", "lovelace_updated", "panels_updated", "themes_updated", "core_config_updated"])("%s allowed", (event_type) => {
    const d = expectForwarded(inbound({ id: 1, type: "subscribe_events", event_type }));
    expect(d.message).toEqual({ id: 1, type: "subscribe_events", event_type });
  });

  test.each([[undefined], ["*"], [""], ["call_service"], ["automation_triggered"], ["STATE_CHANGED"], [["state_changed"]]])(
    "event_type %p denied",
    (event_type) => {
      expectDenied(inbound({ id: 1, type: "subscribe_events", event_type }));
    },
  );

  test.each([
    "service_registered",
    "service_removed",
    "repairs_issue_registry_updated",
    "component_loaded",
    "user_updated",
    "entity_registry_updated",
    "area_registry_updated",
    "device_registry_updated",
    "floor_registry_updated",
    "label_registry_updated",
  ])("%s is accepted locally as a silent subscription and never forwarded", (event_type) => {
    expect(inbound({ id: 4, type: "subscribe_events", event_type })).toEqual({
      action: "reply",
      message: { id: 4, type: "result", success: true, result: null },
      kind: "silent_subscription",
    });
  });

  test("unsubscribing a silent subscription is answered locally", () => {
    const kindOf = (id: number) => (id === 4 ? "silent_subscription" : undefined);
    expect(inbound({ id: 9, type: "unsubscribe_events", subscription: 4 }, kindOf)).toEqual({
      action: "reply",
      message: { id: 9, type: "result", success: true, result: null },
    });
  });

  test("unsubscribing a forwarded subscription is forwarded", () => {
    const kindOf = (id: number) => (id === 4 ? "subscribe_events" : undefined);
    const d = expectForwarded(inbound({ id: 9, type: "unsubscribe_events", subscription: 4 }, kindOf));
    expect(d.message).toEqual({ id: 9, type: "unsubscribe_events", subscription: 4 });
  });
});

describe("lovelace/config", () => {
  test("scoped dashboard forwarded", () => {
    const d = expectForwarded(inbound({ id: 1, type: "lovelace/config", url_path: "lovelace-guest", force: false }));
    expect(d.message).toEqual({ id: 1, type: "lovelace/config", url_path: "lovelace-guest", force: false });
  });

  test.each([[undefined], [null], ["lovelace"], ["lovelace-private"], ["lovelace-guest/"], [["lovelace-guest"]]])("url_path %p denied", (url_path) => {
    expectDenied(inbound({ id: 1, type: "lovelace/config", url_path }));
  });

  test("null url_path means the default dashboard and passes when lovelace is scoped", () => {
    const withDefault = parseScope({ dashboards: ["lovelace"], entities: {} });
    const d = inspectInbound({ id: 1, type: "lovelace/config", url_path: null }, sessionFor(withDefault), () => undefined);
    expect(d).toEqual({ action: "forward", kind: "lovelace/config", message: { id: 1, type: "lovelace/config", url_path: null } });
    expectDenied(inspectInbound({ id: 1, type: "lovelace/config", url_path: undefined }, sessionFor(withDefault), () => undefined));
  });
});

describe("call_service", () => {
  const call = (overrides: Record<string, unknown>) =>
    inbound({ id: 1, type: "call_service", domain: "light", service: "turn_on", target: { entity_id: "light.kitchen" }, ...overrides });

  test("controllable entity in target is forwarded normalised", () => {
    const d = expectForwarded(call({ service_data: { brightness: 50 } }));
    expect(d.message).toEqual({
      id: 1,
      type: "call_service",
      domain: "light",
      service: "turn_on",
      target: { entity_id: ["light.kitchen"] },
      service_data: { brightness: 50 },
    });
  });

  test("entity_id inside service_data is accepted and moved to target", () => {
    const d = expectForwarded(call({ target: undefined, service_data: { entity_id: "light.kitchen", brightness: 1 } }));
    expect(d.message.target).toEqual({ entity_id: ["light.kitchen"] });
    expect(d.message.service_data).toEqual({ brightness: 1 });
  });

  test("homeassistant.turn_off across domains is allowed for controllable entities", () => {
    const d = expectForwarded(
      call({ domain: "homeassistant", service: "turn_off", target: { entity_id: ["light.kitchen", "switch.pool"] } }),
    );
    expect(d.message.target).toEqual({ entity_id: ["light.kitchen", "switch.pool"] });
  });

  test.each([
    [{ target: { entity_id: "sensor.temp" } }, "view-only entity"],
    [{ domain: "lock", service: "unlock", target: { entity_id: "lock.front" } }, "view-only lock"],
    [{ target: { entity_id: "light.bedroom" } }, "unscoped entity"],
    [{ target: { entity_id: ["light.kitchen", "light.bedroom"] } }, "one unscoped among scoped"],
    [{ target: { entity_id: ["light.kitchen", "sensor.temp"] } }, "one view-only among controllable"],
    [{ target: {} }, "no entities"],
    [{ target: { entity_id: [] } }, "empty entity list"],
    [{ target: undefined }, "no target"],
    [{ target: { entity_id: "all" } }, "all"],
    [{ target: { entity_id: "light.kitchen, light.bedroom" } }, "comma separated"],
    [{ target: { entity_id: "light.kitchen", area_id: "kitchen" } }, "area target"],
    [{ target: { entity_id: "light.kitchen", device_id: "abc" } }, "device target"],
    [{ target: { entity_id: "light.kitchen", floor_id: "ground" } }, "floor target"],
    [{ target: { entity_id: "light.kitchen", label_id: "guest" } }, "label target"],
    [{ target: { area_id: "kitchen" } }, "area only"],
    [{ service_data: { area_id: "kitchen" } }, "area in service_data"],
    [{ service_data: { device_id: "abc" } }, "device in service_data"],
    [{ service_data: { entity_id: "light.bedroom" } }, "unscoped entity in service_data alongside target"],
    [{ domain: "switch", service: "turn_on" }, "domain mismatch"],
    [{ domain: "homeassistant", service: "restart" }, "homeassistant non-toggle service"],
    [{ domain: "homeassistant", service: "reload_all" }, "homeassistant reload"],
    [{ domain: "script", service: "turn_on", target: { entity_id: "light.kitchen" } }, "script domain on light"],
    [{ return_response: true }, "return_response"],
    [{ domain: "light; rm", service: "turn_on" }, "bad domain string"],
    [{ domain: 5, service: "turn_on" }, "non-string domain"],
    [{ service: undefined }, "missing service"],
    [{ target: { entity_id: 5 } }, "non-string entity"],
    [{ target: { entity_id: [null] } }, "null entity in list"],
    [{ target: { entity_id: { entity_id: "light.kitchen" } } }, "object entity"],
    [{ target: "light.kitchen" }, "target not object"],
  ])("denied: %p (%s)", (overrides) => {
    expectDenied(call(overrides));
  });

  test("service_data is copied without target keys and extra fields are dropped", () => {
    const d = expectForwarded(call({ service_data: { brightness: 5, entity_id: "light.kitchen" }, blocking: true, nonsense: 1 }));
    expect(d.message).not.toHaveProperty("blocking");
    expect(d.message).not.toHaveProperty("nonsense");
    expect(d.message).not.toHaveProperty("return_response");
    expect(d.message.service_data).toEqual({ brightness: 5 });
  });
});

describe("outbound results", () => {
  const kinds = new Map<number, string>();
  const out = (msg: unknown) => filterOutbound(msg, session, (id) => kinds.get(id));

  test("malformed frames are dropped", () => {
    expect(out(null)).toBeNull();
    expect(out([{ id: 1, type: "result" }])).toBeNull();
    expect(out({ type: "result" })).toBeNull();
    expect(out({ id: 1, type: "surprise" })).toBeNull();
  });

  test("results for unknown ids are dropped", () => {
    expect(out({ id: 999, type: "result", success: true, result: [{ entity_id: "light.bedroom" }] })).toBeNull();
  });

  test("pong passes", () => {
    kinds.set(1, "ping");
    expect(out({ id: 1, type: "pong" })).toEqual({ id: 1, type: "pong" });
  });

  test("get_states filtered to scope", () => {
    kinds.set(2, "get_states");
    const result = out({
      id: 2,
      type: "result",
      success: true,
      result: [
        { entity_id: "light.kitchen", state: "on" },
        { entity_id: "light.bedroom", state: "off" },
        { entity_id: "sensor.temp", state: "21" },
        { state: "no id" },
      ],
    });
    expect(result?.result).toEqual([
      { entity_id: "light.kitchen", state: "on" },
      { entity_id: "sensor.temp", state: "21" },
    ]);
  });

  test("get_config redacted", () => {
    kinds.set(3, "get_config");
    const result = out({ id: 3, type: "result", success: true, result: { latitude: 1, version: "x", components: ["frontend", "mqtt"] } });
    expect(result?.result).toEqual({ version: "x", components: ["frontend"] });
  });

  test("get_services reduced to scoped domains", () => {
    kinds.set(4, "get_services");
    const result = out({
      id: 4,
      type: "result",
      success: true,
      result: { light: { turn_on: {} }, lock: { unlock: {} }, camera: { snapshot: {} }, homeassistant: { restart: {} } },
    });
    expect(Object.keys(result?.result as object).sort()).toEqual(["light", "lock"]);
  });

  test("get_panels reduced to scoped lovelace dashboards", () => {
    kinds.set(5, "get_panels");
    const result = out({
      id: 5,
      type: "result",
      success: true,
      result: {
        lovelace: { component_name: "lovelace", url_path: "lovelace" },
        "lovelace-guest": { component_name: "lovelace", url_path: "lovelace-guest", title: "Guest" },
        config: { component_name: "config", url_path: "config" },
        "developer-tools": { component_name: "developer-tools", url_path: "developer-tools" },
        map: { component_name: "map", url_path: "map" },
      },
    });
    expect(result?.result).toEqual({ "lovelace-guest": { component_name: "lovelace", url_path: "lovelace-guest", title: "Guest" } });
  });

  test("lovelace/dashboards/list filtered", () => {
    kinds.set(6, "lovelace/dashboards/list");
    const result = out({
      id: 6,
      type: "result",
      success: true,
      result: [{ url_path: "lovelace-guest" }, { url_path: "lovelace-private" }, {}],
    });
    expect(result?.result).toEqual([{ url_path: "lovelace-guest" }]);
  });

  test("lovelace/config is filtered for the session's guest", () => {
    kinds.set(7, "lovelace/config");
    const forGuest = { type: "markdown", content: "hi", visibility: [{ condition: "user", users: ["guest-7"] }] };
    const result = out({
      id: 7,
      type: "result",
      success: true,
      result: {
        views: [
          { cards: [{ entity: "light.kitchen" }, { entity: "lock.back" }, { type: "markdown", visibility: [{ condition: "user", users: ["admin"] }] }, forGuest] },
        ],
      },
    });
    expect(result?.result).toEqual({ views: [{ cards: [{ entity: "light.kitchen" }, forGuest] }] });
  });

  test("entity registry display list filtered", () => {
    kinds.set(8, "config/entity_registry/list_for_display");
    const result = out({
      id: 8,
      type: "result",
      success: true,
      result: { entity_categories: { 0: "config" }, entities: [{ ei: "light.kitchen", ai: "k" }, { ei: "light.bedroom" }] },
    });
    expect(result?.result).toEqual({ entity_categories: { 0: "config" }, entities: [{ ei: "light.kitchen", ai: "k" }] });
  });

  test("entity registry list filtered", () => {
    kinds.set(9, "config/entity_registry/list");
    const result = out({ id: 9, type: "result", success: true, result: [{ entity_id: "light.kitchen" }, { entity_id: "light.bedroom" }] });
    expect(result?.result).toEqual([{ entity_id: "light.kitchen" }]);
  });

  test("call_service result has response stripped", () => {
    kinds.set(10, "call_service");
    const result = out({ id: 10, type: "result", success: true, result: { context: { id: "c" }, response: { secret: 1 } } });
    expect(result?.result).toEqual({ context: { id: "c" } });
  });

  test("error results pass through without leaking details", () => {
    kinds.set(11, "get_states");
    const result = out({ id: 11, type: "result", success: false, error: { code: "unknown_error", message: "trace /config/x.py" } });
    expect(result).toEqual({ id: 11, type: "result", success: false, error: { code: "unknown_error", message: "Request failed" } });
  });

  test("results for a kind without a filter rule are dropped", () => {
    kinds.set(12, "something/new");
    expect(out({ id: 12, type: "result", success: true, result: { any: 1 } })).toBeNull();
  });
});

describe("outbound events", () => {
  const kinds = new Map<number, string>([
    [1, "subscribe_entities"],
    [2, "subscribe_events"],
  ]);
  const out = (msg: unknown) => filterOutbound(msg, session, (id) => kinds.get(id));

  test("subscribe_entities add map filtered", () => {
    const result = out({
      id: 1,
      type: "event",
      event: { a: { "light.kitchen": { s: "on", a: {} }, "light.bedroom": { s: "off", a: {} } } },
    });
    expect(result?.event).toEqual({ a: { "light.kitchen": { s: "on", a: {} } } });
  });

  test("subscribe_entities change map filtered", () => {
    const result = out({ id: 1, type: "event", event: { c: { "sensor.temp": { "+": { s: "22" } }, "sensor.secret": { "+": { s: "x" } } } } });
    expect(result?.event).toEqual({ c: { "sensor.temp": { "+": { s: "22" } } } });
  });

  test("subscribe_entities remove list filtered", () => {
    const result = out({ id: 1, type: "event", event: { r: ["light.kitchen", "light.bedroom"] } });
    expect(result?.event).toEqual({ r: ["light.kitchen"] });
  });

  test("subscribe_entities event that becomes empty is dropped", () => {
    expect(out({ id: 1, type: "event", event: { a: { "light.bedroom": {} } } })).toBeNull();
    expect(out({ id: 1, type: "event", event: { c: { "light.bedroom": {} } } })).toBeNull();
    expect(out({ id: 1, type: "event", event: { r: ["light.bedroom"] } })).toBeNull();
  });

  test("subscribe_entities event with unknown keys is dropped", () => {
    expect(out({ id: 1, type: "event", event: { a: {}, x: { "light.bedroom": {} } } })).toBeNull();
  });

  test("state_changed for scoped entity passes, unscoped dropped", () => {
    const scoped = {
      id: 2,
      type: "event",
      event: { event_type: "state_changed", data: { entity_id: "light.kitchen", new_state: { state: "on" } }, origin: "LOCAL", time_fired: "t", context: {} },
    };
    expect(out(scoped)).toEqual(scoped);
    expect(out({ ...scoped, event: { ...scoped.event, data: { entity_id: "light.bedroom" } } })).toBeNull();
    expect(out({ ...scoped, event: { ...scoped.event, data: {} } })).toBeNull();
  });

  test("core_config_updated event data is redacted", () => {
    const result = out({ id: 2, type: "event", event: { event_type: "core_config_updated", data: { latitude: 1, version: "v" } } });
    expect(result?.event).toEqual({ event_type: "core_config_updated", data: { version: "v" } });
  });

  test("lovelace_updated for unscoped dashboard dropped", () => {
    const ok = { id: 2, type: "event", event: { event_type: "lovelace_updated", data: { url_path: "lovelace-guest", mode: "storage" } } };
    expect(out(ok)).toEqual(ok);
    expect(out({ ...ok, event: { ...ok.event, data: { url_path: "lovelace-private" } } })).toBeNull();
    expect(out({ ...ok, event: { ...ok.event, data: { url_path: null } } })).toBeNull();
  });

  test("lovelace_updated with null url_path passes only when lovelace is scoped", () => {
    const withDefault = parseScope({ dashboards: ["lovelace"], entities: {} });
    const msg = { id: 2, type: "event", event: { event_type: "lovelace_updated", data: { url_path: null } } };
    expect(filterOutbound(msg, sessionFor(withDefault), () => "subscribe_events")).toEqual(msg);
  });

  test("events on silent subscriptions are dropped even when HA sends them", () => {
    expect(filterOutbound({ id: 4, type: "event", event: { event_type: "state_changed", data: { entity_id: "light.kitchen" } } }, session, () => "silent_subscription")).toBeNull();
  });

  test("panels_updated and themes_updated pass", () => {
    const panels = { id: 2, type: "event", event: { event_type: "panels_updated", data: {} } };
    expect(out(panels)).toEqual(panels);
    const themes = { id: 2, type: "event", event: { event_type: "themes_updated", data: { themes: {} } } };
    expect(out(themes)).toEqual(themes);
  });

  test("events of other types are dropped even on a valid subscription", () => {
    expect(out({ id: 2, type: "event", event: { event_type: "call_service", data: {} } })).toBeNull();
    expect(out({ id: 2, type: "event", event: { event_type: "entity_registry_updated", data: {} } })).toBeNull();
  });

  test("events on ids that are not subscriptions are dropped", () => {
    expect(out({ id: 50, type: "event", event: { event_type: "state_changed", data: { entity_id: "light.kitchen" } } })).toBeNull();
  });
});
