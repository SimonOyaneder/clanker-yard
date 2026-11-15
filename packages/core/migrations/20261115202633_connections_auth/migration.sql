ALTER TABLE `connections` ADD `auth` text;
--> statement-breakpoint
UPDATE `connections` SET `auth` = 'pat' WHERE `provider` = 'github';
