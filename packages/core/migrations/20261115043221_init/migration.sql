CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT,
	`ts` integer NOT NULL,
	`type` text NOT NULL,
	`origin` text NOT NULL,
	`project_id` text,
	`run_id` text,
	`step_run_id` text,
	`subject` text,
	`payload` text NOT NULL,
	CONSTRAINT "events_payload_json" CHECK(json_valid("payload"))
);
--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_run_seq` ON `events` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_project_seq` ON `events` (`project_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_type_seq` ON `events` (`type`,`seq`);