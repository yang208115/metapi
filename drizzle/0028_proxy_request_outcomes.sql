CREATE TABLE `proxy_request_outcomes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text NOT NULL,
	`downstream_path` text NOT NULL,
	`model_requested` text,
	`site_id` integer,
	`account_id` integer,
	`channel_id` integer,
	`status` text NOT NULL,
	`http_status` integer,
	`latency_ms` integer NOT NULL,
	`first_byte_latency_ms` integer,
	`attempt_count` integer NOT NULL,
	`failed_attempt_count` integer NOT NULL,
	`total_tokens` integer,
	`estimated_cost` real,
	`error_class` text,
	`is_stream` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `proxy_request_outcomes_request_id_idx` ON `proxy_request_outcomes` (`request_id`);
--> statement-breakpoint
CREATE INDEX `proxy_request_outcomes_started_at_idx` ON `proxy_request_outcomes` (`started_at`);
--> statement-breakpoint
CREATE INDEX `proxy_request_outcomes_completed_at_idx` ON `proxy_request_outcomes` (`completed_at`);
--> statement-breakpoint
CREATE INDEX `proxy_request_outcomes_status_completed_idx` ON `proxy_request_outcomes` (`status`,`completed_at`);
--> statement-breakpoint
CREATE INDEX `proxy_request_outcomes_site_completed_idx` ON `proxy_request_outcomes` (`site_id`,`completed_at`);
