CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `accounts` ADD `hook_domain` text;--> statement-breakpoint
ALTER TABLE `apps` ADD `webhook_secret` text;