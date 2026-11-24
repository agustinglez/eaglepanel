-- Mail: domains with mail, their mailboxes and forwarders. Stalwart holds the mail and the passwords.
CREATE TABLE `mail_domains` (
	`domain` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`catch_all` text,
	`cert_not_after` integer,
	`cert_error` text,
	`cert_attempt_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`domain`) REFERENCES `domains`(`fqdn`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`username`) REFERENCES `accounts`(`username`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mail_domains_username` ON `mail_domains` (`username`);--> statement-breakpoint
CREATE TABLE `mail_forwarders` (
	`address` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`name` text NOT NULL,
	`recipients` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`domain`) REFERENCES `mail_domains`(`domain`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mail_forwarders_domain` ON `mail_forwarders` (`domain`);--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`address` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`name` text NOT NULL,
	`quota_mb` integer NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`password_changed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`domain`) REFERENCES `mail_domains`(`domain`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mailboxes_domain` ON `mailboxes` (`domain`);