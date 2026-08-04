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

export const aiProviderConfig = sqliteTable("ai_provider_config", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  baseUrl: text("base_url").notNull(),
  model: text("model").notNull(),
  apiKeyCiphertext: text("api_key_ciphertext").notNull(),
  apiKeyIv: text("api_key_iv").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const aiRateLimits = sqliteTable("ai_rate_limits", {
  bucketKey: text("bucket_key").primaryKey(),
  requestCount: integer("request_count").notNull().default(1),
  expiresAt: integer("expires_at").notNull(),
});
