import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"
import { Timestamps } from "../storage/schema.sql"

export const HandsTable = sqliteTable(
  "hands",
  {
    session_id: text()
      .$type<string>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    type: text().notNull(), // "text" | "file"
    encoding: text().notNull().default("utf8"), // "utf8" | "base64"
    content: text().notNull(),
    description: text().notNull().default(""),
    source: text(),
    size: integer().notNull(),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.session_id, table.name] })],
)
