ALTER TABLE `sites` ADD COLUMN `is_pinned` integer DEFAULT false;
--> statement-breakpoint
ALTER TABLE `sites` ADD COLUMN `sort_order` integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `accounts` ADD COLUMN `is_pinned` integer DEFAULT false;
--> statement-breakpoint
ALTER TABLE `accounts` ADD COLUMN `sort_order` integer DEFAULT 0;
