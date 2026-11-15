CREATE TABLE `project_repos` (
	`project_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`ord` integer NOT NULL,
	`labels` text NOT NULL,
	CONSTRAINT `project_repos_pk` PRIMARY KEY(`project_id`, `repo_id`),
	CONSTRAINT `fk_project_repos_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT `fk_project_repos_repo_id_repos_id_fk` FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`),
	CONSTRAINT "project_repos_labels_json" CHECK(json_valid("labels"))
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `queue_filter` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `conventions` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `max_cost_usd` real;--> statement-breakpoint
ALTER TABLE `repos` ADD `remote` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_projects` (
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
	`queue_filter` text DEFAULT '{}' NOT NULL,
	`conventions` text DEFAULT '{}' NOT NULL,
	`max_cost_usd` real,
	CONSTRAINT "projects_parallel_positive" CHECK("parallel" >= 1),
	CONSTRAINT "projects_flow_params_json" CHECK(json_valid("flow_params")),
	CONSTRAINT "projects_queue_filter_json" CHECK(json_valid("queue_filter")),
	CONSTRAINT "projects_conventions_json" CHECK(json_valid("conventions"))
);
--> statement-breakpoint
INSERT INTO `__new_projects`(`id`, `slug`, `name`, `tracker`, `tracker_ref`, `default_flow_id`, `default_profile_id`, `parallel`, `status`, `flow_params`) SELECT `id`, `slug`, `name`, `tracker`, `tracker_ref`, `default_flow_id`, `default_profile_id`, `parallel`, `status`, `flow_params` FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug` ON `projects` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_tracker_ref` ON `projects` (`tracker`,`tracker_ref`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_repos_ord` ON `project_repos` (`project_id`,`ord`);