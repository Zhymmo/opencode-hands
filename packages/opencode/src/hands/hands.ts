import { eq, and } from "drizzle-orm"
import { Database } from "../storage/db"
import { HandsTable } from "./hands.sql.ts"

export type HandsItem = {
  sessionID: string
  name: string
  type: "text" | "image" | "file"
  encoding: "utf8" | "base64"
  content: string
  source?: string
  size: number
}

export namespace Hands {
  export async function put(item: HandsItem): Promise<void> {
    const existing = await get(item.sessionID, item.name)
    if (existing) {
      throw new Error(`"${item.name}" already in hand, please use a different name`)
    }

    await Database.use((db) =>
      db.insert(HandsTable).values({
        session_id: item.sessionID,
        name: item.name,
        type: item.type,
        encoding: item.encoding,
        content: item.content,
        source: item.source ?? null,
        size: item.size,
        time_created: Date.now(),
        time_updated: Date.now(),
      }),
    )
  }

  export async function get(sessionID: string, name: string): Promise<HandsItem | null> {
    const result = await Database.use((db) =>
      db
        .select()
        .from(HandsTable)
        .where(and(eq(HandsTable.session_id, sessionID), eq(HandsTable.name, name)))
        .limit(1),
    )
    if (result.length === 0) return null
    const row = result[0]
    return {
      sessionID: row.session_id,
      name: row.name,
      type: row.type as "text" | "image" | "file",
      encoding: row.encoding as "utf8" | "base64",
      content: row.content,
      source: row.source ?? undefined,
      size: row.size,
    }
  }

  export async function remove(sessionID: string, name: string): Promise<boolean> {
    const result = await Database.use((db) =>
      db.delete(HandsTable).where(and(eq(HandsTable.session_id, sessionID), eq(HandsTable.name, name))).returning(),
    )
    return result.length > 0
  }

  export async function list(sessionID: string): Promise<Omit<HandsItem, "content">[]> {
    const result = await Database.use((db) =>
      db
        .select({
          sessionID: HandsTable.session_id,
          name: HandsTable.name,
          type: HandsTable.type,
          encoding: HandsTable.encoding,
          source: HandsTable.source,
          size: HandsTable.size,
        })
        .from(HandsTable)
        .where(eq(HandsTable.session_id, sessionID))
        .orderBy(HandsTable.time_created),
    )
    return result.map((row) => ({
      sessionID: row.sessionID,
      name: row.name,
      type: row.type as "text" | "image" | "file",
      encoding: row.encoding as "utf8" | "base64",
      source: row.source ?? undefined,
      size: row.size,
    }))
  }

  export async function totalSize(sessionID: string): Promise<number> {
    const result = await Database.use((db) =>
      db.select({ size: HandsTable.size }).from(HandsTable).where(eq(HandsTable.session_id, sessionID)),
    )
    return result.reduce((sum, row) => sum + row.size, 0)
  }
}
