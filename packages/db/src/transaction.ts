import type { Pool, PoolClient } from "pg"

export const inTransaction = async <Value>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<Value>,
): Promise<Value> => {
  const client = await pool.connect()
  await client.query("BEGIN")
  try {
    const value = await operation(client)
    await client.query("COMMIT")
    return value
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
