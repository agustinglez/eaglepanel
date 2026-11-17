CREATE TABLE `account_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`status` text NOT NULL,
	`size_bytes` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`username`) REFERENCES `accounts`(`username`) ON UPDATE no action ON DELETE cascade
);
