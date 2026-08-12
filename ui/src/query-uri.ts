/** Format an exact scalar as a safe semantic URI anchor when applicable. */
export function formatQueryUri(value: string, fieldHint = ""): string | null {
  const display = value.trim();
  if (!display || display !== value) return null;

  let href = "";
  let kind: "email" | "phone" | "web";
  const hinted = classifyUriField(fieldHint);
  if ((hinted === "email" && /^[^\s@]+@[^\s@]+$/.test(display)) ||
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(display)) {
    href = `mailto:${display}`;
    kind = "email";
  } else if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(display)) {
    href = display;
    kind = "email";
  } else if (/^tel:\+?[\d().\s-]{7,}$/i.test(display)) {
    href = `tel:${display.slice(4).replace(/[^\d+]/g, "")}`;
    kind = "phone";
  } else if (looksLikePhone(display) ||
      (hinted === "phone" && /^\+?[\d().\s-]+$/.test(display) &&
        display.replace(/\D/g, "").length >= 7)) {
    href = `tel:${display.replace(/[^\d+]/g, "")}`;
    kind = "phone";
  } else if (/^https?:\/\/[^\s]+$/i.test(display)) {
    href = display;
    kind = "web";
  } else if (/^www\.[^\s]+$/i.test(display)) {
    href = `https://${display}`;
    kind = "web";
  } else if (hinted === "web" &&
      /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#][^\s]*)?$/i.test(display)) {
    href = `https://${display}`;
    kind = "web";
  } else {
    return null;
  }

  const mime = kind === "web"
    ? inferUriMime(href)
    : kind === "email"
      ? "message/rfc822"
      : "text/plain";
  const type = mime ? ` type="${escapeHtml(mime)}"` : "";
  return `<a class="query-uri query-uri-${kind}" href="${escapeHtml(href)}"` +
    ` data-query-uri="${escapeHtml(href)}" data-uri-kind="${kind}"${type}>${escapeHtml(display)}</a>`;
}

function classifyUriField(fieldHint: string): "email" | "phone" | "web" | null {
  const field = fieldHint
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  const tokens = new Set(field.split("_").filter(Boolean));
  if (tokens.has("email") || tokens.has("e-mail") || tokens.has("mail")) return "email";
  if (["phone", "telephone", "tel", "mobile", "cell", "fax"].some((token) => tokens.has(token))) {
    return "phone";
  }
  if (["url", "uri", "website", "homepage", "linkedin", "github", "portfolio"].some(
    (token) => tokens.has(token),
  )) return "web";
  return null;
}

function looksLikePhone(value: string): boolean {
  if (!/^[+(\d][\d().\s-]{5,}[\d)]$/.test(value)) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const digits = value.replace(/\D/g, "").length;
  return digits >= 10 || (digits >= 7 && /[()+.\s]/.test(value));
}

function inferUriMime(href: string): string | null {
  let extension = "";
  try {
    const path = new URL(href).pathname;
    extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  } catch {
    return null;
  }
  const types: Record<string, string> = {
    html: "text/html", htm: "text/html", txt: "text/plain", css: "text/css",
    csv: "text/csv", json: "application/json", xml: "application/xml",
    pdf: "application/pdf", zip: "application/zip",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
    mp4: "video/mp4", webm: "video/webm",
  };
  return types[extension] ?? "text/html";
}

export function bindQueryUriLinks(container: ParentNode): void {
  container.querySelectorAll<HTMLAnchorElement>("a[data-query-uri]").forEach((link) => {
    if (link.dataset.queryUriBound === "1") return;
    link.dataset.queryUriBound = "1";
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const uri = link.dataset.queryUri;
      if (uri) {
        link.dispatchEvent(new CustomEvent("nephrite-open-external", {
          bubbles: true,
          detail: { uri, mime: link.type || null },
        }));
      }
    });
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
