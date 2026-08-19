import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { JSDOM, VirtualConsole } from "jsdom";
import { pluginIframeDocument, type PluginDescriptor } from "../ui/src/plugin-host";

type Fixture = {
  id: string;
  name: string;
  version: string;
  url: string;
  sha256: string;
  expectedSettings: number;
};

const fixtures: Fixture[] = [{
  id: "obsidian-style-settings",
  name: "Style Settings",
  version: "1.0.9",
  url: "https://github.com/community-archive/obsidian-style-settings/releases/download/1.0.9/main.js",
  sha256: "1828abaacdab4c5578b705a625c585b30512f8efad4c7cfc5a18e70cc3557468",
  expectedSettings: 1,
}, {
  id: "cmdr",
  name: "Commander",
  version: "0.5.8",
  url: "https://github.com/phibr0/obsidian-commander/releases/download/0.5.8/main.js",
  sha256: "7f9ce5d2c79b1f87dd00363c7451d93831dfa166fae9acc6f151c4d75f8cea5e",
  expectedSettings: 1,
}, {
  id: "obsidian-admonition",
  name: "Admonition",
  version: "12.0.5",
  url: "https://github.com/javalent/admonitions/releases/download/12.0.5/main.js",
  sha256: "29a455fb179f7024c3e0a5d52962c4160935ebd053ac75e035b87944e24722e1",
  expectedSettings: 1,
}, {
  id: "calendar",
  name: "Calendar",
  version: "2.0.0-beta.2",
  url: "https://github.com/liamcain/obsidian-calendar-plugin/releases/download/2.0.0-beta.2/main.js",
  sha256: "64d1c6c620803246724bc922c5c2e0a17c406ffc23f6bbcfbfb14c643958fbb7",
  expectedSettings: 1,
}, {
  id: "advanced-tables",
  name: "Advanced Tables",
  version: "0.23.2",
  url: "https://github.com/tgrosinger/advanced-tables-obsidian/releases/download/0.23.2/main.js",
  sha256: "cf5dd4ddbddebef68cc99cd93a883e33895c7f123d04bc5d1106ea6e338ba791",
  expectedSettings: 1,
}, {
  id: "obsidian-kanban",
  name: "Kanban",
  version: "2.0.51",
  url: "https://github.com/community-archive/obsidian-kanban/releases/download/2.0.51/main.js",
  sha256: "a7e3bd4cf25f9b7f53a841c44ce990db0ef5f7954ebcab17ae6dca80310c39ac",
  expectedSettings: 1,
}, {
  id: "recent-files-obsidian",
  name: "Recent Files",
  version: "1.7.10",
  url: "https://github.com/tgrosinger/recent-files-obsidian/releases/download/1.7.10/main.js",
  sha256: "9a85d22a342d6bc8cfcbfe89a8ed04cdfdb444c370a220b008e4423f1fd37dc8",
  expectedSettings: 1,
}];

async function smoke(fixture: Fixture): Promise<void> {
  const response = await fetch(fixture.url, { headers: { "User-Agent": "Nephrite plugin compatibility test" } });
  if (!response.ok) throw new Error(`${fixture.name}: download returned ${response.status}`);
  const source = await response.text();
  const digest = createHash("sha256").update(source).digest("hex");
  assert.equal(digest, fixture.sha256, `${fixture.name}: pinned release checksum changed`);

  const descriptor: PluginDescriptor = {
    id: fixture.id,
    name: fixture.name,
    version: fixture.version,
    description: "Pinned real-world compatibility fixture",
    permissions: ["vault.read", "vault.write", "workspace.commands", "workspace.views"],
    api_version: 1,
    min_app_version: null,
    compatibility: "obsidian",
    source,
  };
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(String(error.cause?.stack || error.stack)));
  const dom = new JSDOM(pluginIframeDocument(descriptor), {
    runScripts: "dangerously",
    url: "https://plugin.nephrite.invalid/",
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window, "TextDecoder", { value: TextDecoder });
      Object.defineProperty(window, "TextEncoder", { value: TextEncoder });
      Object.defineProperty(window, "requestAnimationFrame", { value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0) });
      Object.defineProperty(window, "cancelAnimationFrame", { value: (id: number) => window.clearTimeout(id) });
      window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message?.nephritePlugin) return;
        if (message.type === "request") {
          const result = message.method === "plugins.loadData" ? {}
            : message.method === "vault.list" ? []
              : true;
          window.dispatchEvent(new window.MessageEvent("message", { data: {
            nephriteHost: true,
            pluginId: fixture.id,
            type: "response",
            requestId: message.requestId,
            result,
          } }));
        } else if (message.type === "ready") {
          window.dispatchEvent(new window.MessageEvent("message", { data: {
            nephriteHost: true,
            pluginId: fixture.id,
            type: "load",
            requestId: 1,
            files: [],
            metadata: [],
            activeFile: null,
          } }));
        } else if (message.type === "error") {
          errors.push(String(message.message || "Plugin bootstrap failed"));
        } else if (message.type === "callback" && message.error) {
          errors.push(String(message.error));
        }
      });
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const instance = (dom.window as unknown as {
    __obsidianPluginInstance?: { _settingTabs?: unknown[] };
  }).__obsidianPluginInstance;
  assert.deepEqual(errors, [], `${fixture.name}: runtime errors:\n${errors.join("\n")}`);
  assert.ok(instance, `${fixture.name}: plugin instance was not created`);
  assert.ok((instance._settingTabs?.length || 0) >= fixture.expectedSettings, `${fixture.name}: settings tab was not registered`);
  dom.window.close();
  console.log(`✓ ${fixture.name} ${fixture.version}`);
}

for (const fixture of fixtures) await smoke(fixture);
