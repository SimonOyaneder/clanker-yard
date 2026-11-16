DROP INDEX IF EXISTS `combined_bases_issue`;--> statement-breakpoint
CREATE UNIQUE INDEX `combined_bases_repo_issue` ON `combined_bases` (`repo_id`,`issue_id`);