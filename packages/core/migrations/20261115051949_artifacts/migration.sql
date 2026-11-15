CREATE TABLE `artifact_refs` (
	`hash` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`role` text NOT NULL,
	CONSTRAINT `artifact_refs_pk` PRIMARY KEY(`hash`, `owner_type`, `owner_id`, `role`),
	CONSTRAINT `fk_artifact_refs_hash_artifacts_hash_fk` FOREIGN KEY (`hash`) REFERENCES `artifacts`(`hash`)
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`hash` text PRIMARY KEY,
	`kind` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`body` blob,
	`last_put_at` integer NOT NULL
);
