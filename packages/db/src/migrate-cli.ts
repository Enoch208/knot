import { createDatabasePool } from "./client.ts"
import { migrateDatabase } from "./migrate.ts"

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error("DATABASE_URL is required")
}

const pool = createDatabasePool(connectionString)

try {
  await migrateDatabase(pool)
  process.stdout.write("database migrations applied\n")
} finally {
  await pool.end()
}
