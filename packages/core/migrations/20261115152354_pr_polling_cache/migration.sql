ALTER TABLE `pull_requests` ADD `detail` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `detail_at` integer;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `head_changed_at` integer;--> statement-breakpoint
ALTER TABLE `sync_cursors` ADD `rate_limit` integer;