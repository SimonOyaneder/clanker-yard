PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_merge_offers` (
	`decision_id` text PRIMARY KEY,
	`pr_id` text NOT NULL,
	`head_sha` text NOT NULL,
	CONSTRAINT `fk_merge_offers_pr_id_pull_requests_id_fk` FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_merge_offers`(`decision_id`, `pr_id`, `head_sha`) SELECT `decision_id`, `pr_id`, `head_sha` FROM `merge_offers`;--> statement-breakpoint
DROP TABLE `merge_offers`;--> statement-breakpoint
ALTER TABLE `__new_merge_offers` RENAME TO `merge_offers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pr_parents` (
	`child_id` text NOT NULL,
	`parent_id` text NOT NULL,
	CONSTRAINT `pr_parents_pk` PRIMARY KEY(`child_id`, `parent_id`),
	CONSTRAINT `fk_pr_parents_child_id_pull_requests_id_fk` FOREIGN KEY (`child_id`) REFERENCES `pull_requests`(`id`),
	CONSTRAINT `fk_pr_parents_parent_id_pull_requests_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `pull_requests`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_pr_parents`(`child_id`, `parent_id`) SELECT `child_id`, `parent_id` FROM `pr_parents`;--> statement-breakpoint
DROP TABLE `pr_parents`;--> statement-breakpoint
ALTER TABLE `__new_pr_parents` RENAME TO `pr_parents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_watch_marks` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`pr_id` text NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_watch_marks_pr_id_pull_requests_id_fk` FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_watch_marks`(`id`, `pr_id`, `kind`, `key`, `created_at`) SELECT `id`, `pr_id`, `kind`, `key`, `created_at` FROM `watch_marks`;--> statement-breakpoint
DROP TABLE `watch_marks`;--> statement-breakpoint
ALTER TABLE `__new_watch_marks` RENAME TO `watch_marks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`tracker` text NOT NULL,
	`tracker_ref` text NOT NULL,
	`tracker_account` text,
	`default_flow_id` text,
	`default_profile_id` text,
	`parallel` integer DEFAULT 1 NOT NULL,
	`stack_on` text DEFAULT 'ci_green' NOT NULL,
	`stack_mode` text DEFAULT 'local' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`flow_params` text NOT NULL,
	`queue_filter` text DEFAULT '{}' NOT NULL,
	`conventions` text DEFAULT '{}' NOT NULL,
	`max_cost_usd` real,
	`status_mapping` text DEFAULT '{}' NOT NULL,
	CONSTRAINT "projects_parallel_positive" CHECK("parallel" >= 1),
	CONSTRAINT "projects_flow_params_json" CHECK(json_valid("flow_params")),
	CONSTRAINT "projects_queue_filter_json" CHECK(json_valid("queue_filter")),
	CONSTRAINT "projects_conventions_json" CHECK(json_valid("conventions"))
);
--> statement-breakpoint
INSERT INTO `__new_projects`(`id`, `slug`, `name`, `tracker`, `tracker_ref`, `tracker_account`, `default_flow_id`, `default_profile_id`, `parallel`, `stack_on`, `status`, `flow_params`, `queue_filter`, `conventions`, `max_cost_usd`, `status_mapping`, `stack_mode`) SELECT `id`, `slug`, `name`, `tracker`, `tracker_ref`, `tracker_account`, `default_flow_id`, `default_profile_id`, `parallel`, `stack_on`, `status`, `flow_params`, `queue_filter`, `conventions`, `max_cost_usd`, `status_mapping`, `stack_mode` FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `merge_offers_pr` ON `merge_offers` (`pr_id`);--> statement-breakpoint
CREATE INDEX `pr_parents_parent` ON `pr_parents` (`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `watch_marks_pr_kind_key` ON `watch_marks` (`pr_id`,`kind`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug` ON `projects` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_tracker_ref` ON `projects` (`tracker`,`tracker_ref`);--> statement-breakpoint
-- Stacks locales pasa a ser el default (CLA-119): los proyectos que ya existen también. Los PRs que ya están en GitHub no se tocan.
UPDATE `projects` SET `stack_mode` = 'local';
