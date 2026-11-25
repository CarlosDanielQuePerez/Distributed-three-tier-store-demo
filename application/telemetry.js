// Se carga con `node --import ./telemetry.js index.js` ANTES que el resto del código,
// para que la auto-instrumentación parchee http, mysql2, mongodb, redis y amqplib.
//
// Todo se configura con variables OTEL_* estándar:
//   OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
//   OTEL_SERVICE_NAME=store-api
//   OTEL_TRACES_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp OTEL_LOGS_EXPORTER=none
// Si no hay endpoint configurado (o OTEL_SDK_DISABLED=true) no se carga nada.
// El contexto de la traza viaja por los headers de los mensajes de RabbitMQ
// (instrumentación amqplib), así que API → cola → worker queda en una sola traza.

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT && process.env.OTEL_SDK_DISABLED !== "true") {
  const { register } = await import("node:module");
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS ||= "http,mysql2,mongodb,redis,amqplib,dns,net,runtime-node";
  process.env.OTEL_NODE_RESOURCE_DETECTORS ||= "env,host,os,process,container";
  await import("@opentelemetry/auto-instrumentations-node/register");
}
