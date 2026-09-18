import { describe, expect, test } from "bun:test";
import { parseScope } from "../src/scope.ts";

const valid = {
  dashboards: ["lovelace-guest"],
  entities: { "light.living_room": "control", "sensor.outdoor_temperature": "view" },
};

describe("parseScope", () => {
  test("accepts a valid scope", () => {
    const scope = parseScope(valid);
    expect(scope.canView("light.living_room")).toBe(true);
    expect(scope.canControl("light.living_room")).toBe(true);
    expect(scope.canView("sensor.outdoor_temperature")).toBe(true);
    expect(scope.canControl("sensor.outdoor_temperature")).toBe(false);
    expect(scope.canOpenDashboard("lovelace-guest")).toBe(true);
  });

  test("denies anything not listed", () => {
    const scope = parseScope(valid);
    expect(scope.canView("light.bedroom")).toBe(false);
    expect(scope.canControl("light.bedroom")).toBe(false);
    expect(scope.canOpenDashboard("lovelace")).toBe(false);
    expect(scope.canOpenDashboard("")).toBe(false);
  });

  test("lists scoped dashboards in order", () => {
    expect(parseScope({ ...valid, dashboards: ["b", "a"] }).dashboards()).toEqual(["b", "a"]);
  });

  test("lists scoped entity ids", () => {
    expect(parseScope(valid).entityIds().sort()).toEqual(["light.living_room", "sensor.outdoor_temperature"]);
  });

  test("entity lookups are exact, not prefix or case-insensitive", () => {
    const scope = parseScope(valid);
    expect(scope.canView("light.living_room2")).toBe(false);
    expect(scope.canView("light.living_roo")).toBe(false);
    expect(scope.canView("Light.Living_Room")).toBe(false);
    expect(scope.canView("light.living_room ")).toBe(false);
  });

  test("non-string inputs are denied", () => {
    const scope = parseScope(valid);
    expect(scope.canView(undefined as unknown as string)).toBe(false);
    expect(scope.canView(123 as unknown as string)).toBe(false);
    expect(scope.canControl(["light.living_room"] as unknown as string)).toBe(false);
    expect(scope.canOpenDashboard(null as unknown as string)).toBe(false);
  });

  test.each([
    [null, "null"],
    ["{}", "string"],
    [{}, "missing members"],
    [{ dashboards: [], entities: {} }, "empty"],
    [{ dashboards: "lovelace", entities: valid.entities }, "dashboards not array"],
    [{ dashboards: [1], entities: valid.entities }, "dashboard not string"],
    [{ dashboards: ["a/b"], entities: valid.entities }, "dashboard with slash"],
    [{ dashboards: valid.dashboards, entities: [] }, "entities array"],
    [{ dashboards: valid.dashboards, entities: { "light.x": "admin" } }, "unknown permission"],
    [{ dashboards: valid.dashboards, entities: { "light.x": true } }, "boolean permission"],
    [{ dashboards: valid.dashboards, entities: { notanentity: "view" } }, "bad entity id"],
    [{ dashboards: valid.dashboards, entities: { "light.Living": "view" } }, "uppercase entity id"],
    [{ dashboards: valid.dashboards, entities: { "light.*": "view" } }, "wildcard entity id"],
    [{ dashboards: valid.dashboards, entities: { "*": "view" } }, "bare wildcard"],
  ])("rejects %p (%s)", (input) => {
    expect(() => parseScope(input)).toThrow();
  });
});
