CREATE TABLE IF NOT EXISTS `sync_states` (
	`user_key` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`schema_version` text NOT NULL,
	`payload` text NOT NULL,
	`client_updated_at` text NOT NULL,
	`server_updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
