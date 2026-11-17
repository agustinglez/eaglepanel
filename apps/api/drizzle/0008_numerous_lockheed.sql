CREATE TABLE `app_env` (
	`fqdn` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`fqdn`, `key`),
	FOREIGN KEY (`fqdn`) REFERENCES `apps`(`fqdn`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `apps` (
	`fqdn` text PRIMARY KEY NOT NULL,
	`id` integer NOT NULL,
	`repo_url` text NOT NULL,
	`branch` text NOT NULL,
	`subdir` text DEFAULT '' NOT NULL,
	`runtime` text NOT NULL,
	`runtime_version` text NOT NULL,
	`install_command` text NOT NULL,
	`build_command` text NOT NULL,
	`start_command` text NOT NULL,
	`health_path` text NOT NULL,
	`memory_mb` integer NOT NULL,
	`status` text NOT NULL,
	`current_release` integer,
	`commit` text,
	`deploy_key` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`fqdn`) REFERENCES `vhosts`(`fqdn`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apps_id_unique` ON `apps` (`id`);--> statement-breakpoint
CREATE TABLE `deployments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fqdn` text NOT NULL,
	`release` integer NOT NULL,
	`commit` text,
	`message` text,
	`status` text NOT NULL,
	`log` text DEFAULT '' NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`fqdn`) REFERENCES `apps`(`fqdn`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deployments_fqdn` ON `deployments` (`fqdn`);