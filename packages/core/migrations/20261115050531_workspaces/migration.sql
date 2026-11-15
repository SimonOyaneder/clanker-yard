CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY,
	`repo_id` text NOT NULL,
	`path` text NOT NULL,
	`branch` text NOT NULL,
	`base_ref` text NOT NULL,
	`base_sha` text,
	`head_sha` text,
	`remote_sha` text,
	`state` text NOT NULL,
	`holder_run_id` text,
	`lease_until` integer,
	`fencing_token` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_path` ON `workspaces` (`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_repo_branch_live` ON `workspaces` (`repo_id`,`branch`) WHERE "workspaces"."state" != 'archived';