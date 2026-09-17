// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { HostSectionRow } from '../../host-section-rows'
import { useSidebarWorktreeSelection } from './use-selection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Selection = ReturnType<typeof useSidebarWorktreeSelection>

function worktree(id: string): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: selection reads only id and hostId off a worktree; a literal Worktree would pin ~50 unrelated fields.
  return { id, repoId: 'repo', hostId: 'local' } as unknown as Worktree
}

function row(item: Worktree): HostSectionRow {
  return {
    type: 'item',
    rowKey: `row:${item.id}`,
    sectionKey: 'all',
    worktree: item,
    repo: undefined,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

function unqualifiedWorktree(id: string): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same narrow shape as worktree(), without the hostId a local row never carries.
  return { id, repoId: 'repo' } as unknown as Worktree
}

const first = worktree('a')
const second = worktree('b')
const rows = [row(first), row(second)]

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: getWorktreeSelectionIntent reads only these three modifier flags off the event.
const additiveEvent = {
  metaKey: navigator.userAgent.includes('Mac'),
  ctrlKey: !navigator.userAgent.includes('Mac'),
  shiftKey: false
} as React.MouseEvent<HTMLElement>

let container: HTMLDivElement
let root: Root
let selection: Selection

// Declared once so a re-render updates the tree: a component type created per call would
// remount it, and the hook state under test would reset every time.
function Probe(props: { activeWorktreeId: string | null; hostId: ExecutionHostId | null }): null {
  selection = useSidebarWorktreeSelection({
    sectionRows: rows,
    pinnedDisplayPolicy: 'single-location',
    activeWorktreeId: props.activeWorktreeId,
    activeWorkspaceExecutionHostId: props.hostId
  })
  return null
}

function UnqualifiedProbe(props: {
  rows: HostSectionRow[]
  activeWorktreeId: string | null
  hostId: ExecutionHostId | null
}): null {
  selection = useSidebarWorktreeSelection({
    sectionRows: props.rows,
    pinnedDisplayPolicy: 'single-location',
    activeWorktreeId: props.activeWorktreeId,
    activeWorkspaceExecutionHostId: props.hostId
  })
  return null
}

function renderUnqualifiedProbe(
  unqualifiedRows: HostSectionRow[],
  activeWorktreeId: string | null,
  hostId: ExecutionHostId | null
): void {
  act(() =>
    root.render(
      <UnqualifiedProbe
        rows={unqualifiedRows}
        activeWorktreeId={activeWorktreeId}
        hostId={hostId}
      />
    )
  )
}

function renderProbe(activeWorktreeId: string | null, hostId: ExecutionHostId | null): void {
  act(() => root.render(<Probe activeWorktreeId={activeWorktreeId} hostId={hostId} />))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('sidebar selection follows a non-gesture activation', () => {
  it('leaves the selection empty on the first activation it observes', () => {
    // Startup activates a workspace nobody picked; inventing a selection there would arm
    // Cmd+click from a card the user never touched.
    renderProbe('a', 'local')

    expect(selection.selectedWorktreeIds.size).toBe(0)
  })

  it('republishes the selection when the active workspace moves', () => {
    // The reported bug: keyboard cycling activated the next card while the ring stayed on
    // whichever card the mouse last clicked.
    renderProbe('a', 'local')
    act(() => selection.updateSelectionForGesture(additiveEvent, first))
    expect(selection.selectedWorktreeIds).toEqual(new Set(['local|a']))

    renderProbe('b', 'local')

    expect(selection.selectedWorktreeIds).toEqual(new Set(['local|b']))
    expect(selection.selectedWorktrees.map((item) => item.id)).toEqual(['b'])
  })

  it('keeps a multi-selection that a modifier gesture built without activating', () => {
    renderProbe('a', 'local')
    act(() => selection.updateSelectionForGesture(additiveEvent, first))
    act(() => selection.updateSelectionForGesture(additiveEvent, second))
    expect(selection.selectedWorktreeIds.size).toBe(2)

    // A modifier gesture selects without switching away, so the active workspace is unchanged.
    renderProbe('a', 'local')

    expect(selection.selectedWorktreeIds).toEqual(new Set(['local|a', 'local|b']))
  })

  it('publishes an identity the rendered rows actually carry', () => {
    // Local rows carry no hostId (withRepoHostOwnership leaves them unqualified) while the
    // store still resolves the active host to 'local'. Composing the two would publish an
    // identity no row has, and the render-phase prune would drop the selection entirely.
    const unqualified = unqualifiedWorktree('c')
    const unqualifiedRows = [row(unqualified), row(unqualifiedWorktree('d'))]

    renderUnqualifiedProbe(unqualifiedRows, 'c', 'local')
    act(() => selection.updateSelectionForGesture(additiveEvent, unqualified))
    expect(selection.selectedWorktreeIds).toEqual(new Set(['|c']))

    renderUnqualifiedProbe(unqualifiedRows, 'd', 'local')

    expect(selection.selectedWorktreeIds).toEqual(new Set(['|d']))
  })

  it('keeps the resolved host when rows disambiguate one id across hosts', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: selection reads only id and hostId.
    const onLocal = { id: 'shared', repoId: 'repo', hostId: 'local' } as unknown as Worktree
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: selection reads only id and hostId.
    const onRemote = { id: 'shared', repoId: 'repo', hostId: 'ssh:host-b' } as unknown as Worktree
    const sharedRows = [
      { ...row(onLocal), rowKey: 'row:local' },
      { ...row(onRemote), rowKey: 'row:remote' }
    ]

    // One workspace id present on two hosts: activating the remote one must not land on the
    // local row, so the resolved host has to survive when a row actually carries it.
    renderUnqualifiedProbe(sharedRows, 'shared', 'local')
    renderUnqualifiedProbe(sharedRows, 'shared', 'ssh:host-b')

    expect(selection.selectedWorktreeIds).toEqual(new Set(['ssh:host-b|shared']))
  })

  it('resolves a host-unqualified activation through the rendered rows', () => {
    renderProbe('a', null)
    act(() => selection.updateSelectionForGesture(additiveEvent, first))

    renderProbe('b', null)

    expect(selection.selectedWorktreeIds).toEqual(new Set(['local|b']))
  })
})
