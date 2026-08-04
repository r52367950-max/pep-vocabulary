CREATE TABLE `ai_rate_limits` (
	`bucket_key` text PRIMARY KEY NOT NULL,
	`request_count` integer DEFAULT 1 NOT NULL,
	`expires_at` integer NOT NULL
);
