/**
 * Dead catalog keys — a ratchet, not a deletion tool.
 *
 * A key nothing references costs a translator ten languages of work for a string
 * nobody sees. But automatically deleting one is dangerous: the reference may be
 * indirect (`surfaceLabel()` resolves a `labelKey` held in data), and i18next
 * returns the key string itself for a missing key rather than throwing, so a wrong
 * deletion shows up as `pages.settings.aboutPanel.update_error_offline` in the UI
 * instead of a crash. `AboutPanel.tsx` carries a comment about exactly that class of
 * failure taking the whole Settings panel down.
 *
 * So this asserts the count does not GROW. It never proposes a deletion, and it
 * never fails for a key that was dead already.
 *
 * ## What counts as a reference
 *
 * A quoted occurrence of the dotted key anywhere in `src`, or of its plural base
 * (`…_one` / `…_other` strip to the base, which is what `t()` is called with). Keys
 * listed in `pluralKeys.json` are always considered live: that registry IS the
 * reference.
 *
 * The scan is a floor, deliberately. It cannot see a key assembled at runtime — which
 * is why `dynamicKeys.test.ts` forbids assembling one in the first place, and why
 * that guard is a precondition for this one meaning anything.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { CATALOGS as RUNTIME_CATALOGS } from './catalogs'
import { DEFAULT_LANGUAGE } from './languages'
import pluralKeys from './pluralKeys.json'

/**
 * Dead keys at the time this gate went in. Ratchet DOWN when keys are removed; never
 * raise it. A rise means a new key was added and nothing uses it — usually a typo at
 * the call site, or copy that was deleted without its key.
 */
const BASELINE = 29
