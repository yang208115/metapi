CREATE TABLE IF NOT EXISTS `token_model_availability` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_id` integer NOT NULL,
	`model_name` text NOT NULL,
	`available` integer,
	`latency_ms` integer,
	`checked_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`token_id`) REFERENCES `account_tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `token_model_availability_token_model_unique`
ON `token_model_availability` (`token_id`, `model_name`);
