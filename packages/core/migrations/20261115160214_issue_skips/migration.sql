CREATE TABLE `issue_skips` (
	`issue_id` text PRIMARY KEY,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_issue_skips_issue_id_issues_id_fk` FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`)
);
