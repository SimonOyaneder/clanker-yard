CREATE TABLE `run_metrics` (
	`run_id` text PRIMARY KEY,
	`result` text NOT NULL,
	`minutes` real NOT NULL,
	`rounds` text NOT NULL,
	`outcomes` text NOT NULL,
	`cost_micros` integer NOT NULL,
	CONSTRAINT `fk_run_metrics_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`),
	CONSTRAINT "run_metrics_rounds_json" CHECK(json_valid("rounds")),
	CONSTRAINT "run_metrics_outcomes_json" CHECK(json_valid("outcomes"))
);
--> statement-breakpoint
CREATE TABLE `run_role_costs` (
	`run_id` text NOT NULL,
	`role` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`tokens` integer NOT NULL,
	`cost_micros` integer NOT NULL,
	CONSTRAINT `run_role_costs_pk` PRIMARY KEY(`run_id`, `role`),
	CONSTRAINT `fk_run_role_costs_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`)
);
--> statement-breakpoint
CREATE TABLE `step_usage` (
	`step_run_id` text NOT NULL,
	`session_id` text NOT NULL,
	`tokens` integer NOT NULL,
	`cost_micros` integer NOT NULL,
	CONSTRAINT `step_usage_pk` PRIMARY KEY(`step_run_id`, `session_id`),
	CONSTRAINT `fk_step_usage_session_id_agent_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`)
);
