CREATE TABLE `incoming_reviews` (
	`request_id` text PRIMARY KEY,
	`repo_id` text NOT NULL,
	`account` text NOT NULL,
	`number` integer NOT NULL,
	`due_at` integer NOT NULL,
	`run_id` text UNIQUE,
	`base` text,
	`head` text,
	`draft_id` text,
	`reserved` text DEFAULT '[]' NOT NULL
);
