import { api } from "../../lib/api";
import { asPluginRewriteRecords } from "../../lib/plugin-rewrites";
import type { AppState } from "../app-state";
import type { StoreAccess } from "./types";

/**
 * The renderer's copy of the rewrite audit (ADR 0295 rule 5).
 *
 * The records live in host-core and only ever arrive through a session read or
 * an explicit re-read; this is the single place that puts them in the store, so
 * a rewritten row's badge has one source and no second writer.
 */
export function createPluginRewritesSlice({
  set,
}: StoreAccess): Pick<
  AppState,
  "rememberPluginRewrites" | "refreshPluginRewrites"
> {
  const remember = (sessionId: string, rewrites: unknown): void => {
    // A paged or failed read carries no records and must not erase the ones
    // already shown.
    if (rewrites === undefined) return;
    const records = asPluginRewriteRecords(rewrites);
    set((state) => ({
      pluginRewrites: { ...state.pluginRewrites, [sessionId]: records },
    }));
  };

  return {
    rememberPluginRewrites: remember,
    refreshPluginRewrites: async (sessionId) => {
      // One message is enough: the records ride the session read itself, and
      // this call is not the transcript load. A failed read leaves the existing
      // records alone — the audit trail is still in the store for the next read.
      const detail = await api
        .getSession(sessionId, { messageLimit: 1 })
        .catch(() => null);
      remember(sessionId, detail?.rewrites);
    },
  };
}
