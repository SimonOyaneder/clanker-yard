import type { TranscriptPage, TranscriptQuery } from "@clanker/api";
import { eq } from "drizzle-orm";
import type * as z from "zod";
import { agentSessions } from "../store/schema";
import type { Store } from "../store/store";
import { readTranscript, transcriptFile } from "./claude/transcript";

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`No existe la sesión ${sessionId}.`);
  }
}

export interface Transcripts {
  /** Una página del transcript de la sesión (`agent_sessions.id`), desde `cursor`. */
  read(query: z.output<typeof TranscriptQuery>): Promise<TranscriptPage>;
}

/** Los transcripts que los runtimes dejan bajo `home` (`transcripts/<sessionRef>.jsonl`). */
export function createTranscripts({ store, home }: { store: Store; home: string }): Transcripts {
  return {
    async read({ sessionId, cursor, limit }) {
      const session = store.db.select({ ref: agentSessions.sessionRef }).from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
      if (!session) throw new SessionNotFoundError(sessionId);
      return readTranscript(transcriptFile(home, session.ref), cursor, limit);
    },
  };
}
