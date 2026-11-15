CREATE TABLE `merge_offers` (
	`decision_id` text PRIMARY KEY,
	`pr_id` text NOT NULL,
	`head_sha` text NOT NULL,
	CONSTRAINT `fk_merge_offers_pr_id_pull_requests_id_fk` FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`)
);
--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `hold` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `merge_strategy` text;--> statement-breakpoint
CREATE INDEX `merge_offers_pr` ON `merge_offers` (`pr_id`);--> statement-breakpoint
-- Los `PrState` guardados no traen `merge`, `hold` ni `approvers`: Watch los relee en su próxima visita.
UPDATE `pull_requests` SET `detail` = NULL, `detail_at` = NULL;
