ALTER TABLE `vhosts` ADD `log_level` text DEFAULT 'ERROR' NOT NULL;--> statement-breakpoint
ALTER TABLE `vhosts` ADD `log_days` integer DEFAULT 30 NOT NULL;