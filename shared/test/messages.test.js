import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ValidationError,
  buildCatalogChanged,
  buildCatalogRefresh,
  buildReviewCreated,
  parseCatalogChanged,
  parseCatalogRefresh,
  parseReviewCreated,
  validateReviewInput,
} from "../messages.js";

test("validateReviewInput normaliza y valida", () => {
  assert.deepEqual(validateReviewInput({ reviewer: " Taylor ", rating: 5, comment: " Great " }), {
    reviewer: "Taylor",
    rating: 5,
    comment: "Great",
  });
  for (const bad of [null, [], { reviewer: "", rating: 5, comment: "x" }, { reviewer: "a", rating: 6, comment: "x" }, { reviewer: "a", rating: 2.5, comment: "x" }]) {
    assert.throws(() => validateReviewInput(bad), ValidationError);
  }
});

test("review.created ida y vuelta", () => {
  const message = buildReviewCreated({ idempotencyKey: "abc-12345", sku: "ST-001", reviewer: "A", rating: 4, comment: "ok" });
  const parsed = parseReviewCreated(JSON.parse(JSON.stringify(message)));
  assert.equal(parsed.idempotencyKey, "abc-12345");
  assert.equal(parsed.sku, "ST-001");
  assert.ok(parsed.occurredAt instanceof Date);
  assert.throws(() => parseReviewCreated({ ...message, idempotencyKey: "short" }), ValidationError);
  assert.throws(() => parseReviewCreated({ ...message, version: 2 }), ValidationError);
});

test("mensajes de catálogo", () => {
  assert.deepEqual(parseCatalogChanged(buildCatalogChanged({ sku: "ST-002", price: 4 })), { sku: "ST-002", change: "price", price: 4 });
  assert.equal(parseCatalogRefresh(buildCatalogRefresh({ cacheKey: "k", reason: "manual" })).cacheKey, "k");
  assert.throws(() => parseCatalogChanged({ type: "catalog.changed", version: 1, data: { sku: "bad sku" } }), ValidationError);
});
