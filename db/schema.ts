import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const syncStates = sqliteTable("sync_states", {
  userKey: text("user_key").primaryKey(),
  revision: integer("revision").notNull().default(1),
  schemaVersion: text("schema_version").notNull(),
  payload: text("payload").notNull(),
  clientUpdatedAt: text("client_updated_at").notNull(),
  serverUpdatedAt: text("server_updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
