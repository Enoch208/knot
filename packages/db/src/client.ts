import { Pool, type PoolConfig } from "pg"

export const createDatabasePool = (connectionString: string, overrides: PoolConfig = {}): Pool =>
  new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, ...overrides })
