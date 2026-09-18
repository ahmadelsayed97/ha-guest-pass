import { describe, expect, test } from "bun:test";
import { resolveScope, type Registries } from "../src/resolve.ts";
import { parseScopeDefinition } from "../src/scope-definition.ts";

const registries: Registries = {
  areas: [
    { area_id: "living_room", name: "Living Room" },
    { area_id: "guest_bedroom", name: "Guest Bedroom" },
    { area_id: "garage", name: "Garage" },
  ],
  devices: [
    { id: "dev-tv", area_id: "living_room" },
    { id: "dev-hub", area_id: null },
    { id: "dev-garage", area_id: "garage" },
  ],
  entities: [
    { entity_id: "light.ceiling", area_id: "living_room", device_id: null, disabled_by: null, hidden_by: null, entity_category: null },
    { entity_id: "media_player.tv", area_id: null, device_id: "dev-tv", disabled_by: null, hidden_by: null, entity_category: null },
    { entity_id: "switch.tv_restart", area_id: null, device_id: "dev-tv", disabled_by: null, hidden_by: null, entity_category: "config" },
    { entity_id: "sensor.tv_signal", area_id: null, device_id: "dev-tv", disabled_by: null, hidden_by: null, entity_category: "diagnostic" },
    { entity_id: "light.living_room_old", area_id: "living_room", device_id: null, disabled_by: "user", hidden_by: null, entity_category: null },
    { entity_id: "light.living_room_hidden", area_id: "living_room", device_id: null, disabled_by: null, hidden_by: "user", entity_category: null },
    { entity_id: "sensor.bedroom_temp", area_id: "guest_bedroom", device_id: null, disabled_by: null, hidden_by: null, entity_category: null },
    { entity_id: "light.bedroom", area_id: "guest_bedroom", device_id: "dev-tv", disabled_by: null, hidden_by: null, entity_category: null },
    { entity_id: "cover.garage_door", area_id: null, device_id: "dev-garage", disabled_by: null, hidden_by: null, entity_category: null },
    { entity_id: "sensor.hub_uptime", area_id: null, device_id: "dev-hub", disabled_by: null, hidden_by: null, entity_category: null },
    { entity_id: "automation.goodnight", area_id: "living_room", device_id: null, disabled_by: null, hidden_by: null, entity_category: null },
    { entity_id: "scene.movie", area_id: "living_room", device_id: null, disabled_by: null, hidden_by: null, entity_category: null },
    { entity_id: "number.tv_sensitivity", area_id: "living_room", device_id: null, disabled_by: null, hidden_by: null, entity_category: null },
    { entity_id: "sensor.living_room_temp", area_id: "living_room", device_id: null, disabled_by: null, hidden_by: null, entity_category: null },
  ],
};

const resolve = (definition: unknown) => resolveScope(parseScopeDefinition(definition), registries);

describe("resolveScope", () => {
  test("area control grants control to operable domains and view to the rest", () => {
    const out = resolve({ dashboards: ["lovelace-guest"], areas: { living_room: "control" } });
    expect(out.dashboards).toEqual(["lovelace-guest"]);
    expect(out.entities).toEqual({
      "light.ceiling": "control",
      "media_player.tv": "control",
      "automation.goodnight": "view",
      "scene.movie": "view",
      "number.tv_sensitivity": "view",
      "sensor.living_room_temp": "view",
    });
  });

  test("area view grants view to everything in it", () => {
    const out = resolve({ dashboards: [], areas: { living_room: "view" } });
    expect(new Set(Object.values(out.entities))).toEqual(new Set(["view"]));
  });

  test("an entity override can grant control to any domain", () => {
    const out = resolve({ dashboards: [], areas: { living_room: "control" }, entities: { "scene.movie": "control" } });
    expect(out.entities["scene.movie"]).toBe("control");
  });

  test("entity area wins over device area", () => {
    const out = resolve({ dashboards: [], areas: { guest_bedroom: "view" } });
    expect(out.entities).toEqual({ "sensor.bedroom_temp": "view", "light.bedroom": "view" });
  });

  test("disabled, hidden, config and diagnostic entities are not granted by area", () => {
    const out = resolve({ dashboards: [], areas: { living_room: "view" } });
    expect(Object.keys(out.entities).sort()).toEqual([
      "automation.goodnight",
      "light.ceiling",
      "media_player.tv",
      "number.tv_sensitivity",
      "scene.movie",
      "sensor.living_room_temp",
    ]);
  });

  test("entity overrides add, raise, lower and remove", () => {
    const out = resolve({
      dashboards: [],
      areas: { living_room: "view" },
      entities: {
        "cover.garage_door": "control",
        "media_player.tv": "control",
        "light.ceiling": "none",
        "switch.tv_restart": "view",
      },
    });
    expect(out.entities).toMatchObject({ "media_player.tv": "control", "cover.garage_door": "control", "switch.tv_restart": "view" });
    expect(out.entities).not.toHaveProperty("light.ceiling");
  });

  test("entity area wins over device area even when the device area grants more", () => {
    const shared: Registries = {
      ...registries,
      entities: [{ entity_id: "light.shared", area_id: "living_room", device_id: "dev-garage", disabled_by: null, hidden_by: null, entity_category: null }],
    };
    const def = parseScopeDefinition({ dashboards: [], areas: { living_room: "view", garage: "control" } });
    expect(resolveScope(def, shared).entities).toEqual({ "light.shared": "view" });
  });

  test("unknown area id fails", () => {
    expect(() => resolve({ dashboards: [], areas: { attic: "view" } })).toThrow(/attic/);
  });

  test("override for an entity HA does not know is kept, admin asked for it", () => {
    const out = resolve({ dashboards: [], entities: { "input_boolean.guest_mode": "control" } });
    expect(out.entities).toEqual({ "input_boolean.guest_mode": "control" });
  });

  test("reports where each grant came from", () => {
    const out = resolve({ dashboards: [], areas: { living_room: "view" }, entities: { "cover.garage_door": "view" } });
    expect(out.sources).toMatchObject({
      "light.ceiling": "area:living_room",
      "media_player.tv": "area:living_room",
      "cover.garage_door": "entity",
    });
  });

  test("output is a valid enforcement scope", () => {
    const out = resolve({ dashboards: ["lovelace-guest"], areas: { living_room: "control" } });
    expect(Object.keys(out)).toEqual(["dashboards", "entities", "sources"]);
  });
});
