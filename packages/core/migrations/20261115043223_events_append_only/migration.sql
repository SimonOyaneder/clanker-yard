-- events es un log: drizzle-kit no modela triggers, por eso esta migración es a mano.
CREATE TRIGGER `events_no_update` BEFORE UPDATE ON `events`
BEGIN
	SELECT RAISE(ABORT, 'events es append-only: no se puede modificar');
END;
--> statement-breakpoint
CREATE TRIGGER `events_no_delete` BEFORE DELETE ON `events`
BEGIN
	SELECT RAISE(ABORT, 'events es append-only: no se puede borrar');
END;
