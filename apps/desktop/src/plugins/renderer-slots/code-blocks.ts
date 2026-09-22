/**
 * The `codeBlock` slot: which fenced language a plugin may claim, and which
 * component draws it (spec 07-plugins/16 §2A.5, issue #545 item 3).
 *
 * A fenced language is the slot's identity: one language has exactly one
 * renderer, the plugin that claims it first keeps it (D13), and the language has
 * to be namespaced with that plugin's own id so no plugin can shadow another
 * plugin's language — or one the host renders itself. `pluginSlots.register` is
 * the gate that enforces the rule; this module is the rule it enforces, plus the
 * lookup the transcript uses to find the component for a block.
 *
 * The two modules therefore reference each other: the registry imports the rule
 * from here and the lookup reads the registry back. Both directions are used
 * inside a function body, never while a module is evaluated, so no import order
 * can observe a half-initialized module.
 */
import { MAX_MERMAID_SOURCE_LENGTH } from "../../lib/mermaid";
import { pluginSlots, type PluginSlotRegistration } from "./registry";

/**
 * Languages the host renders itself: `json` and `ts` go through the highlighter,
 * `mermaid` through `<MermaidBlock>`. A plugin may not claim one.
 */
export const RESERVED_LANGUAGES = ["json", "ts", "mermaid"] as const;

/**
 * The most source a plugin-rendered block may carry, deliberately the same
 * number the host applies to a mermaid source (`MAX_MERMAID_SOURCE_LENGTH`).
 * Both ceilings answer the same question — how much text the host hands a
 * synchronous renderer inside a transcript that is still streaming — so a second,
 * plugin-only budget would let a plugin diagram grow larger than the host's own.
 * Past the limit the block degrades to the host's source rendering.
 */
export const MAX_PLUGIN_CODE_BLOCK_SOURCE_LENGTH = MAX_MERMAID_SOURCE_LENGTH;

/** True when a block is past the ceiling and must degrade to source text. */
export function codeBlockSourceTooLarge(code: string): boolean {
  return code.length > MAX_PLUGIN_CODE_BLOCK_SOURCE_LENGTH;
}

/** True for a name the host keeps for its own renderers. */
export function isReservedLanguage(language: string): boolean {
  return RESERVED_LANGUAGES.some((reserved) => reserved === language);
}

/** The diagnostic codes a refused `codeBlock` language reports. */
export type CodeBlockLanguageDiagnostic =
  | "PLUGIN_SLOT_LANGUAGE_MISSING"
  | "PLUGIN_SLOT_LANGUAGE_RESERVED"
  | "PLUGIN_SLOT_LANGUAGE_INVALID";

export type CodeBlockLanguageProblem = {
  code: CodeBlockLanguageDiagnostic;
  detail: string;
};

/**
 * The language a registration claims, trimmed; `""` when the plugin passed
 * nothing usable. Normalizing here is what lets the registry store the value it
 * validated instead of repeating the rule.
 */
export function normalizeCodeBlockLanguage(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Why `pluginId` may not register `language`, or null when it may. A refused
 * language is reported by the registry and never enters the list, so
 * `codeBlockComponentFor` can never reach it.
 */
export function codeBlockLanguageProblem(
  pluginId: string,
  language: string,
): CodeBlockLanguageProblem | null {
  if (!language) {
    return {
      code: "PLUGIN_SLOT_LANGUAGE_MISSING",
      detail: "a codeBlock registration declares which fenced language it renders",
    };
  }
  if (isReservedLanguage(language)) {
    return {
      code: "PLUGIN_SLOT_LANGUAGE_RESERVED",
      detail: `"${language}" is rendered by the host`,
    };
  }
  const prefix = `${pluginId}:`;
  if (!language.startsWith(prefix) || language.length === prefix.length) {
    return {
      code: "PLUGIN_SLOT_LANGUAGE_INVALID",
      detail: `"${language}" must be namespaced with the registering plugin's own id, like "${pluginId}:chart"`,
    };
  }
  return null;
}

/** A `codeBlock` registration: the registry guarantees it carries a language. */
export type PluginCodeBlockRegistration = PluginSlotRegistration & { language: string };

/**
 * The first component registered for `language`, or null when no plugin claims
 * it — the block then keeps the host's own source rendering (D13: registration
 * order wins, so a language has exactly one renderer).
 *
 * `registrations` is the live list for a caller that already holds one: a
 * mounted block passes what its registry subscription returned, which is what
 * makes a registration that arrives later visible. Without one the lookup reads
 * the registry directly.
 */
export function codeBlockComponentFor(
  language: string,
  registrations: readonly PluginSlotRegistration[] = pluginSlots.list("codeBlock"),
): PluginCodeBlockRegistration | null {
  return (
    registrations.find(
      (registration): registration is PluginCodeBlockRegistration =>
        registration.language === language,
    ) ?? null
  );
}
