CREATE TABLE `def_versions` (
	`def_id` text NOT NULL,
	`version` integer NOT NULL,
	`body` text NOT NULL,
	`body_hash` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `def_versions_pk` PRIMARY KEY(`def_id`, `version`),
	CONSTRAINT `fk_def_versions_def_id_defs_id_fk` FOREIGN KEY (`def_id`) REFERENCES `defs`(`id`),
	CONSTRAINT "def_versions_body_json" CHECK(json_valid("body"))
);
--> statement-breakpoint
CREATE TABLE `defs` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`slug` text NOT NULL,
	`scope` text NOT NULL,
	`repo_id` text,
	`current_version` integer NOT NULL,
	`archived_at` integer,
	CONSTRAINT "defs_repo_id_iff_repo_scope" CHECK(("scope" = 'repo') = ("repo_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `defs_kind_slug_scope_repo` ON `defs` (`kind`,`slug`,`scope`,coalesce("repo_id", ''));