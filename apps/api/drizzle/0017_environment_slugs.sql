-- Environments get an immutable numeric id, a visible name, a slug unique on the server and exactly one hostname.
-- Tables are rebuilt: openDb runs migrations with foreign keys off and checks them afterwards, otherwise dropping the
-- old vhosts table would delete every app in cascade.

-- Old name -> new id and slug. The slug is the first label of the name, letters and digits only; on a clash, or for a
-- reserved word, the id is appended.
CREATE TABLE `__vhost_map` (`fqdn` text PRIMARY KEY NOT NULL, `id` integer NOT NULL, `slug` text NOT NULL, `hostname` text NOT NULL);--> statement-breakpoint
INSERT INTO `__vhost_map` (`fqdn`, `id`, `slug`, `hostname`)
WITH numbered AS (
  SELECT `fqdn`, ROW_NUMBER() OVER (ORDER BY `created_at`, `fqdn`) AS `id`,
    substr(replace(lower(substr(`fqdn`, 1, instr(`fqdn`, '.') - 1)), '-', ''), 1, 28) AS `label`
  FROM `vhosts`
), labelled AS (
  SELECT *, COUNT(*) OVER (PARTITION BY `label`) AS `uses` FROM numbered
)
SELECT `labelled`.`fqdn`, `labelled`.`id`,
  CASE WHEN `uses` > 1 OR `label` IN ('', 'eaglepanel', 'example', 'eaglepanelhooks') THEN `label` || `labelled`.`id` ELSE `label` END,
  -- Its own name if it still answers for it; otherwise the first one assigned to it; with none, its own name.
  COALESCE(
    (SELECT `h`.`fqdn` FROM `hostnames` `h` WHERE `h`.`vhost` = `labelled`.`fqdn` AND `h`.`fqdn` = `labelled`.`fqdn`),
    (SELECT MIN(`h`.`fqdn`) FROM `hostnames` `h` WHERE `h`.`vhost` = `labelled`.`fqdn`),
    `labelled`.`fqdn`
  )
FROM labelled;--> statement-breakpoint

CREATE TABLE `__new_hostnames` (
	`fqdn` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`domain` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`username`) REFERENCES `accounts`(`username`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`domain`) REFERENCES `domains`(`fqdn`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_hostnames` (`fqdn`, `username`, `domain`, `created_at`) SELECT `fqdn`, `username`, `domain`, `created_at` FROM `hostnames`;--> statement-breakpoint
-- An environment left without any hostname gets its own name back, so that it still has one.
INSERT OR IGNORE INTO `__new_hostnames` (`fqdn`, `username`, `domain`, `created_at`)
SELECT `v`.`fqdn`, `v`.`username`, `v`.`domain`, `v`.`created_at` FROM `vhosts` `v` JOIN `__vhost_map` `m` ON `m`.`fqdn` = `v`.`fqdn` WHERE `m`.`hostname` = `v`.`fqdn`;--> statement-breakpoint

CREATE TABLE `__new_vhosts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`hostname` text NOT NULL,
	`type` text NOT NULL,
	`doc_root` text NOT NULL,
	`php_version` text NOT NULL,
	`php_options` text DEFAULT '{"children":5,"memoryMb":512,"indexFiles":"index.php, index.html","gzip":true,"htaccess":true,"directives":{"memory_limit":"256M","upload_max_filesize":"64M","post_max_size":"64M","max_execution_time":"60","max_input_time":"60","max_input_vars":"1000","session.gc_maxlifetime":"1440","date.timezone":"America/Argentina/Buenos_Aires","error_reporting":"E_ALL & ~E_DEPRECATED"},"flags":{"short_open_tag":false,"display_errors":false,"log_errors":true,"zlib.output_compression":true}}' NOT NULL,
	`log_level` text DEFAULT 'ERROR' NOT NULL,
	`log_days` integer DEFAULT 30 NOT NULL,
	`ftp_password_changed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`username`) REFERENCES `accounts`(`username`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`hostname`) REFERENCES `hostnames`(`fqdn`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
INSERT INTO `__new_vhosts` (`id`, `username`, `slug`, `name`, `hostname`, `type`, `doc_root`, `php_version`, `php_options`, `log_level`, `log_days`, `ftp_password_changed_at`, `created_at`)
SELECT `m`.`id`, `v`.`username`, `m`.`slug`, `m`.`hostname`, `m`.`hostname`, `v`.`type`,
  CASE WHEN substr(`v`.`doc_root`, 1, length('sites/' || `v`.`fqdn` || '/')) = 'sites/' || `v`.`fqdn` || '/'
    THEN 'sites/' || `m`.`slug` || substr(`v`.`doc_root`, length('sites/' || `v`.`fqdn`) + 1) ELSE `v`.`doc_root` END,
  `v`.`php_version`, `v`.`php_options`, `v`.`log_level`, `v`.`log_days`, `v`.`ftp_password_changed_at`, `v`.`created_at`
FROM `vhosts` `v` JOIN `__vhost_map` `m` ON `m`.`fqdn` = `v`.`fqdn`;--> statement-breakpoint

CREATE TABLE `__new_apps` (
	`vhost` integer PRIMARY KEY NOT NULL,
	`id` integer NOT NULL,
	`repo_url` text NOT NULL,
	`branch` text NOT NULL,
	`subdir` text DEFAULT '' NOT NULL,
	`runtime` text NOT NULL,
	`runtime_version` text NOT NULL,
	`kind` text DEFAULT 'server' NOT NULL,
	`build_command` text NOT NULL,
	`start_command` text NOT NULL,
	`output_dir` text DEFAULT '' NOT NULL,
	`spa_fallback` integer DEFAULT true NOT NULL,
	`health_path` text NOT NULL,
	`memory_mb` integer NOT NULL,
	`status` text NOT NULL,
	`current_release` integer,
	`commit` text,
	`deploy_key` text,
	`webhook_secret` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`vhost`) REFERENCES `vhosts`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_apps` (`vhost`, `id`, `repo_url`, `branch`, `subdir`, `runtime`, `runtime_version`, `kind`, `build_command`, `start_command`, `output_dir`, `spa_fallback`, `health_path`, `memory_mb`, `status`, `current_release`, `commit`, `deploy_key`, `webhook_secret`, `created_at`)
SELECT `m`.`id`, `a`.`id`, `a`.`repo_url`, `a`.`branch`, `a`.`subdir`, `a`.`runtime`, `a`.`runtime_version`, `a`.`kind`, `a`.`build_command`, `a`.`start_command`, `a`.`output_dir`, `a`.`spa_fallback`, `a`.`health_path`, `a`.`memory_mb`, `a`.`status`, `a`.`current_release`, `a`.`commit`, `a`.`deploy_key`, `a`.`webhook_secret`, `a`.`created_at`
FROM `apps` `a` JOIN `__vhost_map` `m` ON `m`.`fqdn` = `a`.`fqdn`;--> statement-breakpoint

CREATE TABLE `__new_app_env` (
	`vhost` integer NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`vhost`, `key`),
	FOREIGN KEY (`vhost`) REFERENCES `apps`(`vhost`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_app_env` (`vhost`, `key`, `value`, `scope`) SELECT `m`.`id`, `e`.`key`, `e`.`value`, `e`.`scope` FROM `app_env` `e` JOIN `__vhost_map` `m` ON `m`.`fqdn` = `e`.`fqdn`;--> statement-breakpoint

CREATE TABLE `__new_deployments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vhost` integer NOT NULL,
	`release` integer NOT NULL,
	`kind` text DEFAULT 'server' NOT NULL,
	`commit` text,
	`message` text,
	`status` text NOT NULL,
	`log` text DEFAULT '' NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`vhost`) REFERENCES `apps`(`vhost`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_deployments` (`id`, `vhost`, `release`, `kind`, `commit`, `message`, `status`, `log`, `started_at`, `finished_at`)
SELECT `d`.`id`, `m`.`id`, `d`.`release`, `d`.`kind`, `d`.`commit`, `d`.`message`, `d`.`status`, `d`.`log`, `d`.`started_at`, `d`.`finished_at`
FROM `deployments` `d` JOIN `__vhost_map` `m` ON `m`.`fqdn` = `d`.`fqdn`;--> statement-breakpoint

CREATE TABLE `__new_deploy_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vhost` integer NOT NULL,
	`trigger` text NOT NULL,
	`commit` text,
	`requested_at` integer NOT NULL,
	FOREIGN KEY (`vhost`) REFERENCES `apps`(`vhost`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_deploy_queue` (`id`, `vhost`, `trigger`, `commit`, `requested_at`)
SELECT `q`.`id`, `m`.`id`, `q`.`trigger`, `q`.`commit`, `q`.`requested_at` FROM `deploy_queue` `q` JOIN `__vhost_map` `m` ON `m`.`fqdn` = `q`.`fqdn`;--> statement-breakpoint

ALTER TABLE `accounts` ADD `hook_vhost` integer REFERENCES vhosts(id) ON DELETE set null;--> statement-breakpoint
UPDATE `accounts` SET `hook_vhost` = (SELECT `m`.`id` FROM `__vhost_map` `m` WHERE `m`.`fqdn` = `accounts`.`hook_domain`);--> statement-breakpoint
ALTER TABLE `accounts` DROP COLUMN `hook_domain`;--> statement-breakpoint

DROP TABLE `deploy_queue`;--> statement-breakpoint
DROP TABLE `deployments`;--> statement-breakpoint
DROP TABLE `app_env`;--> statement-breakpoint
DROP TABLE `apps`;--> statement-breakpoint
DROP TABLE `hostnames`;--> statement-breakpoint
DROP TABLE `vhosts`;--> statement-breakpoint
DROP TABLE `__vhost_map`;--> statement-breakpoint
ALTER TABLE `__new_hostnames` RENAME TO `hostnames`;--> statement-breakpoint
ALTER TABLE `__new_vhosts` RENAME TO `vhosts`;--> statement-breakpoint
ALTER TABLE `__new_apps` RENAME TO `apps`;--> statement-breakpoint
ALTER TABLE `__new_app_env` RENAME TO `app_env`;--> statement-breakpoint
ALTER TABLE `__new_deployments` RENAME TO `deployments`;--> statement-breakpoint
ALTER TABLE `__new_deploy_queue` RENAME TO `deploy_queue`;--> statement-breakpoint
CREATE INDEX `hostnames_username` ON `hostnames` (`username`);--> statement-breakpoint
CREATE INDEX `hostnames_domain` ON `hostnames` (`domain`);--> statement-breakpoint
CREATE UNIQUE INDEX `vhosts_slug_unique` ON `vhosts` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `vhosts_hostname_unique` ON `vhosts` (`hostname`);--> statement-breakpoint
CREATE INDEX `vhosts_username` ON `vhosts` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `apps_id_unique` ON `apps` (`id`);--> statement-breakpoint
CREATE INDEX `deployments_vhost` ON `deployments` (`vhost`);--> statement-breakpoint
CREATE INDEX `deploy_queue_vhost` ON `deploy_queue` (`vhost`);
