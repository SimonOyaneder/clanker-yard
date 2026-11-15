CREATE TABLE `issues` (
	`id` text PRIMARY KEY,
	`tracker` text NOT NULL,
	`tracker_id` text NOT NULL,
	`key` text NOT NULL,
	`url` text NOT NULL,
	`project_id` text NOT NULL,
	`tracker_project` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`raw_status` text NOT NULL,
	`priority` integer NOT NULL,
	`assignee` text,
	`labels` text NOT NULL,
	`estimate` real,
	`parent` text,
	`milestone` text,
	`relations` text NOT NULL,
	`remote_updated_at` integer NOT NULL,
	CONSTRAINT "issues_labels_json" CHECK(json_valid("labels")),
	CONSTRAINT "issues_relations_json" CHECK(json_valid("relations")),
	CONSTRAINT "issues_assignee_json" CHECK("assignee" IS NULL OR json_valid("assignee")),
	CONSTRAINT "issues_parent_json" CHECK("parent" IS NULL OR json_valid("parent")),
	CONSTRAINT "issues_milestone_json" CHECK("milestone" IS NULL OR json_valid("milestone"))
);
--> statement-breakpoint
CREATE TABLE `local_comments` (
	`id` text PRIMARY KEY,
	`issue_id` text NOT NULL,
	`author` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_local_comments_issue_id_local_issues_id_fk` FOREIGN KEY (`issue_id`) REFERENCES `local_issues`(`id`),
	CONSTRAINT "local_comments_author_json" CHECK(json_valid("author"))
);
--> statement-breakpoint
CREATE TABLE `local_issues` (
	`id` text PRIMARY KEY,
	`project` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`raw_status` text NOT NULL,
	`priority` integer NOT NULL,
	`assignee` text,
	`labels` text NOT NULL,
	`estimate` real,
	`parent_id` text,
	`milestone` text,
	`rev` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_local_issues_parent_id_local_issues_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `local_issues`(`id`),
	CONSTRAINT "local_issues_labels_json" CHECK(json_valid("labels")),
	CONSTRAINT "local_issues_assignee_json" CHECK("assignee" IS NULL OR json_valid("assignee")),
	CONSTRAINT "local_issues_milestone_json" CHECK("milestone" IS NULL OR json_valid("milestone"))
);
--> statement-breakpoint
CREATE TABLE `local_relations` (
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`kind` text NOT NULL,
	CONSTRAINT `local_relations_pk` PRIMARY KEY(`from_id`, `to_id`, `kind`),
	CONSTRAINT `fk_local_relations_from_id_local_issues_id_fk` FOREIGN KEY (`from_id`) REFERENCES `local_issues`(`id`),
	CONSTRAINT `fk_local_relations_to_id_local_issues_id_fk` FOREIGN KEY (`to_id`) REFERENCES `local_issues`(`id`),
	CONSTRAINT "local_relations_distinct" CHECK("from_id" != "to_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issues_tracker_tracker_id` ON `issues` (`tracker`,`tracker_id`);--> statement-breakpoint
CREATE INDEX `issues_project_status_priority` ON `issues` (`project_id`,`status`,`priority`);--> statement-breakpoint
CREATE INDEX `local_comments_issue` ON `local_comments` (`issue_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `local_issues_project_number` ON `local_issues` (`project`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `local_issues_rev` ON `local_issues` (`rev`);