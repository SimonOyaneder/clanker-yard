CREATE TABLE `connections` (
	`provider` text NOT NULL,
	`account` text NOT NULL,
	`scopes` text NOT NULL,
	`status` text NOT NULL,
	`secret_ref` text NOT NULL,
	`expires_at` integer,
	CONSTRAINT `connections_pk` PRIMARY KEY(`provider`, `account`),
	CONSTRAINT "connections_scopes_json" CHECK(json_valid("scopes"))
);
