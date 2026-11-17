ALTER TABLE `apps` ADD `kind` text DEFAULT 'server' NOT NULL;--> statement-breakpoint
ALTER TABLE `apps` ADD `output_dir` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `apps` ADD `spa_fallback` integer DEFAULT true NOT NULL;