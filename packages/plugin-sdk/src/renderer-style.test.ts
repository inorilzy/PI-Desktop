import { describe, expect, it, vi } from "vitest";
import {
  isPluginRendererReplaceSlot,
  scopePluginStyle,
  PLUGIN_RENDERER_ACTIONS,
  PLUGIN_RENDERER_AMBIENT_DATA,
  PLUGIN_RENDERER_DATA,
  PLUGIN_RENDERER_REPLACE_SLOTS,
  PLUGIN_RENDERER_SLOTS,
  PLUGIN_RENDERER_UNSERVED_DATA,
  PLUGIN_SLOT_DESIGN_TOKENS,
  PLUGIN_STYLE_FORBIDDEN_ROOT_SELECTORS,
} from "./renderer.js";

// This package compiles without Node typings (its tsconfig sets no `types`), so
// the parity test below reaches the two Node builtins it needs through Vitest's
// own loader rather than a static `import ... from "node:fs"` that would not
// resolve in this package's program.
const { readFileSync } = await vi.importActual<{
  readFileSync(path: string, encoding: "utf8"): string;
}>("node:fs");
const { fileURLToPath } = await vi.importActual<{ fileURLToPath(url: URL): string }>("node:url");

const CONTAINER = '[data-pi-plugin="acme.one"]';

/** The refusal `scopePluginStyle` is expected to throw for `css`. */
function refusalFor(css: string): Error & { code?: string } {
  try {
    scopePluginStyle("acme.one", css);
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error(`expected ${JSON.stringify(css)} to be refused`);
}

describe("scopePluginStyle selector scoping", () => {
  it("scopes a plain rule under the plugin container", () => {
    const scoped = scopePluginStyle("acme.one", ".card { color: red }");
    expect(scoped).toContain(`${CONTAINER} .card`);
    expect(scoped).toBe(`${CONTAINER} .card{ color: red }`);
  });

  it("rewrites :root to the container instead of refusing it", () => {
    expect(scopePluginStyle("acme.one", ":root { --x: 1px }")).toBe(`${CONTAINER}{ --x: 1px }`);
    expect(scopePluginStyle("acme.one", ":root[data-theme='light'] .card { color: red }")).toBe(
      `${CONTAINER}[data-theme='light'] .card{ color: red }`,
    );
    expect(scopePluginStyle("acme.one", ":root .card { color: red }")).toBe(
      `${CONTAINER} .card{ color: red }`,
    );
    expect(scopePluginStyle("acme.one", ":root:is(.dark) .card { color: red }")).toBe(
      `${CONTAINER}:is(.dark) .card{ color: red }`,
    );
  });

  it("scopes every part of a selector list and rejoins the list", () => {
    expect(scopePluginStyle("acme.one", ".a, .b { }")).toBe(`${CONTAINER} .a, ${CONTAINER} .b{ }`);
  });

  it("leaves a selector already under this plugin's container alone", () => {
    expect(scopePluginStyle("acme.one", `${CONTAINER} .card { color: red }`)).toBe(
      `${CONTAINER} .card{ color: red }`,
    );
    expect(scopePluginStyle("acme.one", `${CONTAINER}.x { color: red }`)).toBe(
      `${CONTAINER}.x{ color: red }`,
    );
    expect(scopePluginStyle("acme.one", `${CONTAINER}>span { color: red }`)).toBe(
      `${CONTAINER}>span{ color: red }`,
    );
    // `html` under the container is a descendant of the plugin's own subtree,
    // not a host root, so it is left as written.
    expect(scopePluginStyle("acme.one", `${CONTAINER} html { color: red }`)).toBe(
      `${CONTAINER} html{ color: red }`,
    );
  });

  it("refuses html, body, and * as top-level selectors", () => {
    for (const css of [
      "html { color: red }",
      "body { color: red }",
      "* { color: red }",
      ".a, html { }",
    ]) {
      const error = refusalFor(css);
      expect(error.code, css).toBe("PLUGIN_STYLE_REFUSED");
      expect(error.message, css).toMatch(/^PLUGIN_STYLE_REFUSED:/);
    }
  });

  it("refuses a host root nested in a conditional group", () => {
    const error = refusalFor("@media (min-width: 600px) { html { } }");
    expect(error.code).toBe("PLUGIN_STYLE_REFUSED");
    expect(error.message).toBe('PLUGIN_STYLE_REFUSED: "html" targets a host root');
  });

  it("does not mistake a longer type selector for html or body", () => {
    expect(scopePluginStyle("acme.one", "html5 { color: red }")).toBe(`${CONTAINER} html5{ color: red }`);
  });

  it("refuses @import even though it is not a selector", () => {
    const error = refusalFor('@import url("x.css"); .a { color: red }');
    expect(error.code).toBe("PLUGIN_STYLE_REFUSED");
    expect(error.message).toBe(
      "PLUGIN_STYLE_REFUSED: @import is not allowed in an injected plugin sheet",
    );
  });

  it("drops comments before scoping, so a commented root selector or @import is not refused", () => {
    expect(scopePluginStyle("acme.one", "/* html { } */ .a { color: red }")).toBe(
      `${CONTAINER} .a{ color: red }`,
    );
    expect(scopePluginStyle("acme.one", '/* @import "x.css"; */ .a { color: red }')).toBe(
      `${CONTAINER} .a{ color: red }`,
    );
  });

  it("escapes quotes and backslashes in the plugin id's container selector", () => {
    expect(scopePluginStyle('acme"one\\x', ".card { color: red }")).toBe(
      '[data-pi-plugin="acme\\"one\\\\x"] .card{ color: red }',
    );
  });

  it("returns an empty sheet for empty or blank input", () => {
    expect(scopePluginStyle("acme.one", "")).toBe("");
    expect(scopePluginStyle("acme.one", "  \n\t ")).toBe("");
  });

  it("keeps an unclosed or stray brace as text instead of failing", () => {
    expect(scopePluginStyle("acme.one", ".a { color: red")).toBe(`${CONTAINER} .a{ color: red`);
    expect(scopePluginStyle("acme.one", ".a } .b { color: red }")).toBe(
      `.a }${CONTAINER} .b{ color: red }`,
    );
  });

  it("leaves a nested rule body verbatim, which CSS nesting keeps scoped", () => {
    expect(scopePluginStyle("acme.one", ".a { .nested { color: red } }")).toBe(
      `${CONTAINER} .a{ .nested { color: red } }`,
    );
  });
});

describe("scopePluginStyle name rewriting", () => {
  it("prefixes @keyframes names with the sanitized plugin id", () => {
    expect(
      scopePluginStyle("acme.one", "@keyframes fade { from { opacity: 0 } to { opacity: 1 } }"),
    ).toBe("@keyframes pi-acme_one-fade { from { opacity: 0 } to { opacity: 1 } }");
    // Every character outside [A-Za-z0-9_-] becomes `_` in the prefix.
    expect(scopePluginStyle("acme:v2", "@keyframes fade { }")).toBe("@keyframes pi-acme_v2-fade { }");
  });

  it("normalizes @-webkit-keyframes to the same prefixed name", () => {
    expect(scopePluginStyle("acme.one", "@-webkit-keyframes fade { from { opacity: 0 } }")).toBe(
      "@keyframes pi-acme_one-fade { from { opacity: 0 } }",
    );
  });

  it("rewrites animation names but leaves timing keywords and prefixed names alone", () => {
    expect(
      scopePluginStyle("acme.one", ".a { animation: fade 1s infinite; animation-name: fade }"),
    ).toBe(
      `${CONTAINER} .a{ animation: pi-acme_one-fade 1s infinite; animation-name: pi-acme_one-fade }`,
    );
    expect(scopePluginStyle("acme.one", ".a { animation: fade 1s ease-in-out }")).toBe(
      `${CONTAINER} .a{ animation: pi-acme_one-fade 1s ease-in-out }`,
    );
    expect(scopePluginStyle("acme.one", ".a { animation-name: pi-acme_one-fade }")).toBe(
      `${CONTAINER} .a{ animation-name: pi-acme_one-fade }`,
    );
    // `animation-delay` is a different property, not an animation name.
    expect(scopePluginStyle("acme.one", ".a { animation-delay: 1s }")).toBe(
      `${CONTAINER} .a{ animation-delay: 1s }`,
    );
  });

  it("prefixes @font-face families in quoted and unquoted form", () => {
    expect(
      scopePluginStyle("acme.one", '@font-face { font-family: "Acme"; src: url(x.woff2) }'),
    ).toBe('@font-face { font-family: "pi-acme_one-Acme"; src: url(x.woff2) }');
    expect(
      scopePluginStyle("acme.one", "@font-face { font-family: 'Acme'; src: url(x.woff2) }"),
    ).toBe("@font-face { font-family: 'pi-acme_one-Acme'; src: url(x.woff2) }");
    expect(
      scopePluginStyle("acme.one", "@font-face { font-family: Acme; src: url(x.woff2) }"),
    ).toBe('@font-face { font-family: "pi-acme_one-Acme"; src: url(x.woff2) }');
  });

  it("prefixes a @keyframes nested in @media exactly once, so its animation-name still resolves", () => {
    const scoped = scopePluginStyle(
      "acme.one",
      "@media (min-width: 600px) { @keyframes fade { from { opacity: 0 } } .a { animation-name: fade } }",
    );
    expect(scoped).toBe(
      `@media (min-width: 600px) {@keyframes pi-acme_one-fade { from { opacity: 0 } }${CONTAINER} .a{ animation-name: pi-acme_one-fade }}`,
    );
    // Exactly one prefix: the declaration and the rule that resolves it agree.
    expect((scoped.match(/pi-acme_one-fade/g) ?? []).length).toBe(2);
    expect(scoped).not.toContain("pi-acme_one-pi-acme_one");
  });

  it("prefixes a @font-face nested in @media exactly once", () => {
    const scoped = scopePluginStyle(
      "acme.one",
      "@media print { @font-face { font-family: Acme; src: url(x.woff2) } .a { font-family: Acme } }",
    );
    expect(scoped).toBe(
      `@media print {@font-face { font-family: "pi-acme_one-Acme"; src: url(x.woff2) }${CONTAINER} .a{ font-family: Acme }}`,
    );
    expect((scoped.match(/pi-acme_one-Acme/g) ?? []).length).toBe(1);
    expect(scoped).not.toContain("pi-acme_one-pi-acme_one");
  });
});

describe("scopePluginStyle conditional groups", () => {
  it("recurses into @media and scopes every inner selector", () => {
    expect(scopePluginStyle("acme.one", "@media (min-width: 600px) { .a { } .b { } }")).toBe(
      `@media (min-width: 600px) {${CONTAINER} .a{ }${CONTAINER} .b{ }}`,
    );
  });

  it("recurses into @supports, @layer, and @container", () => {
    expect(scopePluginStyle("acme.one", "@supports (display: grid) { .a { color: red } }")).toBe(
      `@supports (display: grid) {${CONTAINER} .a{ color: red }}`,
    );
    expect(scopePluginStyle("acme.one", "@layer base { .a { color: red } }")).toBe(
      `@layer base {${CONTAINER} .a{ color: red }}`,
    );
    expect(scopePluginStyle("acme.one", "@container (min-width: 300px) { .a { color: red } }")).toBe(
      `@container (min-width: 300px) {${CONTAINER} .a{ color: red }}`,
    );
  });
});

describe("scopePluginStyle unknown at-rules", () => {
  it("scopes the selectors of an at-rule it does not know, like @media", () => {
    expect(scopePluginStyle("acme.one", "@starting-style { .a { opacity: 0 } }")).toBe(
      `@starting-style {${CONTAINER} .a{ opacity: 0 }}`,
    );
    expect(
      scopePluginStyle(
        "acme.one",
        "@media (min-width: 600px) { @starting-style { .a { opacity: 0 } } }",
      ),
    ).toBe(`@media (min-width: 600px) {@starting-style {${CONTAINER} .a{ opacity: 0 }}}`);
  });

  it("refuses a host root inside an unknown block at-rule", () => {
    for (const css of [
      "@starting-style { body { color: red } }",
      "@starting-style { * { color: red } }",
      "@media print { @starting-style { html { color: red } } }",
    ]) {
      const error = refusalFor(css);
      expect(error.code, css).toBe("PLUGIN_STYLE_REFUSED");
      expect(error.message, css).toMatch(/^PLUGIN_STYLE_REFUSED:/);
    }
  });

  it("leaves an at-rule without a block as written", () => {
    expect(
      scopePluginStyle(
        "acme.one",
        '@charset "utf-8"; @namespace svg url(http://www.w3.org/2000/svg); .a { color: red }',
      ),
    ).toBe(
      `@charset "utf-8"; @namespace svg url(http://www.w3.org/2000/svg);${CONTAINER} .a{ color: red }`,
    );
  });
});

describe("scopePluginStyle verbatim at-rule bodies", () => {
  it("copies every descriptor / keyframe-step at-rule body through unchanged", () => {
    const cases: [string, string][] = [
      ["@keyframes fade { from { opacity: 0 } }", "@keyframes pi-acme_one-fade { from { opacity: 0 } }"],
      [
        "@-webkit-keyframes fade { from { opacity: 0 } }",
        "@keyframes pi-acme_one-fade { from { opacity: 0 } }",
      ],
      [
        '@font-face { font-family: "Acme"; src: url(x.woff2) }',
        '@font-face { font-family: "pi-acme_one-Acme"; src: url(x.woff2) }',
      ],
      ["@page :first { margin: 1cm }", "@page :first { margin: 1cm }"],
      [
        '@property --acme-x { syntax: "<color>"; inherits: false; initial-value: red }',
        '@property --acme-x { syntax: "<color>"; inherits: false; initial-value: red }',
      ],
      [
        '@counter-style acme-dot { system: cyclic; symbols: "\u2022" }',
        '@counter-style acme-dot { system: cyclic; symbols: "\u2022" }',
      ],
      ["@font-feature-values Acme { @styleset { nice: 1 } }", "@font-feature-values Acme { @styleset { nice: 1 } }"],
      ["@color-profile --swop5c { src: url(x.icc) }", "@color-profile --swop5c { src: url(x.icc) }"],
      ["@viewport { width: device-width }", "@viewport { width: device-width }"],
    ];
    for (const [css, expected] of cases) {
      const scoped = scopePluginStyle("acme.one", css);
      expect(scoped, css).toBe(expected);
      // None of these bodies is a rule list, so no inner selector was scoped.
      expect(scoped, css).not.toContain(CONTAINER);
    }
  });
});

describe("renderer data vocabulary", () => {
  it("serves only theme and locale as ambient props", () => {
    expect(PLUGIN_RENDERER_AMBIENT_DATA).toEqual(["theme", "locale"]);
  });

  it("declares selection as the one unserved data key", () => {
    expect(PLUGIN_RENDERER_UNSERVED_DATA).toEqual(["selection"]);
  });

  it("keeps every ambient and unserved key inside the declarable list", () => {
    for (const key of [...PLUGIN_RENDERER_AMBIENT_DATA, ...PLUGIN_RENDERER_UNSERVED_DATA]) {
      expect(PLUGIN_RENDERER_DATA).toContain(key);
    }
  });
});

describe("replace slots", () => {
  it("names the four whole-slot claims", () => {
    expect(PLUGIN_RENDERER_REPLACE_SLOTS).toEqual(["entry", "toolCard", "inlineConfirm", "modal"]);
  });

  it("answers the slot predicate like the array does", () => {
    expect(isPluginRendererReplaceSlot("entry")).toBe(true);
    expect(isPluginRendererReplaceSlot("entryExtra")).toBe(false);
    for (const slot of PLUGIN_RENDERER_SLOTS) {
      expect(isPluginRendererReplaceSlot(slot), slot).toBe(
        (PLUGIN_RENDERER_REPLACE_SLOTS as readonly string[]).includes(slot),
      );
    }
  });
});

describe("published style vocabulary", () => {
  it("keeps :root out of the forbidden root selectors", () => {
    expect(PLUGIN_STYLE_FORBIDDEN_ROOT_SELECTORS).toEqual(["html", "body", "*"]);
    expect(PLUGIN_STYLE_FORBIDDEN_ROOT_SELECTORS as readonly string[]).not.toContain(":root");
    expect(() => scopePluginStyle("acme.one", ":root { --x: 1px }")).not.toThrow();
  });

  it("lists composer draft reads and writes among the renderer actions", () => {
    expect(PLUGIN_RENDERER_ACTIONS).toContain("composer.readDraft");
    expect(PLUGIN_RENDERER_ACTIONS).toContain("composer.replaceDraft");
  });
});

const slotShellCssPath = fileURLToPath(
  new URL("../../../apps/desktop/src/plugins/renderer-slots/slot-shell.css", import.meta.url),
);

describe("slot-shell.css parity", () => {
  // Comments are prose, not selectors or declarations, so the checks below
  // read the sheet with them removed.
  const css = readFileSync(slotShellCssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const scopeStart = css.indexOf(".pi-plugin-slot {");
  const containerBlock = css.slice(scopeStart, css.indexOf("}", scopeStart) + 1);

  it("defines the 17 published tokens on the .pi-plugin-slot container", () => {
    expect(scopeStart, "the .pi-plugin-slot rule").toBeGreaterThan(-1);
    expect(PLUGIN_SLOT_DESIGN_TOKENS).toHaveLength(17);
    for (const token of PLUGIN_SLOT_DESIGN_TOKENS) {
      expect(token.startsWith("--pi-slot-"), token).toBe(true);
      expect(containerBlock, token).toContain(`${token}:`);
    }
  });

  it("publishes exactly the token list the SDK exports", () => {
    const defined = [...css.matchAll(/--pi-slot-[a-z0-9-]+(?=\s*:)/g)].map((match) => match[0]);
    expect(new Set(defined)).toEqual(new Set(PLUGIN_SLOT_DESIGN_TOKENS));
  });

  it("publishes the slot primitives only inside the .pi-plugin-slot scope", () => {
    const scoped = [...css.matchAll(/\.pi-plugin-slot\s+(\.[\w-]+)/g)].map((match) => match[1]);
    expect(new Set(scoped)).toEqual(new Set([".pi-slot-btn", ".pi-slot-chip", ".pi-slot-field"]));
    // Removing every scoped primitive leaves no `.pi-slot-*` selector behind.
    expect(css.replace(/\.pi-plugin-slot\s+\.[\w-]+/g, "")).not.toMatch(/\.pi-slot-/);
  });
});
