ALTER TABLE `sites` ADD `proxy_url` text;
--> statement-breakpoint
ALTER TABLE `sites` ADD `use_system_proxy` integer DEFAULT false;
--> statement-breakpoint
UPDATE `sites`
SET `use_system_proxy` = false
WHERE `use_system_proxy` IS NULL;
--> statement-breakpoint
ALTER TABLE `sites` ADD `custom_headers` text;
--> statement-breakpoint
ALTER TABLE `sites` ADD `external_checkin_url` text;
--> statement-breakpoint
ALTER TABLE `sites` ADD `global_weight` real DEFAULT 1;
--> statement-breakpoint
UPDATE `sites`
SET `global_weight` = 1
WHERE `global_weight` IS NULL
  OR `global_weight` <= 0;
--> statement-breakpoint
ALTER TABLE `token_routes` ADD `display_name` text;
--> statement-breakpoint
ALTER TABLE `token_routes` ADD `display_icon` text;
--> statement-breakpoint
ALTER TABLE `token_routes` ADD `decision_snapshot` text;
--> statement-breakpoint
ALTER TABLE `token_routes` ADD `decision_refreshed_at` text;
--> statement-breakpoint
ALTER TABLE `token_routes` ADD `routing_strategy` text DEFAULT 'weighted';
--> statement-breakpoint
ALTER TABLE `route_channels` ADD `source_model` text;
--> statement-breakpoint
ALTER TABLE `route_channels` ADD `last_selected_at` text;
--> statement-breakpoint
ALTER TABLE `route_channels` ADD `consecutive_fail_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `route_channels` ADD `cooldown_level` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `downstream_api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`key` text NOT NULL,
	`description` text,
	`enabled` integer DEFAULT true,
	`expires_at` text,
	`max_cost` real,
	`used_cost` real DEFAULT 0,
	`max_requests` integer,
	`used_requests` integer DEFAULT 0,
	`supported_models` text,
	`allowed_route_ids` text,
	`site_weight_multipliers` text,
	`last_used_at` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `downstream_api_keys_key_unique`
ON `downstream_api_keys` (`key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `downstream_api_keys_name_idx`
ON `downstream_api_keys` (`name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `downstream_api_keys_enabled_idx`
ON `downstream_api_keys` (`enabled`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `downstream_api_keys_expires_at_idx`
ON `downstream_api_keys` (`expires_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `proxy_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`purpose` text,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`content_base64` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	`deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `proxy_files_public_id_unique`
ON `proxy_files` (`public_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `proxy_files_owner_lookup_idx`
ON `proxy_files` (`owner_type`, `owner_id`, `deleted_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `proxy_video_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`upstream_video_id` text NOT NULL,
	`site_url` text NOT NULL,
	`token_value` text NOT NULL,
	`requested_model` text,
	`actual_model` text,
	`channel_id` integer,
	`account_id` integer,
	`status_snapshot` text,
	`upstream_response_meta` text,
	`last_upstream_status` integer,
	`last_polled_at` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `proxy_video_tasks_public_id_unique`
ON `proxy_video_tasks` (`public_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `proxy_video_tasks_upstream_video_id_idx`
ON `proxy_video_tasks` (`upstream_video_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `proxy_video_tasks_created_at_idx`
ON `proxy_video_tasks` (`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `model_availability_account_model_unique`
ON `model_availability` (`account_id`, `model_name`);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_route_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`route_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`token_id` integer,
	`source_model` text,
	`priority` integer DEFAULT 0,
	`weight` integer DEFAULT 10,
	`enabled` integer DEFAULT true,
	`manual_override` integer DEFAULT false,
	`success_count` integer DEFAULT 0,
	`fail_count` integer DEFAULT 0,
	`total_latency_ms` integer DEFAULT 0,
	`total_cost` real DEFAULT 0,
	`last_used_at` text,
	`last_selected_at` text,
	`last_fail_at` text,
	`consecutive_fail_count` integer NOT NULL DEFAULT 0,
	`cooldown_level` integer NOT NULL DEFAULT 0,
	`cooldown_until` text,
	FOREIGN KEY (`route_id`) REFERENCES `token_routes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`token_id`) REFERENCES `account_tokens`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_route_channels` (
	`id`,
	`route_id`,
	`account_id`,
	`token_id`,
	`source_model`,
	`priority`,
	`weight`,
	`enabled`,
	`manual_override`,
	`success_count`,
	`fail_count`,
	`total_latency_ms`,
	`total_cost`,
	`last_used_at`,
	`last_selected_at`,
	`last_fail_at`,
	`consecutive_fail_count`,
	`cooldown_level`,
	`cooldown_until`
)
SELECT
	`id`,
	`route_id`,
	`account_id`,
	CASE
		WHEN `token_id` IS NULL THEN NULL
		WHEN EXISTS (SELECT 1 FROM `account_tokens` WHERE `account_tokens`.`id` = `route_channels`.`token_id`) THEN `token_id`
		ELSE NULL
	END,
	`source_model`,
	`priority`,
	`weight`,
	`enabled`,
	`manual_override`,
	`success_count`,
	`fail_count`,
	`total_latency_ms`,
	`total_cost`,
	`last_used_at`,
	`last_selected_at`,
	`last_fail_at`,
	`consecutive_fail_count`,
	`cooldown_level`,
	`cooldown_until`
FROM `route_channels`;
--> statement-breakpoint
DROP TABLE `route_channels`;
--> statement-breakpoint
ALTER TABLE `__new_route_channels` RENAME TO `route_channels`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `route_channels_route_id_idx`
ON `route_channels` (`route_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `route_channels_account_id_idx`
ON `route_channels` (`account_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `route_channels_token_id_idx`
ON `route_channels` (`token_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `route_channels_route_enabled_idx`
ON `route_channels` (`route_id`, `enabled`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `route_channels_route_token_idx`
ON `route_channels` (`route_id`, `token_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
