CREATE TABLE `learnings` (
	`id` text PRIMARY KEY,
	`project_id` text,
	`repo_id` text,
	`text` text NOT NULL,
	`roles` text NOT NULL,
	`tags` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`source_run_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "learnings_one_scope" CHECK(("project_id" IS NULL) != ("repo_id" IS NULL)),
	CONSTRAINT "learnings_roles_json" CHECK(json_valid("roles")),
	CONSTRAINT "learnings_tags_json" CHECK(json_valid("tags"))
);
--> statement-breakpoint
CREATE INDEX `learnings_project_status` ON `learnings` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `learnings_repo_status` ON `learnings` (`repo_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `learnings_scope_text` ON `learnings` (coalesce("project_id", ''),coalesce("repo_id", ''),`text`);