import { invoke } from "@tauri-apps/api/core";

export type SyncSettings = {
  provider: string;
  continuous: boolean;
  remoteVault: string;
  mode: string;
  conflictStrategy: string;
  fileTypes: string[];
  configs: string[];
  excludedFolders: string[];
  deviceName: string;
};

export type ProviderSettings = {
  remoteVault: string;
  mode: string;
  conflictStrategy: string;
  fileTypes: string[];
  configs: string[];
  excludedFolders: string[];
  deviceName: string;
};

export type SyncStatus = {
  provider: string;
  phase: string;
  message: string;
  active: boolean;
  synced: boolean;
};

export type SyncSnapshot = {
  settings: SyncSettings;
  status: SyncStatus;
  vaultPath: string;
  obPath: string | null;
  nodeReady: boolean;
  remoteVaultsError?: string | null;
  loggedIn: boolean;
  configured: boolean;
  settingsSaved: boolean;
  remotes: Array<{ id: string; name: string; region: string }>;
  providerSettings: ProviderSettings | null;
  obsidianSettings: ProviderSettings | null;
  obsidianSettingsError: string | null;
};

export const loadSyncState = () => invoke<SyncSnapshot>("sync_state");

function checkedValues(host: HTMLElement, name: string): string[] {
  return [...host.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)].map((input) => input.value);
}

function option(value: string, label: string, selected: boolean): HTMLOptionElement {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  item.selected = selected;
  return item;
}

type SyncField = { value: string; checked?: boolean; label?: string; revealed?: boolean };
const syncDrafts = new Map<string, Map<string, SyncField>>();
const syncPanelVaults = new WeakMap<HTMLElement, string>();
const syncDraftListeners = new WeakSet<HTMLElement>();
const fieldKey = (field: HTMLInputElement | HTMLSelectElement) => field.id || `${field.name}:${field.value}`;

function captureSyncDraft(host: HTMLElement) {
  const vault = syncPanelVaults.get(host);
  if (!vault || !host.querySelector("#sync-login-form")) return;
  const draft = syncDrafts.get(vault) ?? new Map<string, SyncField>();
  for (const field of host.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")) {
    draft.set(fieldKey(field), { value: field.value,
      revealed: field.hasAttribute("data-sync-password") ? (field as HTMLInputElement).type === "text" : undefined,
      checked: field.tagName === "INPUT" ? (field as HTMLInputElement).checked : undefined,
      label: field.tagName === "SELECT" ? (field as HTMLSelectElement).selectedOptions[0]?.textContent ?? undefined : undefined });
  }
  syncDrafts.set(vault, draft);
}

function restoreSyncDraft(host: HTMLElement, vault: string) {
  const draft = syncDrafts.get(vault);
  if (!draft) return;
  for (const field of host.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")) {
    const saved = draft.get(fieldKey(field));
    if (!saved) continue;
    if (field.id === "sync-remote" && saved.value && ![...(field as HTMLSelectElement).options].some(item => item.value === saved.value)) {
      field.append(option(saved.value, saved.label || saved.value, true));
    }
    if (saved.revealed !== undefined) (field as HTMLInputElement).type = saved.revealed ? "text" : "password";
    field.value = saved.value;
    if (saved.checked !== undefined) (field as HTMLInputElement).checked = saved.checked;
  }
}

function showSyncError(host: HTMLElement, error: unknown) {
  const message = host.querySelector<HTMLElement>("#sync-message") ?? host.firstElementChild as HTMLElement | null;
  if (!message) return;
  message.classList.remove("success");
  message.classList.add("error");
  message.textContent = String(error);
  message.setAttribute("role", "alert");
  message.setAttribute("aria-live", "assertive");
  message.tabIndex = -1;
  host.scrollTop = 0;
  message.focus({ preventScroll: true });
}

export function updateSyncPanelStatus(host: HTMLElement, status: SyncStatus) {
  const label = host.querySelector<HTMLElement>("#sync-current-status");
  if (!label) return;
  label.textContent = status.message;
  if (status.phase === "error") showSyncError(host, status.message);
}

export async function renderSyncPanel(
  host: HTMLElement,
  onStatus: (status: SyncStatus) => void,
): Promise<void> {
  captureSyncDraft(host);
  if (!syncDraftListeners.has(host)) {
    host.addEventListener("input", () => captureSyncDraft(host));
    host.addEventListener("change", () => captureSyncDraft(host));
    syncDraftListeners.add(host);
  }
  host.innerHTML = '<div class="feature-loading">Inspecting sync providers…</div>';
  let snapshot: SyncSnapshot;
  try {
    snapshot = await loadSyncState();
  } catch (error) {
    host.innerHTML = '<div class="feature-empty"></div>';
    showSyncError(host, `Sync is unavailable: ${String(error)}`);
    return;
  }
  draw(snapshot);

  function draw(state: SyncSnapshot) {
    captureSyncDraft(host);
    syncPanelVaults.set(host, state.vaultPath);
    onStatus(state.status);
    host.innerHTML = `
      <div class="sync-settings">
        <div id="sync-message" class="sync-message" role="status" aria-live="polite"></div>
        <div class="sync-summary">
          <strong>Obsidian Headless</strong><small id="sync-provider-state"></small>
          <strong>Local vault</strong><small id="sync-vault-path"></small>
          <strong>Status</strong><small id="sync-current-status"></small>
          <strong>Policy comparison</strong><small id="sync-provider-policy"></small>
        </div>
        <div class="sync-actions">
          <button type="button" id="sync-install">Install ob</button>
          <button type="button" id="sync-refresh">Refresh status</button>
          <button type="button" id="sync-now">Sync now</button>
        </div>
        <form id="sync-login-form" class="sync-form">
          <fieldset>
            <legend>Obsidian account</legend>
            <label>Email<input type="email" id="sync-email" autocomplete="username" /></label>
            <label>Account password<span class="sync-password-field"><input type="password" data-sync-password id="sync-account-password" autocomplete="current-password" /><button type="button" class="sync-password-toggle" data-password-toggle="sync-account-password" data-password-name="account password"></button></span></label>
            <label>MFA code (if requested)<input type="text" id="sync-mfa" inputmode="numeric" autocomplete="one-time-code" /></label>
            <button type="submit">Log in</button>
          </fieldset>
        </form>
        <form id="sync-config-form" class="sync-form">
          <fieldset>
            <legend>Provider</legend>
            <label>Sync method<select id="sync-provider"><option value="obsidian_headless">Obsidian Sync (Headless)</option></select></label>
            <small>The provider boundary is shared by startup, shutdown, status, and settings; future peer-to-peer, Ring, and GitHub methods can use the same lifecycle.</small>
          </fieldset>
          <fieldset>
            <legend>Vault</legend>
            <label>Remote vault<select id="sync-remote"></select></label>
            <small id="sync-remote-error" class="error" role="status"></small>
            <label>End-to-end encryption password<span class="sync-password-field"><input type="password" data-sync-password id="sync-encryption-password" autocomplete="off" placeholder="Required only for initial setup" /><button type="button" class="sync-password-toggle" data-password-toggle="sync-encryption-password" data-password-name="encryption password"></button></span></label>
            <label>Device name<input type="text" id="sync-device-name" /></label>
            <label>Direction<select id="sync-mode"><option value="bidirectional">Bidirectional</option><option value="pull-only">Pull only</option><option value="mirror-remote">Mirror remote</option></select></label>
            <label>Conflicts<select id="sync-conflict"><option value="merge">Merge</option><option value="conflict">Create conflict copy</option></select></label>
          </fieldset>
          <fieldset>
            <legend>Selective sync</legend>
            <small>Obsidian stores these choices privately per device. Nephrite will not infer them from <code>ob</code>. Select the same choices used by this Obsidian installation; nothing is selected by default, so large videos cannot be pulled accidentally.</small>
            <div id="sync-file-types" class="sync-checks"></div>
            <label>Excluded folders (comma-separated)<input type="text" id="sync-excluded" placeholder="Archive, video" /></label>
          </fieldset>
          <fieldset>
            <legend>Obsidian configuration</legend>
            <div id="sync-configs" class="sync-checks"></div>
          </fieldset>
          <label class="preference-toggle"><input type="checkbox" id="sync-continuous" /><span>Continuous sync while Nephrite is running</span></label>
          <div class="sync-actions"><button type="submit">${state.settingsSaved ? "Apply settings" : "Apply settings and perform initial sync"}</button></div>
        </form>
      </div>`;
    const text = (id: string, value: string) => { host.querySelector<HTMLElement>(`#${id}`)!.textContent = value; };
    text("sync-provider-state", state.obPath ? `Installed: ${state.obPath}${state.loggedIn ? " · logged in" : " · login required"}` : "Not installed — Install ob sets up its dependencies automatically");
    text("sync-vault-path", state.vaultPath);
    text("sync-remote-error", state.remoteVaultsError || (state.loggedIn && !state.remotes.length ? "Logged in, but no remote vaults are available for this account." : ""));
    text("sync-current-status", state.status.message);
    renderPolicyComparison(host.querySelector("#sync-provider-policy")!, state);
    const install = host.querySelector<HTMLButtonElement>("#sync-install")!;
    install.disabled = !!state.obPath;
    host.querySelector<HTMLButtonElement>("#sync-now")!.disabled = !state.configured || !state.settingsSaved || state.status.active;
    const loginButton = host.querySelector<HTMLButtonElement>("#sync-login-form button[type=submit]")!;
    loginButton.disabled = !state.obPath;
    loginButton.textContent = state.loggedIn ? "Log in again" : "Log in";
    const form = host.querySelector<HTMLFormElement>("#sync-config-form")!;
    form.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled = !state.loggedIn;
    const remote = host.querySelector<HTMLSelectElement>("#sync-remote")!;
    remote.replaceChildren(option("", state.remotes.length ? "Choose a vault…" : "No remote vaults available", !state.settings.remoteVault));
    for (const vault of state.remotes) remote.append(option(vault.id, `${vault.name}${vault.region ? ` · ${vault.region}` : ""}`, state.settings.remoteVault === vault.id || state.settings.remoteVault === vault.name));
    host.querySelector<HTMLInputElement>("#sync-device-name")!.value = state.settings.deviceName;
    host.querySelector<HTMLSelectElement>("#sync-mode")!.value = state.settings.mode;
    host.querySelector<HTMLSelectElement>("#sync-conflict")!.value = state.settings.conflictStrategy;
    host.querySelector<HTMLInputElement>("#sync-excluded")!.value = state.settings.excludedFolders.join(", ");
    host.querySelector<HTMLInputElement>("#sync-continuous")!.checked = state.settings.continuous;
    renderChecks(host.querySelector("#sync-file-types")!, "fileType", ["image", "audio", "video", "pdf", "unsupported"], state.settings.fileTypes);
    renderChecks(host.querySelector("#sync-configs")!, "config", ["app", "appearance", "appearance-data", "hotkey", "core-plugin", "core-plugin-data", "community-plugin", "community-plugin-data"], state.settings.configs);
    restoreSyncDraft(host, state.vaultPath);
    for (const button of host.querySelectorAll<HTMLButtonElement>("[data-password-toggle]")) {
      const field = host.querySelector<HTMLInputElement>(`#${button.dataset.passwordToggle}`)!;
      const update = () => {
        const shown = field.type === "text";
        const label = `${shown ? "Hide" : "Show"} ${button.dataset.passwordName}`;
        button.setAttribute("aria-label", label);
        button.setAttribute("aria-controls", field.id);
        button.setAttribute("aria-pressed", String(shown));
        button.title = label;
        button.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>${shown ? '<path d="m3 3 18 18"/>' : ''}</svg>`;
      };
      update();
      button.addEventListener("click", event => {
        event.preventDefault();
        field.type = field.type === "password" ? "text" : "password";
        update();
        captureSyncDraft(host);
      });
    }
    if (state.status.phase === "error") showSyncError(host, state.status.message);
    else if (state.remoteVaultsError) showSyncError(host, state.remoteVaultsError);

    const run = async (
      action: () => Promise<SyncSnapshot>,
      pending: string,
      success?: string | ((next: SyncSnapshot) => string),
    ) => {
      const message = host.querySelector<HTMLElement>("#sync-message")!;
      message.classList.remove("error", "success"); message.setAttribute("role", "status"); message.setAttribute("aria-live", "polite"); message.textContent = pending;
      try {
        snapshot = await action();
        draw(snapshot);
        if (snapshot.status.phase === "error" || snapshot.remoteVaultsError) return;
        if (success) {
          const confirmation = host.querySelector<HTMLElement>("#sync-message")!;
          confirmation.classList.add("success");
          confirmation.textContent = typeof success === "function" ? success(snapshot) : success;
        }
      }
      catch (error) { showSyncError(host, error); }
    };
    install.addEventListener("click", async () => {
      install.disabled = true;
      const refresh = host.querySelector<HTMLButtonElement>("#sync-refresh")!;
      refresh.disabled = true;
      try {
        await run(() => invoke("sync_install_ob"), "Setting up Obsidian Headless and its dependencies. This may take a few minutes…", "Obsidian Headless is ready. Log in to continue.");
      } finally {
        if (install.isConnected) install.disabled = false;
        if (refresh.isConnected) refresh.disabled = false;
      }
    });
    host.querySelector("#sync-refresh")!.addEventListener("click", () => void run(loadSyncState, "Refreshing provider state…"));
    host.querySelector("#sync-now")!.addEventListener("click", () => void run(() => invoke("sync_now"), "Starting sync…"));
    host.querySelector<HTMLFormElement>("#sync-login-form")!.addEventListener("submit", (event) => {
      event.preventDefault();
      const button = host.querySelector<HTMLButtonElement>("#sync-login-form button[type=submit]")!;
      if (button.disabled) return;
      button.disabled = true;
      void run(async () => {
        const next = await invoke<SyncSnapshot>("sync_login", { request: {
          email: host.querySelector<HTMLInputElement>("#sync-email")!.value,
          password: host.querySelector<HTMLInputElement>("#sync-account-password")!.value,
          mfa: host.querySelector<HTMLInputElement>("#sync-mfa")!.value,
        } });
        if (!next.loggedIn) throw new Error("Obsidian did not confirm login. Check the account details and MFA code, then retry.");
        return next;
      }, "Logging in to Obsidian…", "Logged in to Obsidian.").finally(() => {
        if (button.isConnected) button.disabled = false;
      });
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const settings: SyncSettings = {
        provider: "obsidian_headless",
        continuous: host.querySelector<HTMLInputElement>("#sync-continuous")!.checked,
        remoteVault: remote.value,
        mode: host.querySelector<HTMLSelectElement>("#sync-mode")!.value,
        conflictStrategy: host.querySelector<HTMLSelectElement>("#sync-conflict")!.value,
        fileTypes: checkedValues(host, "fileType"), configs: checkedValues(host, "config"),
        excludedFolders: host.querySelector<HTMLInputElement>("#sync-excluded")!.value.split(",").map((value) => value.trim()).filter(Boolean),
        deviceName: host.querySelector<HTMLInputElement>("#sync-device-name")!.value.trim(),
      };
      void run(
        () => invoke("sync_configure", { request: { settings, encryptionPassword: host.querySelector<HTMLInputElement>("#sync-encryption-password")!.value } }),
        state.settingsSaved ? "Applying settings…" : "Applying settings and starting the initial sync…",
        (next) => next.status.message,
      );
    });
  }
}

function policySummary(policy: ProviderSettings): string {
  return `attachments: ${policy.fileTypes.join(", ") || "none"}; configuration: ${policy.configs.join(", ") || "none"}; excluded: ${policy.excludedFolders.join(", ") || "none"}; conflicts: ${policy.conflictStrategy || "unknown"}`;
}

function difference(leftName: string, left: ProviderSettings, rightName: string, right: ProviderSettings): string[] {
  const messages: string[] = [];
  const compare = (field: "fileTypes" | "configs" | "excludedFolders", noun: string, consequence: string) => {
    const missing = left[field].filter((value) => !right[field].includes(value));
    const extra = right[field].filter((value) => !left[field].includes(value));
    if (missing.length) messages.push(`${rightName} is missing ${noun} selected in ${leftName}: ${missing.join(", ")}. ${consequence}`);
    if (extra.length) messages.push(`${rightName} adds ${noun} not selected in ${leftName}: ${extra.join(", ")}.`);
  };
  compare("fileTypes", "attachment types", "Those files will not sync there.");
  compare("configs", "configuration categories", "Those Obsidian settings will not sync there.");
  compare("excludedFolders", "exclusions", "Those paths may be synced there.");
  if (left.conflictStrategy && right.conflictStrategy && left.conflictStrategy !== right.conflictStrategy) {
    messages.push(`${leftName} resolves conflicts with “${left.conflictStrategy}”; ${rightName} uses “${right.conflictStrategy}”.`);
  }
  return messages;
}

function renderPolicyComparison(host: HTMLElement, state: SyncSnapshot) {
  host.replaceChildren();
  const nephrite: ProviderSettings | null = state.settingsSaved ? {
    remoteVault: state.settings.remoteVault,
    mode: state.settings.mode,
    conflictStrategy: state.settings.conflictStrategy,
    fileTypes: state.settings.fileTypes,
    configs: state.settings.configs,
    excludedFolders: state.settings.excludedFolders,
    deviceName: state.settings.deviceName,
  } : null;
  const policies: Array<[string, ProviderSettings | null, string]> = [
    ["Obsidian", state.obsidianSettings, state.obsidianSettingsError || "Policy unavailable"],
    ["ob", state.providerSettings, "Not linked to this vault"],
    ["Nephrite", nephrite, "Settings have not been applied"],
  ];
  const list = document.createElement("div");
  list.className = "sync-policy-list";
  for (const [name, policy, unavailable] of policies) {
    const row = document.createElement("div");
    const label = document.createElement("strong");
    const details = document.createElement("span");
    label.textContent = name;
    details.textContent = policy ? policySummary(policy) : unavailable;
    row.append(label, details);
    list.append(row);
  }
  host.append(list);
  const differences = document.createElement("ul");
  differences.className = "sync-policy-differences";
  const messages: string[] = [];
  if (state.obsidianSettings && state.providerSettings) messages.push(...difference("Obsidian", state.obsidianSettings, "ob", state.providerSettings));
  if (state.obsidianSettings && nephrite) messages.push(...difference("Obsidian", state.obsidianSettings, "Nephrite", nephrite));
  if (state.providerSettings && nephrite) messages.push(...difference("ob", state.providerSettings, "Nephrite", nephrite));
  const unique = [...new Set(messages)];
  if (!unique.length && policies.every(([, policy]) => policy)) {
    const item = document.createElement("li");
    item.className = "match";
    item.textContent = "All three policies match.";
    differences.append(item);
  } else {
    for (const message of unique) {
      const item = document.createElement("li");
      item.textContent = message;
      differences.append(item);
    }
  }
  host.append(differences);
}

function renderChecks(host: HTMLElement, name: string, values: string[], selected: string[]) {
  host.replaceChildren();
  for (const value of values) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox"; input.name = name; input.value = value; input.checked = selected.includes(value);
    label.append(input, value.replaceAll("-", " "));
    host.append(label);
  }
}
