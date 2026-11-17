CREATE TABLE `vhosts` (
	`fqdn` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`domain` text NOT NULL,
	`is_main` integer NOT NULL,
	`type` text NOT NULL,
	`doc_root` text NOT NULL,
	`php_version` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`username`) REFERENCES `accounts`(`username`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`domain`) REFERENCES `domains`(`fqdn`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `vhosts_username` ON `vhosts` (`username`);--> statement-breakpoint
CREATE INDEX `vhosts_domain` ON `vhosts` (`domain`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `max_domains` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `max_vhosts` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `max_databases` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `db_storage_mb` integer DEFAULT 1024 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `app_memory_mb` integer DEFAULT 512 NOT NULL;--> statement-breakpoint
INSERT INTO `vhosts` (`fqdn`, `username`, `domain`, `is_main`, `type`, `doc_root`, `php_version`, `created_at`)
SELECT d.`fqdn`, d.`username`, p.`fqdn`, d.`kind` = 'primary', 'php',
  CASE WHEN d.`kind` = 'primary' THEN 'public_html' ELSE 'subdomains/' || d.`fqdn` || '/public_html' END,
  d.`php_version`, d.`created_at`
FROM `domains` d JOIN `domains` p ON p.`username` = d.`username` AND p.`kind` = 'primary';--> statement-breakpoint
DELETE FROM `domains` WHERE `kind` <> 'primary';
