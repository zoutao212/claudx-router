import assert from "node:assert/strict";
import { rewriteImageModelForProxy } from "../src/api/routes";

const body = {
  model: "gpt-image-1.5",
  prompt: "test",
  n: 1,
};

const rewritten = rewriteImageModelForProxy(body, {
  "gpt-image-1.5": "gpt-image-2",
});

assert.equal(rewritten.model, "gpt-image-2");
assert.equal(body.model, "gpt-image-1.5", "rewrite should not mutate original body");

const unchanged = rewriteImageModelForProxy({ model: "dall-e-3" }, {
  "gpt-image-1.5": "gpt-image-2",
});
assert.equal(unchanged.model, "dall-e-3");

console.log("openai image model rewrite behavior ok");
