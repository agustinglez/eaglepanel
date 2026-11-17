CREATE TABLE `deploy_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fqdn` text NOT NULL,
	`trigger` text NOT NULL,
	`commit` text,
	`requested_at` integer NOT NULL,
	FOREIGN KEY (`fqdn`) REFERENCES `apps`(`fqdn`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deploy_queue_fqdn` ON `deploy_queue` (`fqdn`);