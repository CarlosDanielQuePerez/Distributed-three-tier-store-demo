// Interfaz de la tienda con trazas distribuidas (W3C Trace Context + OTLP).
//
// Cada petición a la API genera un traceparent en el navegador. Nginx (ngx_otel_module)
// y la API (OpenTelemetry Node.js) continúan esa misma traza, y el worker la sigue a
// través de los headers de RabbitMQ. El span del navegador se exporta en formato
// OTLP/HTTP JSON a /otel/v1/traces (Nginx lo reenvía al OTel Collector), así que en
// Tempo se ve la cadena completa navegador → web → API → MariaDB/Redis/MongoDB/RabbitMQ.
"use strict";

const config = window.STORE_CONFIG || { grafanaUrl: "", browserTracing: false };

const randomHex = (bytes) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

const nowNanos = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6)).toString();

const exportSpan = (span) => {
  if (!config.browserTracing) return;
  const attributes = Object.entries(span.attributes).map(([key, value]) => ({
    key,
    value: typeof value === "number" ? { intValue: value } : { stringValue: String(value) },
  }));
  const body = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "store-browser" } },
            { key: "user_agent.original", value: { stringValue: navigator.userAgent } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "store-catalog-ui", version: "2.0.0" },
            spans: [
              {
                traceId: span.traceId,
                spanId: span.spanId,
                name: span.name,
                kind: 3, // SPAN_KIND_CLIENT
                startTimeUnixNano: span.start,
                endTimeUnixNano: span.end,
                attributes,
                status: { code: span.error ? 2 : 1 },
              },
            ],
          },
        ],
      },
    ],
  };
  // Si el colector no está disponible simplemente se pierde el span del navegador.
  void fetch("/otel/v1/traces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
};

/** fetch con un span CLIENT del navegador y propagación del traceparent. */
const tracedFetch = async (path, { method = "GET", headers = {}, body } = {}) => {
  const span = { traceId: randomHex(16), spanId: randomHex(8), name: `${method} ${path}`, start: nowNanos() };
  const started = performance.now();
  span.attributes = { "http.request.method": method, "url.path": `/api${path}` };
  try {
    const response = await fetch(`/api${path}`, {
      method,
      body,
      headers: { ...headers, traceparent: `00-${span.traceId}-${span.spanId}-01` },
    });
    span.attributes["http.response.status_code"] = response.status;
    span.error = response.status >= 500;
    return { response, trace: { ...span, durationMs: performance.now() - started } };
  } catch (error) {
    span.error = true;
    throw error;
  } finally {
    span.end = nowNanos();
    exportSpan(span);
  }
};

const grafanaTraceUrl = (traceId) => {
  if (!config.grafanaUrl) return null;
  const panes = { a: { datasource: "tempo", queries: [{ refId: "A", queryType: "traceql", query: traceId }] } };
  return `${config.grafanaUrl}/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
};

const renderTrace = (listId, trace, response) => {
  const list = document.getElementById(listId);
  list.replaceChildren();
  if (!trace) {
    const item = document.createElement("li");
    item.textContent = "Trace not available";
    list.appendChild(item);
    return;
  }

  const idItem = document.createElement("li");
  idItem.className = "trace-id";
  const url = grafanaTraceUrl(trace.traceId);
  const label = `trace ${trace.traceId.slice(0, 12)}… · ${trace.durationMs.toFixed(0)} ms`;
  if (url) {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = label;
    idItem.appendChild(link);
  } else {
    idItem.textContent = label;
  }
  list.appendChild(idItem);

  const servedBy = response?.headers.get("X-Served-By");
  const hops = response?.headers.get("X-Request-Trace")?.split(" -> ").filter(Boolean) ?? [];
  for (const step of hops.length > 0 ? hops : servedBy ? [`served by ${servedBy}`] : []) {
    const item = document.createElement("li");
    item.textContent = step;
    list.appendChild(item);
  }
};

const loadProducts = async () => {
  const status = document.getElementById("status");
  try {
    const { response, trace } = await tracedFetch("/products/cheapest");
    renderTrace("products-trace", trace, response);
    if (!response.ok) throw new Error("The catalog API is unavailable.");
    const products = await response.json();
    status.textContent = "";
    const list = document.getElementById("products");
    list.replaceChildren();
    for (const product of products) {
      const item = document.createElement("li");
      item.textContent = `${product.name} — $${Number(product.price).toFixed(2)}`;
      list.appendChild(item);
    }
  } catch (error) {
    status.textContent = error.message;
  }
};

const loadReviews = async () => {
  const status = document.getElementById("reviews-status");
  try {
    const { response, trace } = await tracedFetch("/products/ST-001/reviews");
    renderTrace("reviews-trace", trace, response);
    if (!response.ok) throw new Error("The reviews API is unavailable.");
    const { reviews } = await response.json();
    status.textContent = reviews.length === 0 ? "No reviews yet." : "";
    const list = document.getElementById("reviews");
    list.replaceChildren();
    for (const review of reviews) {
      const item = document.createElement("li");
      item.textContent = `${review.reviewer} — ${review.rating}/5: ${review.comment}`;
      list.appendChild(item);
    }
  } catch (error) {
    status.textContent = error.message;
  }
};

const queryEndpoint = async (path, method = "GET") => {
  const status = document.getElementById("api-result-status");
  const result = document.getElementById("api-result");
  status.textContent = "Request in progress...";
  result.textContent = "";
  try {
    const { response, trace } = await tracedFetch(path, { method });
    renderTrace("api-trace", trace, response);
    const payload = await response.json();
    result.textContent = JSON.stringify(payload, null, 2);
    status.textContent = `${method} ${path} — HTTP ${response.status}`;
  } catch (error) {
    renderTrace("api-trace", null);
    status.textContent = error.message;
  }
};

const submitReview = async (event) => {
  event.preventDefault();
  const form = event.target;
  const status = document.getElementById("review-form-status");
  const data = new FormData(form);
  const sku = String(data.get("sku"));
  status.textContent = "Sending...";
  try {
    const { response, trace } = await tracedFetch(`/products/${encodeURIComponent(sku)}/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        reviewer: data.get("reviewer"),
        rating: Number(data.get("rating")),
        comment: data.get("comment"),
      }),
    });
    renderTrace("review-form-trace", trace, response);
    const payload = await response.json();
    status.textContent =
      response.status === 202
        ? "Accepted: the worker will store it in MongoDB in a moment."
        : response.ok
          ? "Stored directly in MongoDB (queue unavailable)."
          : `Error ${response.status}: ${payload.error}`;
    if (response.ok && sku === "ST-001") setTimeout(() => void loadReviews(), 1000);
  } catch (error) {
    status.textContent = error.message;
  }
};

document.getElementById("query-api").addEventListener("click", () => {
  void queryEndpoint(document.getElementById("api-endpoint").value);
});

document.getElementById("clear-cache").addEventListener("click", () => {
  void queryEndpoint("/cache/clear", "POST");
});

document.getElementById("review-form").addEventListener("submit", (event) => void submitReview(event));

void Promise.all([loadProducts(), loadReviews()]);
