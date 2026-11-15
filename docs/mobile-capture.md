# Mobile capture and note links

Nephrite registers the `nephrite://` URL scheme on Android and iOS. These links open the existing vault workflows; they never write a note without showing the capture form and requiring **Save capture**.

## Routes

- `nephrite://daily` opens today's Daily Note.
- `nephrite://open?path=Projects%2FPlan.md` opens an existing vault-relative note.
- `nephrite://capture?location=Inbox&title=Capture%20%7Bdate%7D&text=Hello` opens Quick Capture with its fields prefilled.

`location` is a vault-relative folder. Quick Capture titles accept `{date}` and `{time}`. Unsafe path components and `..` are removed before the proposed destination is displayed.

## iPhone and iPad Shortcuts

Create a Shortcut that accepts text from the Share Sheet, URL-encodes the Shortcut Input, constructs a `nephrite://capture` URL, and uses **Open URLs**. Enabling that Shortcut in the Share Sheet provides capture from other apps. The same Shortcut can be placed on the Home Screen, Lock Screen, or in a Shortcuts widget. Create separate Shortcuts with different `location` parameters to route captures to different vault folders.

The deep link opens Nephrite's review form. If the vault is still loading, the request remains queued. If no vault has been selected, Nephrite asks for one before showing the preserved capture.

## Android widget

The bundled Nephrite widget exposes **Open today's note** and **Quick capture**. Camera capture inside a note uses Android's camera picker and then saves the returned image through Nephrite's normal attachment-folder workflow.
