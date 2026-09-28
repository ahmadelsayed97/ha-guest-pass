export const EXPIRY_SCRIPT_PATH = "/guest/expiry.js";

const SCRIPT_TAG = `<script src="${EXPIRY_SCRIPT_PATH}"></script>`;

const rewriter = new HTMLRewriter().on("body", {
  element(element) {
    element.append(SCRIPT_TAG, { html: true });
  },
});

export function withExpiryNotice(response: Response): Response {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("text/html") ? rewriter.transform(response) : response;
}
