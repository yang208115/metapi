CREATE TABLE IF NOT EXISTS `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`message` text,
	`level` text DEFAULT 'info' NOT NULL,
	`read` integer DEFAULT false,
	`related_id` integer,
	`related_type` text,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sites_status_idx` ON `sites` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `accounts_site_id_idx` ON `accounts` (`site_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `accounts_status_idx` ON `accounts` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `accounts_site_status_idx` ON `accounts` (`site_id`,`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `account_tokens_account_id_idx` ON `account_tokens` (`account_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `account_tokens_account_enabled_idx` ON `account_tokens` (`account_id`,`enabled`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `account_tokens_enabled_idx` ON `account_tokens` (`enabled`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `checkin_logs_account_created_at_idx` ON `checkin_logs` (`account_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `checkin_logs_created_at_idx` ON `checkin_logs` (`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `checkin_logs_status_idx` ON `checkin_logs` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `model_availability_account_available_idx` ON `model_availability` (`account_id`,`available`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `model_availability_model_name_idx` ON `model_availability` (`model_name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `token_model_availability_token_available_idx` ON `token_model_availability` (`token_id`,`available`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `token_model_availability_model_name_idx` ON `token_model_availability` (`model_name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `token_model_availability_available_idx` ON `token_model_availability` (`available`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `token_routes_model_pattern_idx` ON `token_routes` (`model_pattern`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `token_routes_enabled_idx` ON `token_routes` (`enabled`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `route_channels_route_id_idx` ON `route_channels` (`route_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `route_channels_account_id_idx` ON `route_channels` (`account_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `route_channels_token_id_idx` ON `route_channels` (`token_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `route_channels_route_enabled_idx` ON `route_channels` (`route_id`,`enabled`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `route_channels_route_token_idx` ON `route_channels` (`route_id`,`token_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `proxy_logs_created_at_idx` ON `proxy_logs` (`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `proxy_logs_account_created_at_idx` ON `proxy_logs` (`account_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `proxy_logs_status_created_at_idx` ON `proxy_logs` (`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `proxy_logs_model_actual_created_at_idx` ON `proxy_logs` (`model_actual`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `events_read_created_at_idx` ON `events` (`read`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `events_type_created_at_idx` ON `events` (`type`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `events_created_at_idx` ON `events` (`created_at`);
