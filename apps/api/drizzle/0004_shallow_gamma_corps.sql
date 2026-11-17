CREATE TABLE `databases` (
	`name` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`username`) REFERENCES `accounts`(`username`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `databases_username` ON `databases` (`username`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `db_blocked` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `ftp_password_changed_at` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `redis_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `redis_memory_mb` integer DEFAULT 64 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `memcached_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `memcached_memory_mb` integer DEFAULT 64 NOT NULL;--> statement-breakpoint
ALTER TABLE `vhosts` ADD `php_options` text DEFAULT '{"children":5,"memoryMb":512,"indexFiles":"index.php, index.html","gzip":true,"htaccess":true,"directives":{"memory_limit":"256M","upload_max_filesize":"64M","post_max_size":"64M","max_execution_time":"60","max_input_time":"60","max_input_vars":"1000","session.gc_maxlifetime":"1440","date.timezone":"America/Argentina/Buenos_Aires","error_reporting":"E_ALL & ~E_DEPRECATED"},"flags":{"short_open_tag":false,"display_errors":false,"log_errors":true,"zlib.output_compression":true}}' NOT NULL;