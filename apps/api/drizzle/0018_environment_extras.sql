-- Extra names of an environment: alias or redirect. Deleting the environment frees them.
ALTER TABLE `hostnames` ADD `vhost` integer REFERENCES vhosts(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `hostnames` ADD `mode` text;--> statement-breakpoint
CREATE INDEX `hostnames_vhost` ON `hostnames` (`vhost`);