/**
 * shell-ipc-plugins-local — domain IPC registrations
 */
import type { ShellIpcCtx } from './shell-core.ts'
import { IPC_CHANNELS } from './ipc-events.ts'
import { classifyPluginPick, folderPluginIdentity } from './plugin-tarball.ts'
import { describeLocalPluginAddConfirmation, describeLocalPluginRemoveConfirmation, describePluginDecision, guardPluginMutation, localPluginList, redactLocalPluginManifest, runLocalDshPlugin } from './plugin-sync.ts'
import { describeUnknownError } from './deep-link.ts'
import { isAllowedRegistryUrl } from '@dsh-chamber/dsh-runtime'
import { parseSpecName, parseSpecVersion } from './ssh-apply-rows.ts'
import { sanitizeErrorText } from './sanitize-error.ts'

export function registerLocalPluginHandlers(ctx: ShellIpcCtx): void {
  const { deps, localProtectionFacts, verifyLocalProfileFamily, confirmPluginAction, NPM_SEARCH_MAX_BODY_BYTES } = ctx
  const { localDshHome, runLocalPluginMutation } = ctx.deps.ctx
  // Local manifest read (design 13 local leg): the authoritative local dsh
  // home manifest (<localDshHome>/… package.json 依赖投影 + bundle 激活层) —
  // localPluginList is a pure plugin-sync read of the same home the mutation
  // leaf writes; loud {error} on any unreadable/corrupt manifest, never a
  // silent empty success.
  // The IPC response is the redacted projection (design 13 §7.0): every
  // materialize-class dependency VALUE (file:/link:/relative/absolute/`~/` —
  // and the rows[].spec channel) becomes MATERIALIZED_VALUE_MASK before it
  // crosses to the renderer, so a local absolute path can never reach a
  // remote instance's bundle in the chamber page. The main-process-internal
  // manifest stays full (resolveLocalMaterializeDirectory, the mutation leaf
  // and the seed paths read the unredacted read).
  deps.ipc.handle(IPC_CHANNELS.LOCAL_PLUGIN_LIST, () => {
    try {
      return { ok: true, manifest: redactLocalPluginManifest(localPluginList(localDshHome, localProtectionFacts())) };
    } catch (error) {
      return { ok: false, error: describeUnknownError(error) };
    }
  });
  // npm search (design 13 contract B): BEST-EFFORT npm registry search —
  // a main-process fetch (the renderer stays on 127.0.0.1), bounded in time and
  // body size, refusing any non-whitelisted URL/redirect loudly. Always a loud
  // {ok:false} on refusal/transport/parse failure — never a silent empty
  // success, never an unhandled rejection.
  deps.ipc.handle(IPC_CHANNELS.NPM_SEARCH, async (payload: unknown) => {
    const { query } = payload as { query: unknown };
    if (typeof query !== 'string' || query.trim() === '') return { ok: false, error: 'empty search query' };
    const text = query.trim();
    if (text.length > 256) return { ok: false, error: 'search query is too long' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    timer.unref?.();
    try {
      const searchUrl = new URL(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=20`);
      // The search endpoint shares the registry URL whitelist
      // (origin + `/-/v1/search` path shape), never a raw hardcoded fetch.
      if (!isAllowedRegistryUrl(searchUrl.toString())) {
        return { ok: false, error: 'search URL is not whitelisted' };
      }
      // redirect: 'manual' — the same per-hop discipline as
      // fetchRegistryResponse: a redirected search answer is NOT accepted
      // from an arbitrary origin, so any 3xx is an explicit failure here.
      const response = await fetch(searchUrl, {
        signal: controller.signal,
        redirect: 'manual',
      });
      if (!response.ok) return { ok: false, error: `npm search failed (HTTP ${response.status})` };
      // Bounded read: an oversized or endless search response must never
      // accumulate in main-process memory.
      const reader = response.body?.getReader();
      let raw = '';
      if (reader !== undefined) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += Buffer.from(value).toString('utf8');
          if (raw.length > NPM_SEARCH_MAX_BODY_BYTES) {
            await reader.cancel().catch(() => undefined);
            return { ok: false, error: 'npm search response is too large' };
          }
        }
      }
      let data: { objects?: Array<{ package?: { name?: unknown; version?: unknown; description?: unknown } }> };
      try {
        data = JSON.parse(raw) as { objects?: Array<{ package?: { name?: unknown; version?: unknown; description?: unknown } }> };
      } catch {
        return { ok: false, error: 'npm search returned malformed JSON' };
      }
      const objects = Array.isArray(data.objects) ? data.objects : [];
      const packages = objects
        .map(entry => entry.package)
        .filter((pkg): pkg is { name: string; version: unknown; description: unknown } => pkg !== undefined && typeof pkg.name === 'string')
        .map(pkg => ({
          name: pkg.name,
          version: typeof pkg.version === 'string' ? pkg.version : '',
          ...(typeof pkg.description === 'string' ? { description: pkg.description } : {}),
        }));
      return { ok: true, packages };
    } catch (error) {
      return { ok: false, error: `npm search failed: ${describeUnknownError(error)}` };
    } finally {
      clearTimeout(timer);
    }
  });

  deps.ipc.handle(IPC_CHANNELS.LOCAL_PLUGIN_ADD_FILE, async () => {
    if (!deps.edges.mainWindowAlive()) return { ok: false, error: 'no main window' };
    // Local same-machine install (design 13 §5.8 pick-only, design 21
    // §10 archive-pick): the path was chosen through the
    // MAIN-process picker — a plugin SOURCE FOLDER or a ready .tgz plugin
    // archive — so the `file:` spec is main-chosen; pass allowFileSpec so
    // runLocalDshPlugin admits it through isAllowedLocalFileSpec (absolute
    // POSIX/Windows-drive/UNC path, no control characters, ≤ 4096 chars —
    // nothing beyond the existing whitelist is relaxed). Every
    // renderer-submitted spec channel (LOCAL_PLUGIN_ADD below) still
    // refuses `file:` outright; no filesystem privilege boundary widens.
    const picked = await deps.edges.pickPluginSource();
    if (picked.status === 'cancelled') return { ok: true, cancelled: true };
    // Structural pre-check (extension + archive cap + parseable manifest);
    // the local dsh CLI remains the authority for name/version semantics,
    // exactly as with folder picks.
    const classified = classifyPluginPick(picked.path);
    if (!classified.ok) return { ok: false, error: sanitizeErrorText(classified.error) };
    // Protected-set judgement over the PICKED manifest (design 21 §6.11):
    // a folder/archive pick is the one local path whose name is known only
    // from the picked package.json, so it is judged here before the picker
    // result can reach the CLI. `file:` specs carry no registry name, so
    // runLocalDshPlugin's own guard deliberately skips them.
    const pickedManifest = classified.source.kind === 'tgz'
      ? { ok: true as const, name: classified.source.name, version: classified.source.version as string | null }
      : folderPluginIdentity(classified.source.path);
    if (!pickedManifest.ok) return { ok: false, error: sanitizeErrorText(pickedManifest.error) };
    const localFacts = localProtectionFacts();
    const pickedGuard = guardPluginMutation({
      op: 'install',
      name: pickedManifest.name,
      version: pickedManifest.version,
      facts: localFacts,
    });
    if (pickedGuard.kind === 'refuse') {
      return { ok: false, error: describePluginDecision(pickedGuard) };
    }
    return runLocalPluginMutation('plugin:add-file', async (dshWorkspace) => {
      // design 21 §10: the main-process picker
      // IS the sanctioned file: source — pass the capability flag so
      // the picked absolute path passes runLocalDshPlugin's gate (without it
      // every file: pick is refused as an invalid add spec).
      // Facts are re-resolved INSIDE the mutation: the guard
      // above ran before the picker/fence lease, and a runtime switch in that
      // window would make the inner guard and the post-install verification
      // describe the PREVIOUS runtime.
      const freshFacts = localProtectionFacts();
      const result = await runLocalDshPlugin(dshWorkspace, localDshHome, 'add', `file:${picked.path}`, { allowFileSpec: true, protection: freshFacts });
      if (!result.ok) return { ok: false, error: result.error ?? 'local add failed' };
      const verified = verifyLocalProfileFamily(freshFacts);
      return verified.ok ? { ok: true } : { ok: false, error: verified.error };
    });
  });
  deps.ipc.handle(IPC_CHANNELS.LOCAL_PLUGIN_ADD, async (payload: unknown) => {
    const { spec: specArg } = payload as { spec: string };
    // `file:` imports must go through the main-process local import picker
    // (desktop_local_plugin_add_file — a folder or a .tgz archive, design 21
    // §10 ⑧); this spec channel only accepts registry specs so a compromised
    // renderer can never drive the local install surface to an arbitrary
    // path (design 13 §5.8 hardening).
    if (typeof specArg === 'string' && specArg.startsWith('file:')) {
      return { ok: false, error: 'local file imports must use the local import picker' };
    }
    // Protected-set judgement FIRST (design 21 §6.11): never ask the user to
    // confirm an install the write face would refuse (protected name, or an
    // official-scope install without the instance's exact generation).
    const addFacts = localProtectionFacts();
    const addGuard = guardPluginMutation({
      op: 'install',
      name: parseSpecName(specArg),
      version: parseSpecVersion(specArg),
      facts: addFacts,
    });
    if (addGuard.kind === 'refuse') return { ok: false, error: describePluginDecision(addGuard) };
    // User confirmation (design 09 §4 v1 mitigation): installing a registry
    // package into the LOCAL profile creates a persistent execution surface
    // on the next local boot — never a silent script action.
    const confirm = await confirmPluginAction(describeLocalPluginAddConfirmation(specArg));
    if ('cancelled' in confirm) return { ok: true, cancelled: true };
    if (!confirm.ok) return { ok: false, error: confirm.error };
    return runLocalPluginMutation('plugin:add', async (dshWorkspace) => {
      // Re-resolve the facts INSIDE the mutation: the guard above ran before
      // the confirmation dialog and before this fence/lease, and a runtime
      // switch in that window would make both the inner guard and the
      // post-install verification describe the PREVIOUS runtime. The pre-dialog
      // guard stays as the user-facing fast refusal.
      const freshFacts = localProtectionFacts();
      const result = await runLocalDshPlugin(dshWorkspace, localDshHome, 'add', specArg, { protection: freshFacts });
      if (!result.ok) return { ok: false, error: result.error ?? 'local add failed' };
      const verified = verifyLocalProfileFamily(freshFacts);
      return verified.ok ? { ok: true } : { ok: false, error: verified.error };
    });
  });
  deps.ipc.handle(IPC_CHANNELS.LOCAL_PLUGIN_REMOVE, async (payload: unknown) => {
    const { name } = payload as { name: unknown };
    if (typeof name !== 'string' || name === '') return { ok: false, error: 'invalid plugin name' };
    // Protected-set judgement first (design 21 §6.11): a composition member
    // or chamber seed can never be removed through the plugin model — the
    // refusal is honest and immediate, not a confirmed action that dies in
    // the CLI. `remove` never judges a version.
    const removeFacts = localProtectionFacts();
    const removeGuard = guardPluginMutation({ op: 'remove', name, version: null, facts: removeFacts });
    if (removeGuard.kind === 'refuse') return { ok: false, error: describePluginDecision(removeGuard) };
    // User confirmation (design 09 §4 v1 mitigation): removal is destructive
    // — a page script must not be able to wipe the local profile silently.
    const confirm = await confirmPluginAction(describeLocalPluginRemoveConfirmation(name));
    if ('cancelled' in confirm) return { ok: true, cancelled: true };
    if (!confirm.ok) return { ok: false, error: confirm.error };
    return runLocalPluginMutation('plugin:remove', async (dshWorkspace) => {
      const freshFacts = localProtectionFacts();
      const result = await runLocalDshPlugin(dshWorkspace, localDshHome, 'remove', name, { protection: freshFacts });
      return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'local remove failed' };
    });
  });
}
