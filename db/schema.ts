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

export const aiConfigs = sqliteTable("ai_configs", {
  userKey: text("user_key").primaryKey(),
  provider: text("provider").notNull().default("deepseek"),
  baseUrl: text("base_url").notNull().default("https://api.deepseek.com/v1"),
  model: text("model").notNull().default("deepseek-v4-flash"),
  dailyLimit: integer("daily_limit").notNull().default(30),
  timeoutSeconds: integer("timeout_seconds").notNull().default(25),
  encryptedApiKey: text("encrypted_api_key").notNull(),
  keyIv: text("key_iv").notNull(),
  encryptionVersion: integer("encryption_version").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const aiRateLimits = sqliteTable("ai_rate_limits", {
  bucketKey: text("bucket_key").primaryKey(),
  requestCount: integer("request_count").notNull().default(1),
  expiresAt: integer("expires_at").notNull(),
});
