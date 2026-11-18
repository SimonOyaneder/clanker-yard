CREATE TABLE `chat_scratches` (
	`chat_id` text PRIMARY KEY,
	`repo_id` text NOT NULL,
	`head_sha` text NOT NULL,
	`sync_target` text
);
--> statement-breakpoint
CREATE TABLE `pr_chats` (
	`id` text PRIMARY KEY,
	`pr_id` text NOT NULL,
	`status` text NOT NULL,
	CONSTRAINT `fk_pr_chats_pr_id_pull_requests_id_fk` FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`)
);
