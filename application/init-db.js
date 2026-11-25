// Job de inicialización (servicio catalog-init en Compose, Job store-init en K8s):
// 1. Aplica las migraciones SQL de database/migrations en MariaDB.
// 2. Crea (opcional) el usuario de aplicación de MongoDB con privilegio mínimo.
// 3. Crea índices y reseñas de ejemplo de forma idempotente.
import { MongoClient } from "mongodb";
import mysql from "mysql2/promise";
import { mongoConfig, required } from "../shared/config.js";
import { migrate } from "./migrate.js";

const migrationsDir =
  process.env.MIGRATIONS_DIR || new URL("./database/migrations", import.meta.url).pathname;

const connectToMariaDb = async () => {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      return await mysql.createConnection({
        host: required("DB_HOST"),
        port: Number(process.env.DB_PORT || 3306),
        database: required("DB_NAME"),
        // El usuario de migraciones puede crear/alterar tablas; el de la app solo DML.
        user: process.env.DB_MIGRATION_USER || required("DB_USER"),
        password: process.env.DB_MIGRATION_PASSWORD || required("DB_PASSWORD"),
        multipleStatements: true,
      });
    } catch (error) {
      if (!["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENOTFOUND", "PROTOCOL_CONNECTION_LOST"].includes(error.code) || attempt === 30) {
        throw error;
      }
      console.log(`MariaDB is not ready; retrying (${attempt}/30)`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw new Error("MariaDB connection retry limit reached");
};

const connection = await connectToMariaDb();
try {
  const results = await migrate(connection, migrationsDir);
  console.log(`MariaDB migrations: ${results.filter((r) => r.status === "applied").length} applied, ${results.length} total`);
} finally {
  await connection.end();
}

const mongo = mongoConfig();
const client = new MongoClient(mongo.url, mongo.options);
try {
  await client.connect();
  const db = client.db(mongo.database);

  const appUser = process.env.MONGO_APP_USERNAME;
  const appPassword = process.env.MONGO_APP_PASSWORD;
  if (appUser && appPassword) {
    const { users } = await db.command({ usersInfo: appUser });
    if (users.length === 0) {
      await db.command({ createUser: appUser, pwd: appPassword, roles: [{ role: "readWrite", db: mongo.database }] });
      console.log(`MongoDB application user ${appUser} created (readWrite on ${mongo.database})`);
    } else {
      await db.command({ updateUser: appUser, pwd: appPassword, roles: [{ role: "readWrite", db: mongo.database }] });
      console.log(`MongoDB application user ${appUser} updated`);
    }
  }

  const reviews = db.collection("product_reviews");
  await reviews.createIndex({ sku: 1, createdAt: -1 });
  await reviews.createIndex({ sampleId: 1 }, { unique: true, sparse: true });
  // Idempotencia de la cola: una Idempotency-Key solo se guarda una vez.
  await reviews.createIndex(
    { idempotencyKey: 1 },
    { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
  );
  const samples = [
    { sampleId: "sample-st-001", sku: "ST-001", reviewer: "Alex", rating: 5, comment: "Sturdy and convenient for grocery shopping.", createdAt: new Date("2025-01-15T12:00:00.000Z") },
    { sampleId: "sample-st-003", sku: "ST-003", reviewer: "Sam", rating: 4, comment: "A comfortable everyday mug.", createdAt: new Date("2025-01-16T12:00:00.000Z") },
  ];
  for (const sample of samples) {
    await reviews.updateOne({ sampleId: sample.sampleId }, { $setOnInsert: sample }, { upsert: true });
  }
  console.log("Product reviews initialized in MongoDB");
} finally {
  await client.close();
}
