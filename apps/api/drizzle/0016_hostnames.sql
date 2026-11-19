CREATE TABLE `hostnames` (
	`fqdn` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`domain` text NOT NULL,
	`vhost` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`username`) REFERENCES `accounts`(`username`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`domain`) REFERENCES `domains`(`fqdn`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`vhost`) REFERENCES `vhosts`(`fqdn`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `hostnames_username` ON `hostnames` (`username`);--> statement-breakpoint
CREATE INDEX `hostnames_vhost` ON `hostnames` (`vhost`);--> statement-breakpoint
-- Until now each environment was its own hostname: it keeps answering for exactly that name.
INSERT INTO `hostnames` (`fqdn`, `username`, `domain`, `vhost`, `created_at`) SELECT `fqdn`, `username`, `domain`, `fqdn`, `created_at` FROM `vhosts`;--> statement-breakpoint
ALTER TABLE `vhosts` DROP COLUMN `is_main`;