CREATE TABLE `procs` (
	`pid` integer NOT NULL,
	`pgid` integer NOT NULL,
	`boot_id` text NOT NULL,
	`kind` text NOT NULL,
	`step_run_id` text,
	`started_at` integer NOT NULL,
	CONSTRAINT `procs_pk` PRIMARY KEY(`boot_id`, `pid`)
);
--> statement-breakpoint
ALTER TABLE `step_runs` ADD `recoveries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `step_runs` ADD `deferrals` integer DEFAULT 0 NOT NULL;