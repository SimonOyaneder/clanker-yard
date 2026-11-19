-- USD Standard en micros por millón de tokens. Codex no distingue la duración de las escrituras.
INSERT INTO model_prices (model, input, output, cache_read, cache_write_5m, cache_write_1h, valid_from, above_prompt_tokens) VALUES
    ('gpt-6.2-sol',    2000000, 10000000, 100000,  2500000,  2500000, 1794960000000, 0),
    ('gpt-6.2-sol',    4000000, 15000000, 200000,  5000000,  5000000, 1794960000000, 272000),
    ('gpt-6.2-astra',  8000000, 40000000, 400000, 10000000, 10000000, 1794960000000, 0),
    ('gpt-6.2-astra', 16000000, 60000000, 800000, 20000000, 20000000, 1794960000000, 272000)
ON CONFLICT (model, valid_from, above_prompt_tokens) DO NOTHING;
--> statement-breakpoint
-- agent.usage conserva el paso de cada turno, también al retomar la misma sesión en otro paso.
CREATE TEMP TABLE codex_turn_costs AS
SELECT t.session_id, t.seq, e.step_run_id, round((
    t.tokens_in * p.input + t.tokens_out * p.output +
    t.tokens_cache_read * p.cache_read + t.tokens_cache_write * p.cache_write_5m
) / 1000000.0) AS cost
FROM events e
JOIN agent_turns t ON t.session_id = e.payload ->> '$.sessionId' AND t.seq = e.payload ->> '$.turn'
JOIN agent_sessions a ON a.id = t.session_id
JOIN model_prices p ON p.model = t.model AND p.valid_from = 1794960000000
    AND p.above_prompt_tokens = CASE WHEN t.tokens_in + t.tokens_cache_read + t.tokens_cache_write > 272000 THEN 272000 ELSE 0 END
WHERE e.type = 'agent.usage' AND a.runtime = 'codex' AND a.cost_source = 'estimate'
    AND t.model IN ('gpt-6.2-sol', 'gpt-6.2-astra') AND t.ts >= p.valid_from AND t.cost_micros = 0;
--> statement-breakpoint
UPDATE agent_turns AS t SET cost_micros = c.cost
FROM codex_turn_costs c WHERE t.session_id = c.session_id AND t.seq = c.seq;
--> statement-breakpoint
UPDATE agent_sessions AS a SET cost_micros = a.cost_micros + c.cost
FROM (SELECT session_id, sum(cost) AS cost FROM codex_turn_costs GROUP BY session_id) c
WHERE a.id = c.session_id;
--> statement-breakpoint
UPDATE pr_chats AS chat SET cost_micros = chat.cost_micros + c.cost
FROM (
    SELECT m.chat_id, sum(t.cost) AS cost FROM codex_turn_costs t
    JOIN (SELECT DISTINCT chat_id, session_id FROM pr_chat_messages WHERE session_id IS NOT NULL) m
        ON m.session_id = t.session_id
    WHERE t.step_run_id IS NULL GROUP BY m.chat_id
) c WHERE chat.id = c.chat_id;
--> statement-breakpoint
UPDATE step_usage AS u SET cost_micros = u.cost_micros + c.cost
FROM (SELECT step_run_id, session_id, sum(cost) AS cost FROM codex_turn_costs GROUP BY step_run_id, session_id) c
WHERE u.step_run_id = c.step_run_id AND u.session_id = c.session_id;
--> statement-breakpoint
-- El motor suma al paso y a la corrida al cerrar el paso. Los abiertos se cobrarán al cierre.
CREATE TEMP TABLE codex_step_costs AS
SELECT s.run_id, s.id AS step_id, s.status, d.slug AS role, sum(t.cost) AS cost
FROM codex_turn_costs t
JOIN step_runs s ON s.id = t.step_run_id
JOIN agent_sessions a ON a.id = t.session_id
JOIN defs d ON d.id = a.role_def_id
GROUP BY s.id, d.slug;
--> statement-breakpoint
UPDATE step_runs AS s SET cost_micros = s.cost_micros + c.cost
FROM (SELECT step_id, sum(cost) AS cost FROM codex_step_costs WHERE status IN ('done', 'failed') GROUP BY step_id) c
WHERE s.id = c.step_id;
--> statement-breakpoint
UPDATE runs AS r SET cost_micros = r.cost_micros + c.cost
FROM (SELECT run_id, sum(cost) AS cost FROM codex_step_costs WHERE status IN ('done', 'failed') GROUP BY run_id) c
WHERE r.id = c.run_id;
--> statement-breakpoint
-- Las métricas de corridas cerradas incluyen también lo consumido antes de cancelar un paso.
UPDATE run_role_costs AS r SET cost_micros = r.cost_micros + c.cost
FROM (SELECT run_id, role, sum(cost) AS cost FROM codex_step_costs GROUP BY run_id, role) c
WHERE r.run_id = c.run_id AND r.role = c.role;
--> statement-breakpoint
UPDATE run_metrics AS r SET cost_micros = r.cost_micros + c.cost
FROM (SELECT run_id, sum(cost) AS cost FROM codex_step_costs GROUP BY run_id) c
WHERE r.run_id = c.run_id;
--> statement-breakpoint
DROP TABLE codex_step_costs;
--> statement-breakpoint
DROP TABLE codex_turn_costs;
