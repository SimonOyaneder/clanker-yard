CREATE TABLE `agent_turns` (
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`model` text NOT NULL,
	`tokens_in` integer NOT NULL,
	`tokens_out` integer NOT NULL,
	`tokens_cache_read` integer NOT NULL,
	`tokens_cache_write` integer NOT NULL,
	`tokens_cache_write_1h` integer NOT NULL,
	`cost_micros` integer NOT NULL,
	CONSTRAINT `agent_turns_pk` PRIMARY KEY(`session_id`, `seq`),
	CONSTRAINT `fk_agent_turns_session_id_agent_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`)
);
--> statement-breakpoint
CREATE TABLE `model_prices` (
	`model` text NOT NULL,
	`input` integer NOT NULL,
	`output` integer NOT NULL,
	`cache_read` integer NOT NULL,
	`cache_write_5m` integer NOT NULL,
	`cache_write_1h` integer NOT NULL,
	`valid_from` integer NOT NULL,
	CONSTRAINT `model_prices_pk` PRIMARY KEY(`model`, `valid_from`)
);
--> statement-breakpoint
INSERT INTO `model_prices` (`model`, `input`, `output`, `cache_read`, `cache_write_5m`, `cache_write_1h`, `valid_from`) VALUES
	('fable', 10000000, 50000000, 250000, 12500000, 20000000, 0),
	('opus', 4000000, 20000000, 200000, 5000000, 8000000, 0),
	('sonnet', 2000000, 10000000, 200000, 2500000, 4000000, 0),
	('haiku', 100000, 500000, 10000, 125000, 200000, 0);
