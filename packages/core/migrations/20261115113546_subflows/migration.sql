ALTER TABLE `runs` ADD `subflows` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `parent_run_id` text REFERENCES runs(id);--> statement-breakpoint
ALTER TABLE `runs` ADD `parent_step_run_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `stop_before` text;--> statement-breakpoint
CREATE UNIQUE INDEX `runs_parent_step` ON `runs` (`parent_step_run_id`);--> statement-breakpoint
CREATE INDEX `runs_parent_run` ON `runs` (`parent_run_id`);--> statement-breakpoint
DROP INDEX `runs_active_flow_subject`;--> statement-breakpoint
CREATE UNIQUE INDEX `runs_active_flow_subject` ON `runs` (`flow_def_id`,`subject_type`,`subject_id`) WHERE "runs"."parent_run_id" IS NULL AND "runs"."status" IN ('queued', 'running', 'waiting', 'parked', 'paused');
