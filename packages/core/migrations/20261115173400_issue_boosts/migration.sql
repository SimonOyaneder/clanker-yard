CREATE TABLE `issue_boosts` (
	`issue_id` text PRIMARY KEY,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_issue_boosts_issue_id_issues_id_fk` FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`)
);
