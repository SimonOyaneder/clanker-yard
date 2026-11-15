CREATE TABLE `pull_requests` (
	`id` text PRIMARY KEY,
	`repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`node_id` text NOT NULL,
	`head_ref` text NOT NULL,
	`base_ref` text NOT NULL,
	`head_sha` text NOT NULL,
	`state` text NOT NULL,
	`is_draft` integer NOT NULL,
	`issue_id` text,
	`run_id` text,
	`owned` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_repo_number` ON `pull_requests` (`repo_id`,`number`);