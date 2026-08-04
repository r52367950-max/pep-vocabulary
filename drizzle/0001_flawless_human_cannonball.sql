CREATE TABLE `ai_provider_config` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`base_url` text NOT NULL,
	`model` text NOT NULL,
	`api_key_ciphertext` text NOT NULL,
	`api_key_iv` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_rate_limits` (
	`bucket_key` text PRIMARY KEY NOT NULL,
	`request_count` integer DEFAULT 1 NOT NULL,
	`expires_at` integer NOT NULL
);
