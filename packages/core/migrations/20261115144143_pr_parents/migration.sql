CREATE TABLE `pr_parents` (
	`child_id` text NOT NULL,
	`parent_id` text NOT NULL,
	CONSTRAINT `pr_parents_pk` PRIMARY KEY(`child_id`, `parent_id`),
	CONSTRAINT `fk_pr_parents_child_id_pull_requests_id_fk` FOREIGN KEY (`child_id`) REFERENCES `pull_requests`(`id`),
	CONSTRAINT `fk_pr_parents_parent_id_pull_requests_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `pull_requests`(`id`)
);
--> statement-breakpoint
CREATE INDEX `pr_parents_parent` ON `pr_parents` (`parent_id`);