import { executeBlocksInSubtree, extractScriptBlocks, type EngineContext } from "./dv-engine";
import { renderBlockHtml } from "./preview";

/** Rebuild dynamic source blocks after metadata changes, retaining unrelated DOM. */
export async function refreshPreviewDynamics(
  blocks: string[],
  root: HTMLElement,
  context: EngineContext,
  current: () => boolean,
  processHtml?: (html: string) => Promise<string>,
): Promise<void> {
  for (let index = 0; index < blocks.length; index++) {
    if (!current()) return;
    const previous = root.querySelector<HTMLElement>(`:scope > .md-block[data-block-index="${index}"]`);
    if (!previous) continue;
    const hasInline = Array.from(previous.querySelectorAll("code")).some(code => !code.closest("pre"));
    if (!previous.querySelector(".dv-block, .dv-inline") && !hasInline && !extractScriptBlocks(blocks[index]).length) continue;
    let html = renderBlockHtml(blocks[index], index);
    if (processHtml) html = await processHtml(html);
    if (!current()) return;
    const template = document.createElement("template");
    template.innerHTML = html.trim();
    const fresh = template.content.firstElementChild as HTMLElement | null;
    if (!fresh) continue;
    previous.replaceWith(fresh);
    await executeBlocksInSubtree(blocks[index], fresh, context, current);
  }
}
