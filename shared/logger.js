// Logs JSON de una línea a stdout (los recoge el OTel Collector / Loki).
// getTraceContext es opcional y lo provee cada servicio desde @opentelemetry/api.

export const createLogger = ({ service, getTraceContext = () => ({}) }) => {
  const write = (level, message, fields = {}) => {
    const line = {
      time: new Date().toISOString(),
      level,
      service,
      message,
      ...getTraceContext(),
      ...fields,
    };
    const output = level === "error" || level === "warn" ? process.stderr : process.stdout;
    output.write(`${JSON.stringify(line)}\n`);
  };
  return {
    debug: (message, fields) => process.env.LOG_LEVEL === "debug" && write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
};
