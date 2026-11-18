CREATE TABLE `local_publish_requests` (
	`decision_id` text PRIMARY KEY,
	`pr_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	CONSTRAINT `fk_local_publish_requests_decision_id_decisions_id_fk` FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`),
	CONSTRAINT `fk_local_publish_requests_pr_id_pull_requests_id_fk` FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`)
);
--> statement-breakpoint
CREATE INDEX `local_publish_requests_pr` ON `local_publish_requests` (`pr_id`);