import { describe, expect, test } from "bun:test";
import { parseScopeDefinition, type ScopeDefinition } from "../src/scope-definition.ts";

const valid: ScopeDefinition = {
  dashboards: ["lovelace-guest"],
  areas: { living_room: "control", guest_bedroom: "view" },
  entities: { "lock.front_door": "control", "switch.heater": "none" },
};

describe("parseScopeDefinition", () => {
  test("accepts a full definition", () => {
    expect(parseScopeDefinition(valid)).toEqual(valid);
  });

  test("areas and entities are optional, dashboards required", () => {
    expect(parseScopeDefinition({ dashboards: ["lovelace"], areas: { kitchen: "view" } })).toEqual({
      dashboards: ["lovelace"],
      areas: { kitchen: "view" },
      entities: {},
    });
    expect(parseScopeDefinition({ dashboards: [], entities: { "light.a": "view" } })).toEqual({
      dashboards: [],
      areas: {},
      entities: { "light.a": "view" },
    });
  });

  test.each([
    [null, "null"],
    [{}, "no dashboards"],
    [{ dashboards: ["lovelace"] }, "nothing granted"],
    [{ dashboards: ["a/b"], areas: { x: "view" } }, "bad dashboard path"],
    [{ dashboards: [], areas: { living_room: "admin" } }, "bad area permission"],
    [{ dashboards: [], areas: { living_room: "none" } }, "none is not an area permission"],
    [{ dashboards: [], areas: { "Living Room": "view" } }, "bad area id"],
    [{ dashboards: [], areas: [] }, "areas array"],
    [{ dashboards: [], entities: { notanentity: "view" } }, "bad entity id"],
    [{ dashboards: [], entities: { "light.a": "deny" } }, "bad entity permission"],
    [{ dashboards: [], entities: { "light.a": true } }, "boolean entity permission"],
  ])("rejects %p (%s)", (input) => {
    expect(() => parseScopeDefinition(input)).toThrow();
  });
});
