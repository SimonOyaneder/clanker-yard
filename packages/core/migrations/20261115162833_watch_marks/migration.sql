CREATE TABLE `watch_marks` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`pr_id` text NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_watch_marks_pr_id_pull_requests_id_fk` FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watch_marks_pr_kind_key` ON `watch_marks` (`pr_id`,`kind`,`key`);