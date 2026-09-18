# Product design principles

Accepted for Nephrite on 2026-09-09. These principles guide product decisions and permanent behavioral contracts. They apply across features, independently of the incident or implementation that first exposed a problem.

## Interaction and feedback

1. **Show what is happening.** Distinguish loading, checking, saving, completion, and failure. Status must reflect actual state and stop reporting problems that have been resolved.
2. **Speak the user's language.** Explain tasks and problems without requiring knowledge of internal machinery. Do not present an unverified diagnosis as fact.
3. **Keep the user in control.** Provide cancellation, escape, undo, and redo where applicable.
4. **Follow familiar conventions.** Standard shortcuts and controls behave as users expect on their platform.
5. **Prevent avoidable mistakes.** Explain constraints before submission and make destructive actions deliberate. Routine reversible work should not accumulate confirmation dialogs.
6. **Keep needed information available.** Do not require remembering values from another screen.
7. **Support efficient, repeated use.** Provide shortcuts, bulk operations, and customization for frequent tasks.
8. **Make every visual element useful.** Remove interface elements that serve no functional purpose. Guidance, feedback, navigation, accessibility, and useful grouping count as functionality; decorative clutter does not. Preserve needed actions and information while removing redundant controls and containers.
9. **Make errors actionable.** Identify the failure, preserve work, and offer useful recovery. Make the error noticeable and reachable; do not leave it hidden above the current scroll position.
10. **Put help where it is needed.** Explain unfamiliar options beside the relevant action.
11. **Make completion unmistakable.** Finished operations have clear results and do not leave indefinite spinners.
12. **Make recovery cheap.** Correct one invalid field without restarting the entire process.
13. **Avoid surprising the user.** Background activity must not unexpectedly change focus, position, or selections.
14. **Accommodate different abilities and experience.** Essential functionality remains usable with different input methods and levels of expertise.

## Product judgment

15. **Start with the actual task.** Design around what the person is trying to accomplish.
16. **Make the system absorb complexity.** Automatically handle discoverable information and routine setup where possible.
17. **Design for real operating conditions.** Account for split panes, large vaults, slow connections, interrupted work, and supported platforms.
18. **Use evidence to challenge assumptions.** Validate layouts and workflows with realistic content and actual usage.
19. **Reuse successful patterns thoughtfully.** Familiar behavior carries across features; justify differences through the task.
20. **Evaluate the complete workflow.** Login, selection, configuration, execution, and recovery must work together.
21. **Improve through observed use.** Revisit designs when experience exposes friction.
22. **Adapt without losing content or functionality.** Resizing and zooming preserve access. Wrap or scroll as appropriate; wide tables can have their own scrolling region.
23. **Do not demand the same information repeatedly.** Carry entered information through the process. Any necessary exception must have a concrete reason; rerendering is not a reason to erase inputs.

## Permanent product contracts

24. **Never silently make content inaccessible.** Wrap, scroll, expand, summarize with access to the original, or explain a creation limit. Hover text may supplement access, but keyboard users must also be able to retrieve the full content. Silent clipping is a defect.
25. **Every nonempty display has an accountable result.** Show its content, a meaningful empty-result state, or an error. Every callout preserves access to its content through rendering, editing, refreshes, and resizing. Apply the same contract to supported and custom types, nested callouts, and expanded/collapsed states. A rendering failure must not become unexplained blank space. User-requested collapsing may conceal the body only while leaving a clear way to reveal it.
26. **Respect interface boundaries.** Content cannot paint over scrollbars, escape the app window, or make controls unreachable. Intentional overlays stay within the app and obey a deliberate layering design.
27. **Preserve work and context; no security theater.** Refreshes and failures retain drafts, entered credentials, selections, and relevant navigation state throughout the active workflow. Changes in state must not silently overwrite unsaved input. Do not clear fields, reset selections, remove password-reveal controls, or force repeated entry merely by invoking generic security claims. Keeping entered credentials available in the active interface does not require logging them or persisting them to disk. Any actual requirement to invalidate or remove a credential must be concrete and explained, preserve unrelated work, and provide a direct recovery path. Test this contract across authentication success, failure, retry, and subsequent configuration steps as well as ordinary refreshes.
28. **Keep actions near the work.** Support editing tasks in the main editor. Introduce another interface when it demonstrably improves productivity.
29. **Presentation never damages storage.** Opening, rendering, and indexing preserve authoritative source files. Valid YAML retains its meaning; malformed YAML remains intact and receives a useful diagnostic. Unsupported syntax is preserved. Only intentional edits modify source.
30. **Failures remain local.** One broken query or renderer must not erase unrelated content or disable the workspace.
31. **Make limits deliberate and explainable.** Width caps, timeouts, and size limits need a user-facing purpose and a defined boundary behavior.
32. **Protect established behavior as the product grows.** New features continue satisfying the same permanent contracts. Do not remove or weaken a contract to make a changed implementation pass.

## Be boring, and respect real-world data

33. **Be boring.** Before creating an interface or wizard, look for an existing flow in the project serving a similar purpose. Reuse its components, behavior, and interaction model. Create a new pattern only when a concrete unmet need warrants it; do not merely duplicate existing markup into a divergent implementation.
34. **Dr. Doofenschmirtz: no convenient self-destruct button.** Keep destructive, irreversible, or broad-scope actions away from routine controls and default actions. Separate them clearly, label their actual scope, prefer recovery or undo where possible, and require deliberate activation proportional to the consequence. Do not make every harmless action inconvenient in the name of safety.
35. **Be even more boring: use the least intrusive interface that completes the task.** Match the screen element to the interaction required. Do not introduce a wizard merely to ask for confirmation, or a query-by-example (QBE) interface when a search bar will do. Prefer an inline control or message when it suffices; use a dialog or multi-step flow only when the task requires that structure. Add complexity only for demonstrated needs and preserve the simple route. Keep any necessary deliberate activation for destructive actions proportionate to the consequence.
36. **Offer formatting without inventing constraints.** Formatting is a convenience, not authority over user data. Do not assume a universal phone number, Social Security number, or driver's license format. Preserve meaningful characters and leading zeros. Allow correction and unformatted entry. Enforce only explicit requirements of the actual operation, jurisdiction, or external service, with their scope explained; do not extrapolate one service's rule to all stored data.
37. **Separate identity, natural keys, and indexes.** A natural key is a domain value or combination used to identify a record; an index is an access structure and may support an explicitly chosen uniqueness constraint. Neither proves permanence. Names, addresses, phone numbers, government identifiers, and file paths can change, be corrected, collide, or be reassigned. Model those changes without losing identity or relationships. Use internal identifiers where appropriate, with explicit lifecycle rules; do not introduce authoritative data into Nephrite's disposable index. Treat claims of real-world immutability as assumptions requiring evidence and a correction path.

38. **Show the interpretation before acting.** For date entry, accept flexible text and show its interpreted ISO calendar date (`YYYY-MM-DD`) in an adjacent label as the user types. Preserve the original input for correction. If no valid date can be interpreted, show a red diagnostic in that label and disable the action; provide explanatory text and an accessible status so color is not the only signal. The action consumes the exact validated date represented by the current label, never a separate interpretation of the raw input. Clear any stale valid candidate immediately when input changes; pending or invalid interpretation cannot submit through clicking, Enter, or another activation path. Make any locale or relative-date assumptions apparent when they affect interpretation. Do not silently normalize impossible dates into different dates. This is assistance for operations requiring a date, not a mandate to rewrite stored free text.
39. **Chunk data for comprehension.** For generated answers, query results, and reports, aim for a preview of roughly 25 readable lines; up to about 50 may suit a deliberately dense expert view. These are presentation guidelines, not scientific limits on human ability or hard storage limits. When results exceed the useful preview, create a complete data file in an appropriate reusable format and show a compact preview with the total size and a clear open/save link. Identify what subset is shown; never imply the preview is the complete answer. Account for wrapped lines and available pane space. Preserve the full result, including meaningful characters and leading zeros. If the file cannot be created, show the failure and retain access to the result. Do not apply this rule to truncate user-authored documents or force their editor into a preview.

## Inviolable data contract

**All subtractive changes to authoritative user data must originate in direct user action, never in an independent process decision.** This includes deleting records or files, clearing fields, shortening or replacing content in a way that removes existing information, and accepting a replacement that discards an existing version.

A process may execute the user's explicit removal, but the authority comes from that action and is limited to its defined target and scope. Opening, saving, rendering, indexing, synchronization, cleanup, authentication, error recovery, or a general automation setting does not independently authorize data loss. An empty or partial process result is not evidence that the user intended deletion. A save persists an intentional edit; it does not authorize inventing a subtractive edit.

Before committing a subtractive change, the application must be able to associate it with the direct user action that authorized the exact removal. A delayed action must not remove newer data or act on a different current selection. If that association cannot be established, retain the existing data and expose the unresolved operation. Rebuilding disposable caches remains permissible only because it removes no authoritative user data.

Regression contract: without a direct user removal action, process execution cannot reduce or discard authoritative user information. Exercise failed reads, empty loading states, partial results, delayed writes, refreshes, synchronization, and recovery. Also verify that explicit user deletions affect only their authorized targets. Byte counts alone are not an adequate oracle: shorter serialization can preserve information, while same-length replacement can destroy it.

## Apply the principles

For the work at hand, identify relevant principles, inspect existing patterns, and describe the intended user outcome before choosing mechanics. Resolve tradeoffs through the task and explicit user requirements. These principles do not authorize unrelated redesigns, new dependencies, or extra approval ceremonies.

Turn observable consequences into permanent tests at the layer where failure is experienced. Visibility requires rendered application checks, not merely finding an element in a DOM. Scrollbar layering and app boundaries need actual layout and native-platform verification. Data preservation needs comparison of authoritative files and values. Exercise content variations and sequences such as edit, resize, refresh, fail, retry, and reopen.

Where practical, deliberately violate the tested guarantee in an isolated fixture or temporary change and confirm the test fails. Restore the change. Do not perform destructive experiments on a live vault. A passing helper test or a large test count is not evidence that these user outcomes are protected. Report what was actually exercised and any gaps.

## Sources and scope

Principles 1–10 adapt [Jakob Nielsen's usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/); 11–14 draw on [Ben Shneiderman's interface rules](https://www.cs.umd.edu/~ben/goldenrules.html); 15–21 adapt the [GOV.UK design principles](https://www.gov.uk/guidance/government-design-principles). Principles 22–23 draw on W3C guidance for [reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) and [redundant entry](https://www.w3.org/WAI/WCAG22/Understanding/redundant-entry.html). These are project applications, not verbatim standards or a claim of accessibility conformance. Principles 24–39 capture the user's accepted product requirements and additions.

Vercel's [Web Interface Guidelines](https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines) are a preferred supplemental review reference for concrete interface behavior. Apply them subject to these accepted principles: truncation, line clamping, and overflow hiding are not adequate without access to full content; blanket advice to keep submit enabled does not override the date-interpretation contract. Styling conventions and numeric thresholds remain contextual guidance. This reference does not adopt all upstream rules or install the upstream skill.

This file is the maintained project source. The installed product-design-principles skill carries a portable copy in references/principles.md; update that copy when changing these principles.
