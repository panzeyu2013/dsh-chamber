/** Host loader entry for the browser-only open-in plugin. */

/** Provides no host-side behavior; the app launch (Finder / VS Code) runs in
 *  the desktop main process (design 16 + open-in extension — there is
 *  deliberately no host plugin / no seed: the action is a local launch, never
 *  an in-instance execution). */
export function apply(): void {}
