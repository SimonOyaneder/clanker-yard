CREATE TABLE `sync_cursors` (
	`key` text PRIMARY KEY,
	`etag` text,
	`cursor` text,
	`checked_at` integer NOT NULL,
	`rate_remaining` integer,
	`reset_at` integer
);
