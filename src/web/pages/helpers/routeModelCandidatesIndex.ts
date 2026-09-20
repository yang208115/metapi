export type IndexedRouteModelCandidate = {
  modelName: string;
  accountId: number;
  username: string | null;
  siteId: number;
  siteName: string;
};

export type RouteModelCandidatesByModelName = Record<string, IndexedRouteModelCandidate[]>;

export type RouteAccountOption = {
  id: number;
  label: string;
};

export type RouteCandidateView = {
  routeCandidates: IndexedRouteModelCandidate[];
  accountOptions: RouteAccountOption[];
};

export type RouteModelPatternLike = {
  id: number;
  modelPattern: string;
  routeMode?: string | null;
};

const EMPTY_ROUTE_CANDIDATE_VIEW: RouteCandidateView = {
  routeCandidates: [],
  accountOptions: [],
};

export function buildRouteModelCandidatesIndex(
  routes: RouteModelPatternLike[],
  modelCandidates: RouteModelCandidatesByModelName,
  matchesModelPattern: (model: string, pattern: string) => boolean,
): Record<number, RouteCandidateView> {
  const index: Record<number, RouteCandidateView> = {};

  for (const route of routes || []) {
    if (route.routeMode === 'explicit_group') {
      index[route.id] = EMPTY_ROUTE_CANDIDATE_VIEW;
      continue;
    }
    const modelPattern = (route.modelPattern || '').trim();
    if (!modelPattern) {
      index[route.id] = EMPTY_ROUTE_CANDIDATE_VIEW;
      continue;
    }

    const deduped = new Map<string, IndexedRouteModelCandidate>();
    for (const [modelName, candidates] of Object.entries(modelCandidates || {})) {
      if (!matchesModelPattern(modelName, modelPattern)) continue;
      for (const candidate of candidates || []) {
        const key = `${candidate.accountId}::${modelName}`;
        if (!deduped.has(key)) {
          deduped.set(key, {
            ...candidate,
            modelName,
          });
        }
      }
    }

    const routeCandidates = Array.from(deduped.values()).sort((a, b) => {
      if (a.accountId === b.accountId) return a.modelName.localeCompare(b.modelName);
      return a.accountId - b.accountId;
    });

    const accountMap = new Map<number, string>();
    for (const candidate of routeCandidates) {
      if (!accountMap.has(candidate.accountId)) {
        accountMap.set(candidate.accountId, `${candidate.username || `account-${candidate.accountId}`} @ ${candidate.siteName}`);
      }
    }

    const accountOptions = Array.from(accountMap.entries()).map(([id, label]) => ({ id, label }));
    index[route.id] = {
      routeCandidates,
      accountOptions,
    };
  }

  return index;
}
