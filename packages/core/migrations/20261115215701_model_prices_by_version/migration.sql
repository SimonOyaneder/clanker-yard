ALTER TABLE `model_prices` ADD `above_prompt_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_model_prices` (
	`model` text NOT NULL,
	`input` integer NOT NULL,
	`output` integer NOT NULL,
	`cache_read` integer NOT NULL,
	`cache_write_5m` integer NOT NULL,
	`cache_write_1h` integer NOT NULL,
	`valid_from` integer NOT NULL,
	`above_prompt_tokens` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `model_prices_pk` PRIMARY KEY(`model`, `valid_from`, `above_prompt_tokens`)
);
--> statement-breakpoint
INSERT INTO `__new_model_prices`(`model`, `input`, `output`, `cache_read`, `cache_write_5m`, `cache_write_1h`, `valid_from`) SELECT `model`, `input`, `output`, `cache_read`, `cache_write_5m`, `cache_write_1h`, `valid_from` FROM `model_prices`;--> statement-breakpoint
DROP TABLE `model_prices`;--> statement-breakpoint
ALTER TABLE `__new_model_prices` RENAME TO `model_prices`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
INSERT INTO `model_prices` (`model`, `input`, `output`, `cache_read`, `cache_write_5m`, `cache_write_1h`, `valid_from`, `above_prompt_tokens`) VALUES
	('fable', 8000000, 40000000, 200000, 10000000, 16000000, 1794779712887, 0),
	('mythos', 8000000, 40000000, 200000, 10000000, 16000000, 1794779712887, 0),
	('sonnet', 2000000, 10000000, 100000, 2500000, 4000000, 1794779712887, 0),
	('haiku', 100000, 500000, 10000, 125000, 200000, 1794779712887, 0),
	('haiku', 500000, 2500000, 50000, 625000, 1000000, 1794779712887, 100000),
	('fable-5-2', 8000000, 40000000, 200000, 10000000, 16000000, 0, 0),
	('mythos-5-2', 8000000, 40000000, 200000, 10000000, 16000000, 0, 0),
	('fable-5-1', 10000000, 50000000, 250000, 12500000, 20000000, 0, 0),
	('mythos-5-1', 10000000, 50000000, 250000, 12500000, 20000000, 0, 0),
	('fable-5', 10000000, 50000000, 1000000, 12500000, 20000000, 0, 0),
	('mythos-5', 10000000, 50000000, 1000000, 12500000, 20000000, 0, 0),
	('opus-5-5', 4000000, 20000000, 200000, 5000000, 8000000, 0, 0),
	('opus-5', 5000000, 25000000, 500000, 6250000, 10000000, 0, 0),
	('opus-4-8', 5000000, 25000000, 500000, 6250000, 10000000, 0, 0),
	('opus-4-7', 5000000, 25000000, 500000, 6250000, 10000000, 0, 0),
	('opus-4-6', 5000000, 25000000, 500000, 6250000, 10000000, 0, 0),
	('opus-4-5', 5000000, 25000000, 500000, 6250000, 10000000, 0, 0),
	('sonnet-5-5', 2000000, 10000000, 100000, 2500000, 4000000, 0, 0),
	('sonnet-5', 2000000, 10000000, 200000, 2500000, 4000000, 0, 0),
	('sonnet-4-6', 3000000, 15000000, 300000, 3750000, 6000000, 0, 0),
	('sonnet-4-5', 3000000, 15000000, 300000, 3750000, 6000000, 0, 0),
	('haiku-5-5', 100000, 500000, 10000, 125000, 200000, 0, 0),
	('haiku-5-5', 500000, 2500000, 50000, 625000, 1000000, 0, 100000),
	('haiku-4-5', 1000000, 5000000, 100000, 1250000, 2000000, 0, 0);
