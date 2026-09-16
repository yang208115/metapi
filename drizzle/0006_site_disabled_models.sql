CREATE TABLE IF NOT EXISTS `site_disabled_models` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`model_name` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `site_disabled_models_site_model_unique`
ON `site_disabled_models` (`site_id`, `model_name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `site_disabled_models_site_id_idx`
ON `site_disabled_models` (`site_id`);
