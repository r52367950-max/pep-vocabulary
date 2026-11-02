CREATE TABLE `learning_journal_days` (
	`user_key` text NOT NULL,
	`date` text NOT NULL,
	`facts_summary` text DEFAULT '' NOT NULL,
	`edited_summary` text,
	`deleted_before` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_key`, `date`)
);

--> statement-breakpoint
CREATE TABLE `learning_journal_events` (
	`user_key` text NOT NULL,
	`event_id` text NOT NULL,
	`date` text NOT NULL,
	`timezone` text NOT NULL,
	`occurred_at` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`ref_ids` text DEFAULT '[]' NOT NULL,
	`counts` text DEFAULT '{}' NOT NULL,
	`content_hash` text NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	`edited` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_key`, `event_id`)
);

--> statement-breakpoint
CREATE INDEX `idx_learning_journal_events_day` ON `learning_journal_events` (`user_key`,`date`,`deleted`);
--> statement-breakpoint
CREATE TABLE `learning_journal_settings` (
	`user_key` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`privacy_revision` integer DEFAULT 0 NOT NULL,
	`suppressed_before` text DEFAULT '' NOT NULL,
	`write_token` text DEFAULT '' NOT NULL
);

