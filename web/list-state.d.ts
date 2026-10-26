export function emptyStateMessage(input: {
  tab: string
  filtered: boolean
  spansCount: number
  eventsCount: number
  totalEvents?: number
}): string

export function listNeedsRebuild(datasetTotal: string | undefined, total: number, hasInner: boolean): boolean
