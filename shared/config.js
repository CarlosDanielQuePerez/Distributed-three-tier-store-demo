// Configuración 12-factor común: todo sale de variables de entorno.

export const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

export const optional = (name, fallback = undefined) => process.env[name] || fallback;

export const bool = (name, fallback = false) => {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

export const parseHostList = (value, defaultPort) =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [host, port] = entry.split(":");
      return { host, port: Number(port || defaultPort) };
    });

/** MariaDB: DB_HOST/DB_PORT apuntan a un proxy consciente del clúster (HAProxy en Compose, MaxScale en K8s). */
export const mariaDbConfig = () => ({
  host: required("DB_HOST"),
  port: Number(process.env.DB_PORT || 3306),
  database: required("DB_NAME"),
  user: required("DB_USER"),
  password: required("DB_PASSWORD"),
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  connectTimeout: 5000,
});

/**
 * MongoDB: MONGO_URL completo, o MONGO_HOSTS + MONGO_REPLICA_SET + usuario.
 * MONGO_AUTH_SOURCE permite usar un usuario de aplicación creado en la base de reseñas.
 */
export const mongoConfig = () => {
  const database = required("MONGO_DB");
  if (process.env.MONGO_URL) {
    return { url: process.env.MONGO_URL, database, options: { serverSelectionTimeoutMS: 5000 } };
  }
  const hosts =
    process.env.MONGO_HOSTS || `${required("MONGO_HOST")}:${Number(process.env.MONGO_PORT || 27017)}`;
  const replicaSet = process.env.MONGO_REPLICA_SET;
  const params = new URLSearchParams();
  if (replicaSet) {
    params.set("replicaSet", replicaSet);
    params.set("w", "majority");
  }
  return {
    url: `mongodb://${hosts}/${encodeURIComponent(database)}${params.size ? `?${params}` : ""}`,
    database,
    options: {
      auth: { username: required("MONGO_USER"), password: required("MONGO_PASSWORD") },
      authSource: process.env.MONGO_AUTH_SOURCE || "admin",
      serverSelectionTimeoutMS: 5000,
    },
  };
};

/** Redis detrás de Sentinel. REDIS_PASSWORD es opcional (obligatorio en K8s). */
export const redisSentinelConfig = () => {
  const password = process.env.REDIS_PASSWORD || undefined;
  const sentinelPassword = process.env.REDIS_SENTINEL_PASSWORD || undefined;
  return {
    name: process.env.REDIS_MASTER_NAME || "mymaster",
    sentinelRootNodes: parseHostList(required("REDIS_SENTINELS"), 26379),
    nodeClientOptions: password ? { password } : undefined,
    sentinelClientOptions: sentinelPassword ? { password: sentinelPassword } : undefined,
  };
};
