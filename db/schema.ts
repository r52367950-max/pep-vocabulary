import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  writeToken: text("write_token").notNull().default(""),
  encryptedApiKey: text("encrypted_api_key").notNull(),
  keyIv: text("key_iv").notNull(),
  encryptionVersion: integer("encryption_version").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Credential deletion rotates this durable fence even when no config exists.
export const aiConfigGenerations = sqliteTable("ai_config_generations", {
  userKey: text("user_key").primaryKey(),
  generation: text("generation").notNull(),
});

export const aiRateLimits = sqliteTable("ai_rate_limits", {
  bucketKey: text("bucket_key").primaryKey(),
  requestCount: integer("request_count").notNull().default(1),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [index("idx_ai_rate_limits_expires_at").on(table.expiresAt)]);

export const aiPreferences = sqliteTable("ai_preferences", {
  userKey: text("user_key").primaryKey(),
  dailyTokenBudget: integer("daily_token_budget").notNull().default(200000),
  maxOutputTokens: integer("max_output_tokens"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const voiceLearningMemories = sqliteTable("voice_learning_memories", {
  userKey: text("user_key").primaryKey(),
  revision: integer("revision").notNull().default(1),
  enabled: integer("enabled").notNull().default(1),
  notes: text("notes").notNull().default("[]"),
  recentTopics: text("recent_topics").notNull().default("[]"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});


export const learningJournalSettings = sqliteTable("learning_journal_settings", {
  userKey: text("user_key").primaryKey(), enabled: integer("enabled").notNull().default(1),
  revision: integer("revision").notNull().default(0), privacyRevision: integer("privacy_revision").notNull().default(0),
  suppressedBefore: text("suppressed_before").notNull().default(""), writeToken: text("write_token").notNull().default(""),
});
export const learningJournalEvents = sqliteTable("learning_journal_events", {
  userKey: text("user_key").notNull(), eventId: text("event_id").notNull(), date: text("date").notNull(),
  timezone: text("timezone").notNull(), occurredAt: text("occurred_at").notNull(), kind: text("kind").notNull(),
  title: text("title").notNull(), summary: text("summary").notNull(), refIds: text("ref_ids").notNull().default("[]"),
  counts: text("counts").notNull().default("{}"), contentHash: text("content_hash").notNull(),
  deleted: integer("deleted").notNull().default(0), edited: integer("edited").notNull().default(0),
}, table => [primaryKey({columns:[table.userKey,table.eventId]}),index("idx_learning_journal_events_day").on(table.userKey,table.date,table.deleted)]);
export const learningJournalDays = sqliteTable("learning_journal_days", {
  userKey: text("user_key").notNull(), date: text("date").notNull(), factsSummary: text("facts_summary").notNull().default(""),
  editedSummary: text("edited_summary"), deletedBefore: text("deleted_before").notNull().default(""), updatedAt:text("updated_at").notNull(),
}, table => [primaryKey({columns:[table.userKey,table.date]})]);
