import { invoke } from "@tauri-apps/api/core";
import type { MediaFile } from "./types";
import { isAudioPath, isVideoPath } from "./file-kinds";

export function mediaSource(media: MediaFile): string {
  return `data:${media.mime};base64,${media.data}`;
}

export async function renderAudioView(host: HTMLElement, path: string): Promise<void> {
  await renderAvView(host, path, "audio");
}

export async function renderVideoView(host: HTMLElement, path: string): Promise<void> {
  await renderAvView(host, path, "video");
}

async function renderAvView(host: HTMLElement, path: string, kind: "audio" | "video"): Promise<void> {
  host.replaceChildren();
  host.classList.add("media-av-viewer");
  const status = document.createElement("div");
  status.className = "feature-loading";
  status.textContent = `Loading ${path}…`;
  host.appendChild(status);
  try {
    const media = await invoke<MediaFile>("read_media_file", { path });
    const player = document.createElement(kind);
    player.className = kind === "audio" ? "audio-player" : "video-player";
    player.setAttribute("controls", "");
    player.setAttribute("preload", "metadata");
    player.src = mediaSource(media);
    const caption = document.createElement("div");
    caption.className = "media-av-caption";
    caption.textContent = path;
    host.replaceChildren(caption, player);
  } catch (error) {
    host.replaceChildren();
    const failed = document.createElement("div");
    failed.className = "feature-error";
    failed.textContent = `Could not play ${kind}: ${String(error)}`;
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Open with default app";
    open.addEventListener("click", () => void invoke("open_with_default_app", { path }));
    host.append(failed, open);
  }
}

export function clearMediaView(host: HTMLElement): void {
  host.replaceChildren();
}

export async function hydrateWikilinkAudio(
  link: HTMLAnchorElement,
  resolved: string,
  target: string,
): Promise<boolean> {
  if (!isAudioPath(resolved)) return false;
  const frame = document.createElement("div");
  frame.className = "audio-embed";
  frame.dataset.audioPath = resolved;
  frame.setAttribute("aria-label", target);
  link.replaceWith(frame);
  await renderAudioView(frame, resolved);
  return true;
}

export async function hydrateWikilinkVideo(
  link: HTMLAnchorElement,
  resolved: string,
  target: string,
): Promise<boolean> {
  if (!isVideoPath(resolved)) return false;
  const frame = document.createElement("div");
  frame.className = "video-embed";
  frame.dataset.videoPath = resolved;
  frame.setAttribute("aria-label", target);
  link.replaceWith(frame);
  await renderVideoView(frame, resolved);
  return true;
}
