import { metrics, trace } from "@opentelemetry/api";

export const getTraceContext = () => {
  const context = trace.getActiveSpan()?.spanContext();
  return context ? { trace_id: context.traceId, span_id: context.spanId } : {};
};

export const getTraceId = () => trace.getActiveSpan()?.spanContext().traceId;

/** Métricas de negocio; si el SDK no está activo, el meter global es no-op. */
export const createApiMetrics = () => {
  const meter = metrics.getMeter("store-catalog-api");
  const cacheRequests = meter.createCounter("store.cache.requests", {
    description: "Lecturas del catálogo por resultado de caché (hit, miss, worker_fill, db_fallback)",
  });
  const reviewsSubmitted = meter.createCounter("store.reviews.submitted", {
    description: "Reseñas aceptadas por la API, por modo (queued, direct)",
  });
  const catalogChanges = meter.createCounter("store.catalog.changes", {
    description: "Cambios de catálogo, por modo de invalidación (queued, direct)",
  });
  return {
    cache: (result) => cacheRequests.add(1, { result }),
    review: (mode) => reviewsSubmitted.add(1, { mode }),
    catalogChange: (mode) => catalogChanges.add(1, { mode }),
  };
};
