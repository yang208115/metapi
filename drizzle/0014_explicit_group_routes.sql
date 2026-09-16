ALTER TABLE `token_routes` ADD `route_mode` text DEFAULT 'pattern';
--> statement-breakpoint
CREATE TABLE `route_group_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_route_id` integer NOT NULL,
	`source_route_id` integer NOT NULL,
	FOREIGN KEY (`group_route_id`) REFERENCES `token_routes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_route_id`) REFERENCES `token_routes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `route_group_sources_group_source_unique` ON `route_group_sources` (`group_route_id`,`source_route_id`);
--> statement-breakpoint
CREATE INDEX `route_group_sources_source_route_id_idx` ON `route_group_sources` (`source_route_id`);
