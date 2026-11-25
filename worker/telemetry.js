// Igual que application/telemetry.js: se carga con `node --import ./telemetry.js index.js`.
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT && process.env.OTEL_SDK_DISABLED !== "true") {
  const { register } = await import("node:module");
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS ||= "http,mysql2,mongodb,redis,amqplib,dns,net,runtime-node";
  process.env.OTEL_NODE_RESOURCE_DETECTORS ||= "env,host,os,process,container";
  await import("@opentelemetry/auto-instrumentations-node/register");
}
