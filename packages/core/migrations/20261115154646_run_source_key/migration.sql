ALTER TABLE `runs` ADD `source_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `runs_source_key` ON `runs` (`source_key`);