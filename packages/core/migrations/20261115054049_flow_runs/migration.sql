CREATE TABLE `action_effects` (
	`idem_key` text NOT NULL,
	`stage` text NOT NULL,
	`result` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `action_effects_pk` PRIMARY KEY(`idem_key`, `stage`),
	CONSTRAINT "action_effects_result_json" CHECK(json_valid("result"))
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY,
	`project_id` text,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`flow_def_id` text NOT NULL,
	`flow_version` integer NOT NULL,
	`profile_def_id` text,
	`profile_version` integer,
	`roles` text NOT NULL,
	`lane` text NOT NULL,
	`status` text NOT NULL,
	`park_reason` text,
	`outcome` text,
	`writes` integer NOT NULL,
	`params` text NOT NULL,
	`rounds` text NOT NULL,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	CONSTRAINT `fk_runs_flow_def_id_flow_version_def_versions_def_id_version_fk` FOREIGN KEY (`flow_def_id`,`flow_version`) REFERENCES `def_versions`(`def_id`,`version`),
	CONSTRAINT `fk_runs_profile_def_id_profile_version_def_versions_def_id_version_fk` FOREIGN KEY (`profile_def_id`,`profile_version`) REFERENCES `def_versions`(`def_id`,`version`),
	CONSTRAINT "runs_roles_json" CHECK(json_valid("roles")),
	CONSTRAINT "runs_params_json" CHECK(json_valid("params")),
	CONSTRAINT "runs_rounds_json" CHECK(json_valid("rounds"))
);
--> statement-breakpoint
CREATE TABLE `step_runs` (
	`id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`node_id` text NOT NULL,
	`visit` integer NOT NULL,
	`round` integer NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`outcome` text,
	`owner` text,
	`not_before` integer,
	`input_hash` text,
	`output_hash` text,
	`lease_until` integer,
	`error` text,
	`prev_step_run_id` text,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_step_runs_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_active_flow_subject` ON `runs` (`flow_def_id`,`subject_type`,`subject_id`) WHERE "runs"."status" IN ('queued', 'running', 'waiting', 'parked', 'paused');--> statement-breakpoint
CREATE UNIQUE INDEX `step_runs_run_node_visit_attempt` ON `step_runs` (`run_id`,`node_id`,`visit`,`attempt`);--> statement-breakpoint
CREATE INDEX `step_runs_status_lease` ON `step_runs` (`status`,`lease_until`);