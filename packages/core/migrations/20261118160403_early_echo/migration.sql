CREATE TABLE `pr_chat_messages` (
	`id` text PRIMARY KEY,
	`chat_id` text NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`session_id` text,
	`proposal_rev` integer,
	`refs` text,
	`at` integer NOT NULL,
	CONSTRAINT `fk_pr_chat_messages_chat_id_pr_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `pr_chats`(`id`)
);
--> statement-breakpoint
CREATE TABLE `pr_chat_proposals` (
	`chat_id` text NOT NULL,
	`rev` integer NOT NULL,
	`base_sha` text NOT NULL,
	`snapshot_ref` text NOT NULL,
	`snapshot_sha` text NOT NULL,
	`patch_hash` text NOT NULL,
	`summary` text NOT NULL,
	`items` text NOT NULL,
	`files` text NOT NULL,
	`status` text NOT NULL,
	`run_id` text,
	`result` text,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `pr_chat_proposals_pk` PRIMARY KEY(`chat_id`, `rev`),
	CONSTRAINT `fk_pr_chat_proposals_chat_id_pr_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `pr_chats`(`id`)
);
--> statement-breakpoint
ALTER TABLE `pr_chats` ADD `runtime` text DEFAULT 'claude-sdk' NOT NULL;--> statement-breakpoint
ALTER TABLE `pr_chats` ADD `model` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `pr_chats` ADD `effort` text;--> statement-breakpoint
ALTER TABLE `pr_chats` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `pr_chats` ADD `turn_started_at` integer;--> statement-breakpoint
ALTER TABLE `pr_chats` ADD `turn_session_id` text;--> statement-breakpoint
ALTER TABLE `pr_chats` ADD `cost_micros` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pr_chats` ADD `created_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pr_chats` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `pr_chat_messages_chat_at` ON `pr_chat_messages` (`chat_id`,`at`);--> statement-breakpoint
CREATE INDEX `pr_chat_proposals_run` ON `pr_chat_proposals` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pr_chats_active_pr` ON `pr_chats` (`pr_id`) WHERE "pr_chats"."status" = 'active';