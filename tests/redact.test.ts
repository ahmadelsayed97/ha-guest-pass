import { describe, expect, test } from "bun:test";
import { filterDashboard, redactConfig } from "../src/redact.ts";
import { parseScope } from "../src/scope.ts";

const scope = parseScope({ dashboards: ["lovelace"], entities: { "light.kitchen": "control", "sensor.temp": "view" } });

describe("redactConfig", () => {
  const config = {
    latitude: 52.37,
    longitude: 4.89,
    elevation: 3,
    radius: 100,
    unit_system: { length: "km", temperature: "°C" },
    location_name: "Home",
    time_zone: "Europe/Amsterdam",
    components: ["frontend", "lovelace", "light", "zwave_js", "history", "config", "hassio", "mqtt"],
    config_dir: "/config",
    allowlist_external_dirs: ["/media"],
    allowlist_external_urls: ["http://x"],
    whitelist_external_dirs: ["/media"],
    version: "2026.9.1",
    config_source: "storage",
    recovery_mode: false,
    safe_mode: false,
    debug: false,
    state: "RUNNING",
    external_url: "https://home.example.com",
    internal_url: "http://192.168.1.2:8123",
    currency: "EUR",
    country: "NL",
    language: "en",
  };

  test("strips location, paths and urls", () => {
    const out = redactConfig(config) as Record<string, unknown>;
    for (const key of [
      "latitude",
      "longitude",
      "elevation",
      "radius",
      "config_dir",
      "allowlist_external_dirs",
      "allowlist_external_urls",
      "whitelist_external_dirs",
      "external_url",
      "internal_url",
      "config_source",
      "recovery_mode",
      "safe_mode",
      "debug",
    ]) {
      expect(out).not.toHaveProperty(key);
    }
  });

  test("keeps what the frontend needs", () => {
    const out = redactConfig(config) as Record<string, unknown>;
    expect(out.unit_system).toEqual(config.unit_system);
    expect(out.time_zone).toBe("Europe/Amsterdam");
    expect(out.version).toBe("2026.9.1");
    expect(out.state).toBe("RUNNING");
    expect(out.location_name).toBe("Home");
    expect(out.language).toBe("en");
  });

  test("reduces components to an allowlist", () => {
    const out = redactConfig(config) as Record<string, unknown>;
    expect(out.components).toEqual(["frontend", "lovelace"]);
  });

  test("does not mutate its input", () => {
    const copy = structuredClone(config);
    redactConfig(config);
    expect(config).toEqual(copy);
  });

  test("non-object input becomes an empty object", () => {
    expect(redactConfig(null)).toEqual({});
    expect(redactConfig("x")).toEqual({});
    expect(redactConfig([1])).toEqual({});
  });
});

const filter = (config: unknown) => filterDashboard(config, scope, "guest");

describe("filterDashboard", () => {
  test("drops any object that references an unscoped entity, keeping siblings", () => {
    const input = {
      title: "Guest",
      views: [
        {
          title: "Home",
          cards: [
            { type: "light", entity: "light.kitchen", name: "Kitchen" },
            { type: "light", entity: "lock.front_door", name: "Front Door" },
            { type: "entities", entities: ["sensor.temp", "lock.front_door", { entity: "camera.garage", name: "Garage" }] },
            { type: "markdown", content: "Temp: {{ states('sensor.secret') }}" },
            { type: "picture", image: "/local/floor.png" },
          ],
        },
      ],
    };
    const out = filter(input);
    expect(out).toEqual({
      title: "Guest",
      views: [
        {
          title: "Home",
          cards: [
            { type: "light", entity: "light.kitchen", name: "Kitchen" },
            { type: "entities", entities: ["sensor.temp"] },
            { type: "picture", image: "/local/floor.png" },
          ],
        },
      ],
    });
    const text = JSON.stringify(out);
    for (const leaked of ["lock.front_door", "Front Door", "camera.garage", "Garage", "sensor.secret"]) expect(text).not.toContain(leaked);
  });

  test("an unscoped entity nested deep removes only the nearest enclosing object", () => {
    const out = filter({ views: [{ cards: [{ type: "grid", cards: [{ entity: "light.kitchen" }, { entity: "light.bedroom" }] }] }] });
    expect(out).toEqual({ views: [{ cards: [{ type: "grid", cards: [{ entity: "light.kitchen" }] }] }] });
  });

  test("drops entity ids used as object keys", () => {
    expect(filter({ "light.kitchen": 1, "switch.pool": 2 })).toEqual({ "light.kitchen": 1 });
  });

  test("a root that references an unscoped entity becomes empty", () => {
    expect(filter({ entity: "switch.pool" })).toEqual({});
    expect(filter("switch.pool")).toEqual({});
  });

  test("leaves non-entity strings alone", () => {
    const input = { a: "hello world", b: "https://example.com/x.y", c: "1.5", d: 3, e: null, f: true };
    expect(filter(input)).toEqual(input);
  });

  test("does not mutate its input", () => {
    const input = { cards: [{ entity: "lock.front_door" }] };
    filter(input);
    expect(input.cards[0]!.entity).toBe("lock.front_door");
  });

  describe("empty containers", () => {
    test("a section left without any entity is removed", () => {
      const out = filter({
        views: [
          {
            type: "sections",
            sections: [
              { type: "grid", cards: [{ type: "heading", heading: "Living Room" }, { type: "tile", entity: "light.kitchen" }] },
              { type: "grid", cards: [{ type: "heading", heading: "Kitchen" }, { type: "tile", entity: "switch.pool" }] },
              { type: "grid", cards: [{ type: "heading", heading: "Notes" }, { type: "markdown", content: "hi" }] },
            ],
          },
        ],
      });
      expect(out).toEqual({
        views: [
          {
            type: "sections",
            sections: [{ type: "grid", cards: [{ type: "heading", heading: "Living Room" }, { type: "tile", entity: "light.kitchen" }] }],
          },
        ],
      });
    });

    test("stacks, conditional and picture-elements cards without entities are removed", () => {
      const out = filter({
        views: [
          {
            cards: [
              { type: "tile", entity: "sensor.temp" },
              { type: "vertical-stack", cards: [{ type: "picture-elements", image: "/local/washer.png", elements: [{ entity: "sensor.washer" }] }] },
              { type: "conditional", conditions: [], card: { type: "tile", entity: "switch.pool" } },
              { type: "horizontal-stack", cards: [{ type: "button", entity: "light.kitchen" }, { type: "button", entity: "light.other" }] },
            ],
          },
        ],
      });
      expect(out).toEqual({
        views: [
          {
            cards: [
              { type: "tile", entity: "sensor.temp" },
              { type: "horizontal-stack", cards: [{ type: "button", entity: "light.kitchen" }] },
            ],
          },
        ],
      });
    });

    test("a view header card without entities is kept and does not remove the view", () => {
      const view = {
        title: "Home",
        type: "sections",
        header: { card: { type: "markdown", content: "Welcome" }, layout: "center" },
        badges: [{ type: "entity", entity: "switch.pool" }],
        sections: [{ type: "grid", cards: [{ type: "tile", entity: "light.kitchen" }] }],
      };
      expect(filter({ views: [view] })).toEqual({ views: [{ ...view, badges: [] }] });
    });

    test("a conditional card whose inner card is removed drops only the conditional card", () => {
      const out = filter({
        views: [
          {
            cards: [
              { type: "tile", entity: "light.kitchen" },
              { type: "conditional", conditions: [], card: { type: "markdown", content: "x" } },
            ],
          },
        ],
      });
      expect(out).toEqual({ views: [{ cards: [{ type: "tile", entity: "light.kitchen" }] }] });
    });

    test("a view without any entity is removed", () => {
      const out = filter({
        views: [
          { title: "Home", cards: [{ type: "tile", entity: "light.kitchen" }] },
          { title: "Media", path: "media", cards: [{ type: "heading", heading: "Media" }] },
          { title: "Empty", cards: [] },
        ],
      });
      expect(out).toEqual({ views: [{ title: "Home", cards: [{ type: "tile", entity: "light.kitchen" }] }] });
    });
  });

  describe("visibility", () => {
    const card = (visibility: unknown) => ({ type: "tile", entity: "light.kitchen", visibility });
    const wrap = (c: unknown) => ({ views: [{ cards: [{ type: "tile", entity: "sensor.temp" }, c] }] });
    const only = (out: unknown) => (out as { views: Array<{ cards: unknown[] }> }).views[0]!.cards;

    test("a user condition that does not list the guest removes the card", () => {
      expect(only(filter(wrap(card([{ condition: "user", users: ["admin-id"] }]))))).toHaveLength(1);
    });

    test("a user condition that lists the guest keeps the card", () => {
      const c = card([{ condition: "user", users: ["admin-id", "guest"] }]);
      expect(only(filter(wrap(c)))).toEqual([{ type: "tile", entity: "sensor.temp" }, c]);
    });

    test("other conditions are left for the frontend", () => {
      const c = card([{ condition: "state", entity: "sensor.temp", state: "21" }, { condition: "screen", media_query: "(min-width: 600px)" }]);
      expect(only(filter(wrap(c)))).toEqual([{ type: "tile", entity: "sensor.temp" }, c]);
    });

    test("malformed visibility removes the card", () => {
      expect(only(filter(wrap(card("user"))))).toHaveLength(1);
      expect(only(filter(wrap(card([{ condition: "user" }]))))).toHaveLength(1);
      expect(only(filter(wrap(card([{ condition: "user", users: "guest" }]))))).toHaveLength(1);
    });

    test("applies to sections and views", () => {
      const out = filter({
        views: [
          { title: "Admin", visibility: [{ condition: "user", users: ["admin-id"] }], cards: [{ type: "tile", entity: "light.kitchen" }] },
          {
            title: "Home",
            type: "sections",
            sections: [
              { type: "grid", visibility: [{ condition: "user", users: ["admin-id"] }], cards: [{ type: "tile", entity: "light.kitchen" }] },
              { type: "grid", cards: [{ type: "tile", entity: "sensor.temp" }] },
            ],
          },
        ],
      });
      expect(out).toEqual({
        views: [{ title: "Home", type: "sections", sections: [{ type: "grid", cards: [{ type: "tile", entity: "sensor.temp" }] }] }],
      });
    });
  });
});
