CREATE TABLE `combined_bases` (
	`repo_id` text NOT NULL,
	`branch` text NOT NULL,
	`issue_id` text NOT NULL,
	`default_sha` text NOT NULL,
	`parents` text NOT NULL,
	`head_sha` text,
	`status` text NOT NULL,
	CONSTRAINT `combined_bases_pk` PRIMARY KEY(`repo_id`, `branch`),
	CONSTRAINT `fk_combined_bases_issue_id_issues_id_fk` FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`),
	CONSTRAINT "combined_bases_parents_json" CHECK(json_valid("parents"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `combined_bases_issue` ON `combined_bases` (`issue_id`);