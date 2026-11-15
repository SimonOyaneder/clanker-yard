CREATE TABLE `projects` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`tracker` text NOT NULL,
	`tracker_ref` text NOT NULL,
	`default_flow_id` text,
	`default_profile_id` text,
	`parallel` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`flow_params` text NOT NULL,
	CONSTRAINT "projects_parallel_positive" CHECK("parallel" >= 1),
	CONSTRAINT "projects_flow_params_json" CHECK(json_valid("flow_params"))
);
--> statement-breakpoint
CREATE TABLE `repos` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`default_branch` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug` ON `projects` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_tracker_ref` ON `projects` (`tracker`,`tracker_ref`);--> statement-breakpoint
CREATE UNIQUE INDEX `repos_path` ON `repos` (`path`);