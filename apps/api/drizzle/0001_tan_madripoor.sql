CREATE TABLE `accounts` (
	`username` text PRIMARY KEY NOT NULL,
	`quota_mb` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `certificates` (
	`zone` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`names` text NOT NULL,
	`not_after` integer NOT NULL,
	FOREIGN KEY (`username`) REFERENCES `accounts`(`username`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `domains` (
	`fqdn` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`kind` text NOT NULL,
	`php_version` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`username`) REFERENCES `accounts`(`username`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `domains_username` ON `domains` (`username`);