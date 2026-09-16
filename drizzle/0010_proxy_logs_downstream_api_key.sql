ALTER TABLE `proxy_logs` ADD `downstream_api_key_id` integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `proxy_logs_downstream_api_key_created_at_idx` ON `proxy_logs` (`downstream_api_key_id`, `created_at`);
