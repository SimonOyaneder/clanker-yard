CREATE TABLE `slots` (
	`repo_id` text NOT NULL,
	`idx` integer NOT NULL,
	`env` text NOT NULL,
	`reserved_for` text NOT NULL,
	`holder_run_id` text,
	`workspace_id` text,
	`setup_hash` text,
	`lease_until` integer,
	`fencing_token` integer DEFAULT 0 NOT NULL,
	`dirty` integer DEFAULT false NOT NULL,
	CONSTRAINT `slots_pk` PRIMARY KEY(`repo_id`, `idx`)
);
