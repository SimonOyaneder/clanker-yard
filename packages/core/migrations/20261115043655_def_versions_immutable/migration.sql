-- def_versions es historial: drizzle-kit no modela triggers, por eso esta migración es a mano.
CREATE TRIGGER `def_versions_no_update` BEFORE UPDATE ON `def_versions`
BEGIN
	SELECT RAISE(ABORT, 'def_versions es inmutable: edita una def guardando una versión nueva');
END;
--> statement-breakpoint
CREATE TRIGGER `def_versions_no_delete` BEFORE DELETE ON `def_versions`
BEGIN
	SELECT RAISE(ABORT, 'def_versions es inmutable: no se puede borrar');
END;
