import { describe, expect, test } from "bun:test";
import { EXPIRY_SCRIPT_PATH, withExpiryNotice } from "../src/expiry-notice.ts";

const htmlResponse = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });

describe("withExpiryNotice", () => {
  test("adds the script to the end of the body", async () => {
    const res = withExpiryNotice(htmlResponse("<html><head></head><body><p>hi</p></body></html>"));
    expect(await res.text()).toBe(`<html><head></head><body><p>hi</p><script src="${EXPIRY_SCRIPT_PATH}"></script></body></html>`);
  });

  test("keeps status and headers", async () => {
    const res = withExpiryNotice(htmlResponse("<html><body></body></html>", { "x-frame-options": "SAMEORIGIN" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("leaves non-HTML responses alone", async () => {
    const body = `console.log("</body>")`;
    const res = withExpiryNotice(new Response(body, { headers: { "content-type": "application/javascript" } }));
    expect(await res.text()).toBe(body);
  });

  test("leaves a response without a content type alone", async () => {
    const res = withExpiryNotice(new Response("<html><body></body></html>"));
    expect(await res.text()).toBe("<html><body></body></html>");
  });

  test("survives an empty body", async () => {
    const res = withExpiryNotice(htmlResponse(""));
    expect(await res.text()).toBe("");
  });
});
