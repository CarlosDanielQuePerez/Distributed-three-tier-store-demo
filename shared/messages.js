// Construcción y validación de los mensajes descritos en messaging/schemas/*.json.
// La validación es manual (sin ajv) para que shared/ no tenga dependencias.

export class ValidationError extends Error {}

const SKU = /^[A-Za-z0-9-]{1,32}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

export const isValidSku = (value) => typeof value === "string" && SKU.test(value);
export const isValidIdempotencyKey = (value) => typeof value === "string" && IDEMPOTENCY_KEY.test(value);

/** Valida el cuerpo de POST /products/{sku}/reviews y devuelve los campos normalizados. */
export const validateReviewInput = (body) => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  const reviewer = typeof body.reviewer === "string" ? body.reviewer.trim() : "";
  const comment = typeof body.comment === "string" ? body.comment.trim() : "";
  if (
    reviewer.length < 1 ||
    reviewer.length > 80 ||
    !Number.isInteger(body.rating) ||
    body.rating < 1 ||
    body.rating > 5 ||
    comment.length < 1 ||
    comment.length > 1000
  ) {
    throw new ValidationError("Provide reviewer, rating (1-5), and comment within the allowed lengths");
  }
  return { reviewer, rating: body.rating, comment };
};

export const buildReviewCreated = ({ idempotencyKey, sku, reviewer, rating, comment, now = new Date() }) => ({
  type: "review.created",
  version: 1,
  idempotencyKey,
  occurredAt: now.toISOString(),
  data: { sku, reviewer, rating, comment },
});

export const parseReviewCreated = (message) => {
  if (message?.type !== "review.created" || message.version !== 1) {
    throw new ValidationError("Unsupported message type/version");
  }
  if (!isValidIdempotencyKey(message.idempotencyKey)) {
    throw new ValidationError("Invalid idempotencyKey");
  }
  if (!isValidSku(message.data?.sku)) {
    throw new ValidationError("Invalid sku");
  }
  const occurredAt = new Date(message.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new ValidationError("Invalid occurredAt");
  }
  return { idempotencyKey: message.idempotencyKey, occurredAt, sku: message.data.sku, ...validateReviewInput(message.data) };
};

export const buildCatalogChanged = ({ sku, price, now = new Date() }) => ({
  type: "catalog.changed",
  version: 1,
  occurredAt: now.toISOString(),
  data: { sku, change: "price", price },
});

export const parseCatalogChanged = (message) => {
  if (message?.type !== "catalog.changed" || message.version !== 1 || !isValidSku(message.data?.sku)) {
    throw new ValidationError("Invalid catalog.changed message");
  }
  return message.data;
};

export const buildCatalogRefresh = ({ cacheKey, reason, now = new Date() }) => ({
  type: "catalog.refresh",
  version: 1,
  occurredAt: now.toISOString(),
  data: { cacheKey, reason },
});

export const parseCatalogRefresh = (message) => {
  if (message?.type !== "catalog.refresh" || message.version !== 1 || typeof message.data?.cacheKey !== "string") {
    throw new ValidationError("Invalid catalog.refresh message");
  }
  return message.data;
};
