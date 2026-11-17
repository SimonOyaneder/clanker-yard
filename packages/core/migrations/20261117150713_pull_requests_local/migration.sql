ALTER TABLE `pull_requests` ADD `title` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `body` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- Editado a mano: el migrador corre en una transacción, donde PRAGMA foreign_keys=OFF no hace nada, así que el DROP TABLE
-- fallaría con filas que apuntan a pull_requests. Las tablas hijas se guardan aparte y vuelven después de recrearla.
CREATE TEMP TABLE `__keep_watch_marks` AS SELECT * FROM `watch_marks`;--> statement-breakpoint
CREATE TEMP TABLE `__keep_pr_parents` AS SELECT * FROM `pr_parents`;--> statement-breakpoint
CREATE TEMP TABLE `__keep_merge_offers` AS SELECT * FROM `merge_offers`;--> statement-breakpoint
DELETE FROM `watch_marks`;--> statement-breakpoint
DELETE FROM `pr_parents`;--> statement-breakpoint
DELETE FROM `merge_offers`;--> statement-breakpoint
CREATE TABLE `__new_pull_requests` (
	`id` text PRIMARY KEY,
	`repo_id` text NOT NULL,
	`number` integer,
	`node_id` text,
	`head_ref` text NOT NULL,
	`base_ref` text NOT NULL,
	`head_sha` text NOT NULL,
	`state` text NOT NULL,
	`is_draft` integer NOT NULL,
	`issue_id` text,
	`run_id` text,
	`owned` integer DEFAULT false NOT NULL,
	`detail` text,
	`detail_at` integer,
	`head_changed_at` integer,
	`hold` integer DEFAULT false NOT NULL,
	`title` text,
	`body` text,
	CONSTRAINT "pull_requests_number_iff_not_local" CHECK(("state" = 'local') = ("number" IS NULL) AND ("state" = 'local') = ("node_id" IS NULL)),
	CONSTRAINT "pull_requests_local_title" CHECK("state" != 'local' OR "title" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_pull_requests`(`id`, `repo_id`, `number`, `node_id`, `head_ref`, `base_ref`, `head_sha`, `state`, `is_draft`, `issue_id`, `run_id`, `owned`, `detail`, `detail_at`, `head_changed_at`, `hold`) SELECT `id`, `repo_id`, `number`, `node_id`, `head_ref`, `base_ref`, `head_sha`, `state`, `is_draft`, `issue_id`, `run_id`, `owned`, `detail`, `detail_at`, `head_changed_at`, `hold` FROM `pull_requests`;--> statement-breakpoint
DROP TABLE `pull_requests`;--> statement-breakpoint
ALTER TABLE `__new_pull_requests` RENAME TO `pull_requests`;--> statement-breakpoint
INSERT INTO `watch_marks` SELECT * FROM `__keep_watch_marks`;--> statement-breakpoint
INSERT INTO `pr_parents` SELECT * FROM `__keep_pr_parents`;--> statement-breakpoint
INSERT INTO `merge_offers` SELECT * FROM `__keep_merge_offers`;--> statement-breakpoint
DROP TABLE `__keep_watch_marks`;--> statement-breakpoint
DROP TABLE `__keep_pr_parents`;--> statement-breakpoint
DROP TABLE `__keep_merge_offers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_repo_number` ON `pull_requests` (`repo_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_repo_branch_local` ON `pull_requests` (`repo_id`,`head_ref`) WHERE "pull_requests"."state" = 'local';