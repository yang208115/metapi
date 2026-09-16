CREATE TABLE IF NOT EXISTS `account_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`name` text NOT NULL,
	`token` text NOT NULL,
	`source` text DEFAULT 'manual',
	`enabled` integer DEFAULT true,
	`is_default` integer DEFAULT false,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `route_channels` ADD COLUMN `token_id` integer;
--> statement-breakpoint
INSERT INTO `account_tokens` (`account_id`, `name`, `token`, `source`, `enabled`, `is_default`, `created_at`, `updated_at`)
SELECT
	`a`.`id`,
	'default',
	`a`.`api_token`,
	'legacy',
	true,
	true,
	datetime('now'),
	datetime('now')
FROM `accounts` AS `a`
WHERE
	`a`.`api_token` IS NOT NULL
	AND trim(`a`.`api_token`) <> ''
	AND NOT EXISTS (
		SELECT 1 FROM `account_tokens` AS `t`
		WHERE `t`.`account_id` = `a`.`id`
		AND `t`.`token` = `a`.`api_token`
	);

