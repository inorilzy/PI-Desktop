import {
  memo,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import type { PiRendererEntryAction } from "@pi-desktop/plugin-sdk";
import { useOpenChatFileRef } from "../../../hooks/use-preview-target";
import { splitChatText } from "../../../lib/chat-links";
import { useAppStore } from "../../../stores/app-store";
import { Markdown } from "../../../components/Markdown";
import {
  IconChevronLeft,
  IconChevronRight,
  IconPencil,
  IconPlug,
  IconTrash,
} from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { PluginSlot } from "../../../plugins/renderer-slots/SlotOutlet";
import { rendererCandidates } from "../../../plugins/renderer-slots/candidates";
import {
  entryExtraSlotProps,
  entrySlotProps,
  transcriptEntryIdentity,
  transcriptEntryMessage,
} from "./model";
import { SessionMessageOrigin } from "./SessionMessageOrigin";
import {
  CopyButton,
  FileRefChip,
  LinkifiedText,
  MessageAttachmentImage,
} from "./shared";
import {
  outgoingRewriteForMessage,
  rewritePluginName,
  rewrittenMessageText,
} from "../../../lib/plugin-rewrites";

/**
 * The registrations a position renders while the host's own rendering must win:
 * an empty owned list means "draw the host's own content", never "look one up".
 */
const NO_REGISTRATIONS = [] as const;

export const MessageRow = memo(function MessageRow({
  message,
  isRunning,
}: {
  message: UiMessage;
  isRunning: boolean;
}) {
  const { t } = useTranslation();
  const editUserMessage = useAppStore((s) => s.editUserMessage);
  const activateMessageRevision = useAppStore((s) => s.activateMessageRevision);
  const deleteMessage = useAppStore((s) => s.deleteMessage);
  const isUser = message.role === "user";
  const isSessionMessage = Boolean(message.sessionMessage);
  const editableUserMessage = isUser && !isSessionMessage;
  const workspaceRoot = useAppStore((s) => s.workspace?.path);
  const openFileRef = useOpenChatFileRef();

  // Slots 1 (`entry`) and 13 (`entryExtra`): this row is the whole message a
  // plugin may draw, and the area below it one may add to. Both read what the
  // row and the store already hold — no new state, and nothing rendered unless
  // a plugin registered for the slot.
  const sessionId = useAppStore((s) => s.activeSessionId);
  const plugins = useAppStore((s) => s.plugins);
  const entryCandidates = useMemo(
    () => (sessionId ? rendererCandidates(plugins) : []),
    [plugins, sessionId],
  );
  // D14: `pluginId` stays unset because no producer reports one yet (model.ts).
  // Without a session the slot has no `sessionId` to report, so it is not
  // mounted at all rather than handed a made-up one.
  const entryIdentityProps = useMemo(
    () =>
      sessionId
        ? entryExtraSlotProps(transcriptEntryIdentity(message), sessionId)
        : undefined,
    [message, sessionId],
  );
  // Slash prompts are stored expanded; editing works on the typed form so the
  // resent turn re-expands the template (D123).
  const editSeed =
    (editableUserMessage && message.command) || (message.content || "");
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(editSeed);
  const [retryingEdit, setRetryingEdit] = useState(false);
  const copyLabel = t("chat.copy");
  const editLabel = t("chat.editMessage");
  const deleteLabel = t("chat.deleteMessage");
  // Runtime chunks are already progressive. Rendering that source directly
  // avoids a second per-frame state loop while Markdown memoizes stable blocks.
  const displayed = message.content || "";
  const hasAnswer = Boolean((message.content || "").trim());
  const revisionCount = message.revisionCount ?? 0;
  const activeRevision = message.activeRevision ?? revisionCount;
  const showRevisionPager = editableUserMessage && revisionCount > 1;
  // Slot 1 (`entry`) replaces the row, so the host hands it what the row was
  // going to draw — text, attachments, timestamp, the typed slash form, whether
  // the text is still arriving — plus which of the row's own actions the
  // position stands in for. The action list follows the same conditions the
  // host's own action bar below uses, so the two can never drift apart.
  const hostActions = useMemo<PiRendererEntryAction[]>(() => {
    if (editing) return [];
    const actions: PiRendererEntryAction[] = [];
    if (hasAnswer) actions.push("copy");
    if (showRevisionPager) actions.push("revisions");
    if (editableUserMessage) actions.push("edit", "delete");
    return actions;
  }, [editing, hasAnswer, editableUserMessage, showRevisionPager]);
  const entryProps = useMemo(
    () =>
      sessionId
        ? entrySlotProps(
            transcriptEntryIdentity(message),
            transcriptEntryMessage(message, hostActions),
            sessionId,
          )
        : undefined,
    [message, sessionId, hostActions],
  );
  const extraAttachments = useMemo(() => {
    const attachments = message.attachments;
    if (!attachments?.length) return [];
    const inline = new Set(
      splitChatText(String(message.content || ""), workspaceRoot)
        .filter((segment): segment is { kind: "target"; text: string; label: string; target: { kind: "file"; path: string } } => segment.kind === "target" && segment.target.kind === "file")
        .map((segment) => segment.target.path),
    );
    return attachments.filter((attachment) => !inline.has(attachment.ref));
  }, [message.attachments, message.content, workspaceRoot]);
  // Slot #1 (ADR 0295 rule 5): a plugin may rewrite the outgoing message on the
  // way to the model. The row keeps the text the user typed; the record marks it
  // and its changed span is what the expansion shows. No record, no badge.
  const sessionPluginRewrites = useAppStore((state) =>
    sessionId ? state.pluginRewrites?.[sessionId] : undefined,
  );
  const rewrite =
    isUser && !isSessionMessage
      ? outgoingRewriteForMessage(sessionPluginRewrites, message.id)
      : undefined;
  const rewriteModelText = useMemo(
    () => (rewrite ? rewrittenMessageText(String(message.content || ""), rewrite) : null),
    [message.content, rewrite],
  );
  const rewriteName = rewrite ? rewritePluginName(rewrite, plugins) : "";
  const cancelEdit = () => {
    setEditValue(editSeed);
    setEditing(false);
  };
  const retryEdit = async () => {
    const next = editValue.trim();
    if (!editableUserMessage || retryingEdit || (!next && !message.attachments?.length)) return;
    setRetryingEdit(true);
    const saved = await editUserMessage(message.id, next, message.attachments);
    setRetryingEdit(false);
    if (saved) setEditing(false);
  };
  return (
    <div
      className={`message-row ${isSessionMessage ? "session-message" : isUser ? "user" : message.role}`}
      data-minimap-id={message.id}
      data-message-id={message.id}
      data-row-role={isSessionMessage ? undefined : "user"}
      role="article"
      aria-label={isSessionMessage ? t("sessionCollaboration.agentMessage") : isUser ? t("chat.userMessage") : t("chat.assistantMessage")}
    >
      <div className="message-col">
        {message.sessionMessage ? <SessionMessageOrigin origin={message.sessionMessage} /> : null}
        {/* Slot 1 (`entry`): a whole transcript message. A registration replaces
          * the message the host draws — bubble and actions alike — so the mount
          * hands the component the message the row was going to draw, not just
          * the row's identity (spec 07-plugins/16 2A.5). Without a registration
          * this is the host's own rendering unchanged (ADR 0291). While the user
          * is editing the row the form is host-owned, so the position renders the
          * host's own message instead of a plugin's card. */}
        <PluginSlot
          slot="entry"
          slotProps={entryProps}
          candidates={entryCandidates}
          registrations={editing ? NO_REGISTRATIONS : undefined}
        >
        {isUser || displayed ? (
          <div className="message-bubble">
            {editing && editableUserMessage ? (
              <form
                className="message-edit"
                aria-busy={retryingEdit || undefined}
                onSubmit={(event) => {
                  event.preventDefault();
                  void retryEdit();
                }}
              >
                <textarea
                  className="message-edit-input selectable"
                  value={editValue}
                  rows={Math.min(12, Math.max(3, editValue.split("\n").length))}
                  aria-label={editLabel}
                  autoFocus
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  disabled={retryingEdit}
                  onChange={(event) => setEditValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      cancelEdit();
                    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void retryEdit();
                    }
                  }}
                />
                <div className="message-edit-actions">
                  <button
                    type="button"
                    className="icon-btn message-edit-cancel"
                    disabled={retryingEdit}
                    onClick={cancelEdit}
                  >
                    {t("chat.cancelEdit")}
                  </button>
                  <button
                    type="submit"
                    className="send-btn message-edit-submit"
                    disabled={retryingEdit || (!editValue.trim() && !message.attachments?.length)}
                  >
                    {retryingEdit ? t("chat.retryingEdit") : t("chat.retryEdit")}
                  </button>
                </div>
              </form>
            ) : isUser ? (
              <>
                {extraAttachments.length ? (
                  <div
                    className="message-attachments"
                    role="list"
                    aria-label={t("chat.messageAttachments")}
                  >
                    {extraAttachments.map((attachment) =>
                      attachment.kind === "image" ? (
                        <MessageAttachmentImage
                          key={`${attachment.ref}:${attachment.name}`}
                          attachment={attachment}
                          onOpenFile={openFileRef}
                        />
                      ) : (
                        <span
                          key={`${attachment.ref}:${attachment.name}`}
                          role="listitem"
                        >
                          <FileRefChip
                            name={attachment.name}
                            path={attachment.ref}
                            kind={attachment.kind}
                            onOpen={openFileRef}
                          />
                        </span>
                      ),
                    )}
                  </div>
                ) : null}
                {rewrite ? (
                  // Slot #1 (ADR 0295 rule 5): the user's own words stay on the
                  // row, and this is where the plugin that changed what the
                  // model read is named — expanded to the text the model
                  // received, or to the changed spans when the record was
                  // capped and cannot rebuild it exactly.
                  <details
                    className="message-rewrite"
                    data-rewrite-plugin={rewrite.pluginId}
                    data-rewrite-truncated={rewrite.truncated ? "true" : undefined}
                  >
                    <summary className="message-rewrite-summary">
                      <IconPlug size={13} />
                      <span>{t("chat.rewrittenByPlugin", { name: rewriteName })}</span>
                    </summary>
                    <div className="message-rewrite-body">
                      <span className="message-rewrite-label">
                        {t("chat.rewriteModelVersion")}
                      </span>
                      {rewriteModelText !== null ? (
                        <div className="message-rewrite-text selectable">
                          {rewriteModelText}
                        </div>
                      ) : (
                        <ul className="message-rewrite-spans selectable">
                          {(rewrite.diff.characterEdits ?? []).map((edit, index) => (
                            <li key={index}>
                              <del>{edit.before}</del>
                              <ins>{edit.after}</ins>
                            </li>
                          ))}
                        </ul>
                      )}
                      {rewrite.truncated || rewriteModelText === null ? (
                        <p className="message-rewrite-note">
                          {t("chat.rewritePartial")}
                        </p>
                      ) : null}
                    </div>
                  </details>
                ) : null}
                {message.content ? (
                  <div className="message-user-text selectable">
                    {editableUserMessage && message.command ? (
                      // Slash invocations show the typed form as a chip; the
                      // expanded template body lives in `content` (hover reveals
                      // it) and is what regenerate/reseed replay (D123).
                      <code
                        className="chat-command-chip"
                        data-source-start={0}
                        data-source-end={message.content.length}
                        title={String(message.content || "")}
                      >
                        {message.command}
                      </code>
                    ) : (
                      <LinkifiedText text={String(message.content || "")} />
                    )}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="prose-chat">
                <Markdown source={displayed} />
              </div>
            )}
          </div>
        ) : null}
        {!editing && (hasAnswer || showRevisionPager) ? (
          <div className="message-actions">
            {showRevisionPager ? (
              <div className="message-revision-pager" role="group" aria-label={t("chat.revisions")}>
                <TooltipButton
                  className="copy-btn icon revision-nav"
                  tooltip={t("chat.revisionPrev")}
                  ariaLabel={t("chat.revisionPrev")}
                  disabled={isRunning || activeRevision <= 1}
                  onClick={() =>
                    void activateMessageRevision(message.id, Math.max(1, activeRevision - 1))
                  }
                >
                  <IconChevronLeft size={13} />
                </TooltipButton>
                <span className="message-revision-label">
                  {t("chat.revisionPager", {
                    current: activeRevision,
                    total: revisionCount,
                  })}
                </span>
                <TooltipButton
                  className="copy-btn icon revision-nav"
                  tooltip={t("chat.revisionNext")}
                  ariaLabel={t("chat.revisionNext")}
                  disabled={isRunning || activeRevision >= revisionCount}
                  onClick={() =>
                    void activateMessageRevision(
                      message.id,
                      Math.min(revisionCount, activeRevision + 1),
                    )
                  }
                >
                  <IconChevronRight size={13} />
                </TooltipButton>
              </div>
            ) : null}
            {hasAnswer ? <CopyButton text={message.content} label={copyLabel} /> : null}
            {editableUserMessage ? (
              <TooltipButton
                className="copy-btn icon"
                tooltip={editLabel}
                ariaLabel={editLabel}
                disabled={isRunning}
                onClick={() => {
                  setEditValue(editSeed);
                  setEditing(true);
                }}
              >
                <IconPencil size={13} />
              </TooltipButton>
            ) : null}
            {editableUserMessage ? (
              <TooltipButton
                className="copy-btn icon danger"
                tooltip={deleteLabel}
                ariaLabel={deleteLabel}
                disabled={isRunning}
                onClick={() => void deleteMessage(message.id)}
              >
                <IconTrash size={13} />
              </TooltipButton>
            ) : null}
          </div>
        ) : null}
        </PluginSlot>
        {/* Slot 13: appended below everything the host itself renders. This
          * area only adds to the entry — slot 1 owns replacing it — so the
          * boundary's fallback is nothing (ADR 0291). It is handed the entry's
          * identity alone: nothing here replaces a host surface. */}
        {sessionId ? (
          <PluginSlot
            slot="entryExtra"
            slotProps={entryIdentityProps}
            candidates={entryCandidates}
          />
        ) : null}
      </div>
    </div>
  );
});
