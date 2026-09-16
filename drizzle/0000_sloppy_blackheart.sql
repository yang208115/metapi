CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`username` text,
	`access_token` text NOT NULL,
	`api_token` text,
	`balance` real DEFAULT 0,
	`balance_used` real DEFAULT 0,
	`quota` real DEFAULT 0,
	`unit_cost` real,
	`value_score` real DEFAULT 0,
	`status` text DEFAULT 'active',
	`checkin_enabled` integer DEFAULT true,
	`last_checkin_at` text,
	`last_balance_refresh` text,
	`extra_config` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `checkin_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`status` text NOT NULL,
	`message` text,
	`reward` text,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `model_availability` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`model_name` text NOT NULL,
	`available` integer,
	`latency_ms` integer,
	`checked_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `proxy_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`route_id` integer,
	`channel_id` integer,
	`account_id` integer,
	`model_requested` text,
	`model_actual` text,
	`status` text,
	`http_status` integer,
	`latency_ms` integer,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`total_tokens` integer,
	`estimated_cost` real,
	`error_message` text,
	`retry_count` integer DEFAULT 0,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `route_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`route_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`priority` integer DEFAULT 0,
	`weight` integer DEFAULT 10,
	`enabled` integer DEFAULT true,
	`manual_override` integer DEFAULT false,
	`success_count` integer DEFAULT 0,
	`fail_count` integer DEFAULT 0,
	`total_latency_ms` integer DEFAULT 0,
	`total_cost` real DEFAULT 0,
	`last_used_at` text,
	`last_fail_at` text,
	`cooldown_until` text,
	FOREIGN KEY (`route_id`) REFERENCES `token_routes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `sites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`platform` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`api_key` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `token_routes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model_pattern` text NOT NULL,
	`model_mapping` text,
	`enabled` integer DEFAULT true,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
