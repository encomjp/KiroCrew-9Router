/**
 * A declined click has to be VISIBLE, and it has to stay inside the header's
 * action-group contract.
 *
 * The guard lives in `openSession` and the surface lives in `AgentSessionButton`,
 * wired through `useInvestigate` -> `InvestigateButton` props. A pod run proved
 * the guard fires (zero slot-create requests) while nothing changed on screen,
 * which is a wiring failure the hook-level test cannot see: it asserts on the
 * returned state, not on what the button does with it.
 *
 * The shape is deliberately label-and-tooltip rather than an added element.
 * `DetailHeader` wraps these in a `flex-shrink-0` group documented as holding
 * "buttons only", so a text node cannot shrink and pushes the row past a 320px
 * pane, and a second button would breach `max-two-buttons-per-row`. The row
 * already reports the state twice over: the pill carries the recorded verdict,
 * and the label says what a further click would do.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const { investigate, api, session } = vi.hoisted(() => ({
  investigate: vi.fn(),
  api: { getInvestigation: vi.fn() },
  session: { concludedFor: null as string | null },
}))

vi.mock('../apps/issue-radar/api', () => ({ issueRadarApi: api }))
vi.mock('../apps/issue-radar/lib/investigate', () => ({
  useInvestigate: () => ({
    investigate,
    busy: false,
    error: null,
    concludedFor: session.concludedFor,
  }),
}))

const InvestigateButton = (await import('../apps/issue-radar/components/InvestigateButton')).default
const { itemKey } = await import('../apps/issue-radar/lib/agentSession')

const REF = { owner: 'acme', repo: 'demo', provider: 'github', host: 'github.com' } as never
const ISSUE = { number: 6014, title: 'concluded issue', labels: [] } as never

const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('InvestigateButton reports a declined click', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    session.concludedFor = null
    api.getInvestigation.mockResolvedValue({
      investigation: {
        slot_key: 'chat-closed', status: 'resolved', findings: { verdict: 'bug' },
      },
    })
  })

  it('offers Resume until a click is declined', async () => {
    wrap(<InvestigateButton repoRef={REF} issue={ISSUE} />)
    const btn = await waitFor(() => screen.getByRole('button', { name: /Resume/i }))
    expect(screen.queryByRole('button', { name: /Start over/i })).toBeNull()
    expect(btn.getAttribute('title')).not.toMatch(/Already finished/i)
  })

  it('becomes Start over, and says why in its title, once declined', async () => {
    session.concludedFor = itemKey(REF, 6014)
    wrap(<InvestigateButton repoRef={REF} issue={ISSUE} />)
    const btn = await waitFor(() => screen.getByRole('button', { name: /Start over/i }))
    // Resume is REPLACED, not joined -- the re-run takes over this control.
    expect(screen.queryByRole('button', { name: /Resume/i })).toBeNull()
    // The reason is reachable rather than dropped.
    expect(btn.getAttribute('title')).toMatch(/Already finished/i)
  })

  /**
   * The action group is `flex-shrink-0` and documented as buttons-only, so a
   * declined click must not add anything that OCCUPIES the row -- not a second
   * button (which breaches `max-two-buttons-per-row`, the row already carrying
   * the overflow trigger) and not a sentence (which cannot shrink at 320px).
   * Both shapes were shipped and blocked in review, so this is pinned.
   *
   * The screen-reader announcement is exempt BY MEASUREMENT, not by exception:
   * `sr-only` is absolutely positioned and clipped, so it contributes no width.
   * The assertion is therefore "nothing VISIBLE is added", which is the invariant
   * the layout rule actually states.
   */
  it('adds nothing that occupies the action row, declined or not', async () => {
    for (const declined of [false, true]) {
      session.concludedFor = declined ? itemKey(REF, 6014) : null
      const { unmount } = wrap(<InvestigateButton repoRef={REF} issue={ISSUE} />)
      await waitFor(() => expect(screen.getAllByRole('button').length).toBeGreaterThan(0))
      expect(screen.getAllByRole('button')).toHaveLength(1)
      // Any element carrying the sentence must be the clipped, zero-width one.
      for (const el of screen.queryAllByText(/Already finished/i)) {
        expect(el.className).toMatch(/sr-only/)
      }
      unmount()
    }
  })

  /**
   * The flip is not text-only.
   *
   * The second click lands on the same pixel as the first, so a user who reads a
   * quiet relabel as "nothing happened" would click again and spend a fresh agent
   * run. The icon changes with the label to make the state change perceptible
   * without adding an element the action group's contract forbids.
   */
  it('changes the icon along with the label', async () => {
    const iconOf = async () => {
      const btn = await waitFor(() => screen.getAllByRole('button')[0])
      return btn.querySelector('svg')?.getAttribute('class') || ''
    }
    const { unmount } = wrap(<InvestigateButton repoRef={REF} issue={ISSUE} />)
    const resting = await iconOf()
    unmount()

    session.concludedFor = itemKey(REF, 6014)
    wrap(<InvestigateButton repoRef={REF} issue={ISSUE} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Start over/i })).toBeTruthy())
    expect(await iconOf()).not.toBe(resting)
  })

  /**
   * The re-run is a deliberate second click, and nothing pretends otherwise.
   *
   * An earlier revision held the flipped button inert for 700ms to absorb a
   * reflexive retry. Three review lanes rejected it and they were right: the
   * habitual double-click is already absorbed by `busy`, which spans the probe
   * and the record re-read, so the beat only ever covered a derived hazard with
   * an unmeasured constant -- and supporting it cost `aria-disabled`, a manual
   * click guard and a hand-rolled dim, one of which had already caused a focus
   * bug. What protects the second click is that it is a real click on a control
   * whose label and icon have both changed.
   *
   * The residual is unchanged and is recorded as a known limitation: a user who
   * does not READ the flip can still retry into a paid re-run. The beat never
   * fixed that -- a visible reason does, and that is #6270.
   */
  it('re-runs on the second click, with nothing inert in between', async () => {
    session.concludedFor = itemKey(REF, 6014)
    wrap(<InvestigateButton repoRef={REF} issue={ISSUE} />)
    // Wait out the record lookup: `busy` legitimately disables the control while
    // the query is in flight, and that is a different mechanism from the timing
    // state this asserts is gone.
    const btn = await waitFor(() => {
      const b = screen.getByRole('button', { name: /Start over/i })
      expect(b).not.toBeDisabled()
      return b
    })
    expect(btn.getAttribute('aria-disabled')).toBeNull()

    btn.focus()
    await act(async () => { btn.click() })
    expect(investigate).toHaveBeenCalled()
    // The click did not cost the user their focus.
    expect(document.activeElement).toBe(btn)
  })

  /**
   * The reason reaches a keyboard or screen-reader user too.
   *
   * It otherwise lives only in the button's `title`, which someone activating the
   * control by keyboard never receives -- they get a label that quietly changed
   * and no account of why nothing resumed. `sr-only` keeps this out of the action
   * row's width, which is what the group's contract actually restricts.
   */
  it('announces the reason, and names where the transcript went', async () => {
    session.concludedFor = itemKey(REF, 6014)
    wrap(<InvestigateButton repoRef={REF} issue={ISSUE} />)
    const live = await waitFor(() => screen.getByRole('status'))
    expect(live.className).toMatch(/sr-only/)
    expect(live.textContent).toMatch(/Already finished/i)
    // Clicking resume on finished work usually means "show me the result", so the
    // copy has to say the transcript survived rather than only that it is gone.
    expect(live.textContent).toMatch(/Older Sessions/i)
  })
})
