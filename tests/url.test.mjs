import test from "node:test";
import assert from "node:assert/strict";
import { parseSwarmLink, assertMatchingApi } from "../plugins/truffle-swarm/lib/url.mjs";

test("a swarm link yields its id, api base and invitation", () => {
  const link = parseSwarmLink("https://app.truffle.tech/w/product#invite=abc123def456");
  assert.equal(link.id, "product");
  assert.equal(link.url, "https://app.truffle.tech/w/product");
  assert.equal(link.api, "https://app.truffle.tech/api/w/product");
  assert.equal(link.invite, "abc123def456");
});

test("shareable page paths resolve to the same swarm", () => {
  for (const suffix of ["", "/", "/wiki", "/tasks", "/skill.md"])
    assert.equal(parseSwarmLink(`https://host/w/team${suffix}`).url, "https://host/w/team");
});

test("http is accepted only on loopback", () => {
  assert.equal(parseSwarmLink("http://localhost:8080/w/dev").api, "http://localhost:8080/api/w/dev");
  assert.throws(() => parseSwarmLink("http://example.com/w/dev"), /HTTPS/);
});

test("links that could redirect a credential are refused", () => {
  const rejected = [
    "https://user:pass@host/w/product",
    "https://host/w/product?token=1",
    "https://host/workspace/product",
    "https://host/w/Product",
    "https://host/w/ab",
    "https://host/w/product/wiki/extra",
    "not a url",
    "",
  ];
  for (const link of rejected) assert.throws(() => parseSwarmLink(link), Error, link);
});

test("a malformed invitation is reported rather than sent", () => {
  assert.throws(() => parseSwarmLink("https://host/w/product#invite=short"), /malformed/);
});

test("a saved profile whose api was edited away from its swarm is refused", () => {
  assert.throws(
    () => assertMatchingApi({ workspace: "https://host/w/product", api: "https://evil.example/api/w/product" }),
    /Refusing to send credentials/,
  );
  assert.equal(
    assertMatchingApi({ workspace: "https://host/w/product", api: "https://host/api/w/product" }).id,
    "product",
  );
});
