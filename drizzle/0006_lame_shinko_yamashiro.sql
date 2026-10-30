CREATE TABLE `voice_learning_memories` (
	`user_key` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`notes` text DEFAULT '[]' NOT NULL,
	`recent_topics` text DEFAULT '[]' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
