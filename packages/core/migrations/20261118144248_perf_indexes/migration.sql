CREATE INDEX `agent_sessions_step_run` ON `agent_sessions` (`step_run_id`);--> statement-breakpoint
CREATE INDEX `artifact_refs_owner` ON `artifact_refs` (`owner_type`,`owner_id`,`role`);--> statement-breakpoint
CREATE INDEX `decisions_kind_status` ON `decisions` (`kind`,`status`);--> statement-breakpoint
CREATE INDEX `pull_requests_state_owned` ON `pull_requests` (`state`,`owned`);--> statement-breakpoint
CREATE INDEX `runs_project` ON `runs` (`project_id`,`id`);--> statement-breakpoint
CREATE INDEX `runs_status` ON `runs` (`status`);