/**
 * Permission default-preset decode (wire contract of the official
 * ui-permission-presets `permissionDefaultOf`): the host's `permission`
 * settings namespace carries the dynamic preset enum INSIDE the schema
 * envelope (`defaultPreset` as a union of const choices, each option's
 * description used as its display label). Decoding is data-driven — the
 * schema arrives from the host on every describe, so no option list is
 * hardcoded here.
 */

import { nodeAtPath, rehydrateSchema } from '@deepseek-ai/dsh-client-schema-form'
import { PERMISSION_SETTINGS_NS } from './permission-row-controller.ts'

/** Machine value of the preset that requires an explicit GUI risk gate. */
export const FULL_ACCESS_PRESET = 'danger-full-access'

/** One selectable new-session default. */
export interface PermissionDefaultOption {
  /** Preset key written to Settings. */
  id: string
  /** Host-supplied label or a title-cased preset key. */
  label: string
}

/** One permission namespace descriptor from a settings.describe response. */
export interface PermissionNamespaceView {
  ns: string
  revision: number
  value: unknown
  schema: unknown
}

/**
 * Convert conventional kebab-case preset names into user-facing title case
 * (official display rule).
 * @param name - host-supplied preset label or key.
 * @returns the title-cased conventional key, or a non-kebab label unchanged.
 */
export function displayPresetName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name
  return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/**
 * Render a permission preset under its product label.
 * @param value - preset machine value.
 * @param name - host-supplied preset name.
 * @returns the Full access product label or the conventional display name.
 */
export function displayPermissionPreset(value: string, name: string): string {
  return value === FULL_ACCESS_PRESET ? 'Full access' : displayPresetName(name)
}

interface ConstChoice {
  type: string
  value?: unknown
  meta?: { description?: unknown }
}

/**
 * Read the dynamic preset enum encoded by the host's `defaultPreset` schema.
 * @param view - permission namespace descriptor.
 * @returns current value and selectable options.
 * @throws when the descriptor does not advertise the current preset.
 */
export function permissionDefaultOf(view: PermissionNamespaceView): {
  currentValue: string
  options: PermissionDefaultOption[]
} {
  const value = (view.value as { defaultPreset?: unknown } | null)?.defaultPreset
  if (typeof value !== 'string') throw new Error('permission settings has no defaultPreset value')
  const node = nodeAtPath(rehydrateSchema(view.schema), ['defaultPreset'])
  if (node === undefined) throw new Error('permission settings schema has no defaultPreset field')
  const rawChoices = node.type === 'union'
    ? (node.list as readonly unknown[] | undefined) ?? []
    : [node]
  const options = rawChoices.flatMap((candidate) => {
    const choice = candidate as ConstChoice
    if (choice.type !== 'const' || typeof choice.value !== 'string') return []
    const described = choice.meta?.description
    return [{
      id: choice.value,
      label: typeof described === 'string' && described.length > 0
        ? displayPermissionPreset(choice.value, described)
        : displayPermissionPreset(choice.value, choice.value),
    }]
  })
  if (options.length === 0 || !options.some(option => option.id === value)) {
    throw new Error('permission settings schema does not advertise its current preset')
  }
  return { currentValue: value, options }
}
