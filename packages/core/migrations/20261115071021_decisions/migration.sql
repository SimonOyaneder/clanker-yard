CREATE TABLE `decisions` (
	`id` text PRIMARY KEY,
	`project_id` text,
	`run_id` text,
	`step_run_id` text,
	`subject` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`options` text NOT NULL,
	`status` text NOT NULL,
	`resolution` text,
	`resolved_by` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	CONSTRAINT "decisions_options_json" CHECK(json_valid("options")),
	CONSTRAINT "decisions_subject_json" CHECK("subject" IS NULL OR json_valid("subject")),
	CONSTRAINT "decisions_resolution_json" CHECK("resolution" IS NULL OR json_valid("resolution"))
);
--> statement-breakpoint
CREATE INDEX `decisions_status_project` ON `decisions` (`status`,`project_id`);--> statement-breakpoint
CREATE INDEX `decisions_run` ON `decisions` (`run_id`);