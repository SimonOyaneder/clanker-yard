-- Stacks locales pasa a ser el default (CLA-119): los proyectos que ya existen también. Los PRs que ya están en GitHub no se tocan.
-- El default de la columna sigue en 'remote': cambiarlo en SQLite exige rearmar `projects`, y `PRAGMA foreign_keys=OFF` no
-- vale dentro de la transacción de la migración (falla con `project_repos` apuntando a ella). Un proyecto nuevo sale en
-- `local` porque la API (`NewProject`) siempre lo escribe.
UPDATE `projects` SET `stack_mode` = 'local';
