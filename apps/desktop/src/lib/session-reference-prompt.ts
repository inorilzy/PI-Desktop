import { expandSessionReferences } from "@pi-desktop/shared";
import { api } from "./api";

/** Newest physical lines to read when expanding an @session mention. */
const SESSION_REFERENCE_READ_LIMIT = 400;

/**
 * Load another durable session and expand its completed Q&A into the prompt.
 * Missing ids are returned so the sender can refuse instead of guessing.
 */
export async function expandComposerSessionReferences(
  content: string,
  fileReferences: ReadonlyArray<{ path: string; kind?: string }> | undefined,
  excludeSessionId?: string | null,
): Promise<{ content: string; missingIds: string[] }> {
  return expandSessionReferences(content, {
    references: fileReferences,
    excludeSessionId,
    loadSession: async (id) => {
      const result = await api.getSession(id, { messageLimit: SESSION_REFERENCE_READ_LIMIT });
      const session = result.session;
      if (!session) return null;
      return { id: session.id, title: session.title, messages: session.messages };
    },
  });
}
