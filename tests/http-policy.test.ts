import { describe, expect, test } from "bun:test";
import { classifyRequest } from "../src/http-policy.ts";

const dashboards = new Set(["lovelace-guest"]);
const classify = (path: string, method = "GET") => classifyRequest(method, path, (p) => dashboards.has(p));

describe("index pages", () => {
  test.each(["/", "/lovelace-guest", "/lovelace-guest/kitchen"])("%s is index", (p) => {
    expect(classify(p)).toBe("static");
  });

  test("the default dashboard needs scoping like any other", () => {
    expect(classify("/lovelace")).toBe("deny");
    expect(classify("/lovelace/0")).toBe("deny");
    expect(classifyRequest("GET", "/lovelace/0", (p) => p === "lovelace")).toBe("static");
  });

  test.each([
    "/config",
    "/config/entities",
    "/developer-tools/state",
    "/history",
    "/logbook",
    "/profile",
    "/map",
    "/energy",
    "/media-browser",
    "/lovelace-private",
    "/lovelace-guestx",
    "/lovelace-guest-2",
    "/todo",
    "/onboarding.html",
    "/authorize.html",
  ])("%s is denied", (p) => {
    expect(classify(p)).toBe("deny");
  });
});

describe("static assets", () => {
  test.each([
    "/frontend_latest/core.abc.js",
    "/frontend_es5/app.js",
    "/static/icons/favicon.ico",
    "/static/translations/en.json",
    "/manifest.json",
    "/service_worker.js",
    "/sw-modern.js",
    "/sw-legacy.js",
    "/local/custom-card.js",
    "/local/images/floor.png",
    "/hacsfiles/button-card/button-card.js",
  ])("%s is static", (p) => {
    expect(classify(p)).toBe("static");
  });

  test.each(["/frontend_latest/../api/states", "/static/..", "/local/../.storage/auth", "/local/%2e%2e/config"])(
    "%s traversal is denied",
    (p) => {
      expect(classify(p)).toBe("deny");
    },
  );
});

describe("api", () => {
  test.each([
    ["/api/camera_proxy/camera.front_door", "camera.front_door"],
    ["/api/media_player_proxy/media_player.kitchen", "media_player.kitchen"],
    ["/api/image/serve/image.map/512x512", "image.map"],
  ])("%s is an entity api route", (p, entityId) => {
    expect(classify(p)).toEqual({ entityId });
  });

  test.each([
    "/api/camera_proxy/",
    "/api/camera_proxy/notanentity",
    "/api/camera_proxy/Camera.front_door",
    "/api/camera_proxy/camera.front_door/extra",
    "/api/camera_proxy_stream/camera.front_door",
    "/api/image/serve/image.map",
    "/api/states",
    "/api/states/camera.front_door",
    "/api/history/period",
    "/api/logbook",
    "/api/template",
    "/api/config",
    "/api/services",
    "/api/error_log",
    "/api/hassio/app",
    "/api/onboarding",
    "/api",
    "/api/",
  ])("%s is denied", (p) => {
    expect(classify(p)).toBe("deny");
  });

});

describe("methods", () => {
  test.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])("%s to a static path is denied", (m) => {
    expect(classify("/", m)).toBe("deny");
    expect(classify("/static/x.js", m)).toBe("deny");
    expect(classify("/api/camera_proxy/camera.front_door", m)).toBe("deny");
  });

  test("HEAD is allowed where GET is", () => {
    expect(classify("/", "HEAD")).toBe("static");
  });
});
