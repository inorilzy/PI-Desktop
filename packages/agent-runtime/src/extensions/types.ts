/**
 * Trusted extensions (D387, ADR 0214, spec 07-plugins/16-trusted-extensions.md).
 *
 * The wire shapes live in `@pi-desktop/shared`; this module re-exports them
 * for the sidecar-side code and adds nothing else.
 */
export {
  TRUSTED_EXTENSION_HANDLER_TIMEOUT_MS,
  TRUSTED_EXTENSION_KERNEL_VERSION,
  TRUSTED_EXTENSION_PROMPT_TIMEOUT_MS,
  TRUSTED_EXTENSION_RECAP_DEFAULT_LIMIT,
  TRUSTED_EXTENSION_RECAP_MAX_LIMIT,
  TRUSTED_EXTENSION_SESSION_READ_PERMISSION,
  type TrustedExtensionCommand,
  type TrustedExtensionContinuation,
  type TrustedExtensionContinuationRequest,
  type TrustedExtensionDiagnostic,
  type TrustedExtensionDiagnosticKind,
  type TrustedExtensionLoadReport,
  type TrustedExtensionLoadState,
  type TrustedExtensionSource,
  type TrustedExtensionSpec,
  type TrustedExtensionToolCallFacts,
  type TrustedExtensionToolCallSummary,
  type TrustedExtensionTurnFacts,
  type TrustedExtensionTurnFile,
  type TrustedExtensionTurnRecap,
  type TrustedExtensionTurnTokens,
  type TrustedExtensionUiPrompt,
  type TrustedExtensionUiRequest,
  type TrustedExtensionUiRequestEnvelope,
  type TrustedExtensionUiResponse,
} from "@pi-desktop/shared";
