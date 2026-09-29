CREATE TABLE IF NOT EXISTS `ai_preferences` (
	`user_key` text PRIMARY KEY NOT NULL,
	`daily_token_budget` integer DEFAULT 200000 NOT NULL,
	`max_output_tokens` integer,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
