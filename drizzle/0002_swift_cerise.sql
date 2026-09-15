CREATE TABLE IF NOT EXISTS `ai_configs` (
	`user_key` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'deepseek' NOT NULL,
	`base_url` text DEFAULT 'https://api.deepseek.com/v1' NOT NULL,
	`model` text DEFAULT 'deepseek-v4-flash' NOT NULL,
	`daily_limit` integer DEFAULT 30 NOT NULL,
	`timeout_seconds` integer DEFAULT 25 NOT NULL,
	`encrypted_api_key` text NOT NULL,
	`key_iv` text NOT NULL,
	`encryption_version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
