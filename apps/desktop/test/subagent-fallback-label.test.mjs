import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { createServer } from "vite";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("fallback rows show configured provider names without changing model pins", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { SubagentFallbackModels } = await server.ssrLoadModule(
      "/src/components/settings/SubagentFallbackModels.tsx",
    );
    const i18n = createInstance();
    await i18n.init({ lng: "en", interpolation: { escapeValue: false }, resources: { en: { translation: {
      extensions: { subagents: {
        fallbackMoveUp: "Move {{model}} up",
        fallbackMoveDown: "Move {{model}} down",
        fallbackRemove: "Remove {{model}}",
      } },
    } } } });
    const render = (values, choices) => renderToStaticMarkup(
      createElement(I18nextProvider, { i18n }, createElement(SubagentFallbackModels, {
        primary: "",
        values,
        choices,
        onChange() {},
      })),
    );
    const pin = "721fcc76-026e-4f35-a32d-5e2a8d204499/deepseek-v4.1-flash";
    const choices = [{
      value: "other-provider/deepseek-v4.1-flash",
      modelId: "deepseek-v4.1-flash",
      providerId: "other-provider",
      providerName: "Other Workspace",
      vendorKey: "custom",
    }, {
      value: pin,
      modelId: "deepseek-v4.1-flash",
      providerId: "721fcc76-026e-4f35-a32d-5e2a8d204499",
      providerName: "DeepSeek Workspace",
      vendorKey: "custom",
    }];
    const html = render([pin], choices);
    assert.match(html, /DeepSeek Workspace\/deepseek-v4\.1-flash/);
    assert.match(html, /aria-label="Remove DeepSeek Workspace\/deepseek-v4\.1-flash"/);
    assert.doesNotMatch(html, /721fcc76-026e-4f35-a32d-5e2a8d204499/);
    assert.doesNotMatch(html, /1\. Other Workspace\/deepseek-v4\.1-flash/);

    const unavailable = render([pin], []);
    assert.match(unavailable, /721fcc76-026e-4f35-a32d-5e2a8d204499\/deepseek-v4\.1-flash/);
  } finally {
    await server.close();
  }
});
