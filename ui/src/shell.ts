/**
 * Shell expansion for Nephrite JS hooks / automation.
 *
 *   const out = await $("git status --short");
 *   const out = await $`ls -la ${dir}`;
 *   const full = await $$("false"); // { stdout, stderr, code, ok }
 *
 * Commands run on the host via Tauri (`shell_command`).
 * Default cwd is the open vault root.
 */

import { invoke } from "@tauri-apps/api/core";

export type ShellResult = {
  stdout: string;
  stderr: string;
  code: number;
  ok: boolean;
};

export type ShellOptions = {
  /** Working directory (absolute, or vault-relative). Default: vault root. */
  cwd?: string;
  /** Kill after this many ms (default 60_000). */
  timeoutMs?: number;
  /** If true, non-zero exit does not throw from `$` (still returns stdout). */
  nothrow?: boolean;
};

function buildCommand(
  cmd: string | TemplateStringsArray,
  values: unknown[],
): string {
  if (typeof cmd === "string") return cmd;
  // Template tag: $`echo ${name}`
  let out = "";
  for (let i = 0; i < cmd.length; i++) {
    out += cmd[i];
    if (i < values.length) out += String(values[i] ?? "");
  }
  return out;
}

/** Full result; never throws on non-zero exit. */
export async function $$(
  cmd: string | TemplateStringsArray,
  ...values: unknown[]
): Promise<ShellResult> {
  // Last arg may be options if plain-string form was misused — keep simple:
  // only string | template for command. Options via shell(cmd, opts).
  const command = buildCommand(cmd, values);
  return invoke<ShellResult>("shell_command", {
    command,
    cwd: null,
    timeoutMs: 60_000,
  });
}

/**
 * Shell expansion: returns stdout (trailing newline stripped).
 * Throws if exit code !== 0 (unless you use `$$` or `shell(..., { nothrow: true })`).
 *
 *   await $("date")
 *   await $`git -C ${vault} status`
 */
export async function $(
  cmd: string | TemplateStringsArray,
  ...values: unknown[]
): Promise<string> {
  const r = await $$(cmd, ...values);
  if (!r.ok) {
    const msg = (r.stderr || r.stdout || `exit ${r.code}`).trim();
    throw new Error(msg || `Command failed with code ${r.code}`);
  }
  return r.stdout.replace(/\n$/, "");
}

/** Explicit form with options. */
export async function shell(
  command: string,
  opts: ShellOptions = {},
): Promise<ShellResult | string> {
  const r = await invoke<ShellResult>("shell_command", {
    command,
    cwd: opts.cwd ?? null,
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
  if (opts.nothrow) return r;
  if (!r.ok) {
    const msg = (r.stderr || r.stdout || `exit ${r.code}`).trim();
    throw new Error(msg || `Command failed with code ${r.code}`);
  }
  return r.stdout.replace(/\n$/, "");
}
