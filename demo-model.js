// Pure state model for the PetClinic decision demo. No DOM: the page script renders
// what this returns, and the tests exercise it directly.
//
// Only one gap is left to the visitor: gap.city_matching_semantics in
// examples/petclinic/gaps.json, with its three candidate options. The other two gaps
// keep the values from implementation_package.json (the curated human decisions).

export const CHOICES = ["prefix", "exact", "contains"];

export function initialState() {
  return { choice: null, approved: false };
}

// A decision can be changed until the proposal is approved; after that it is fixed
// and only a reset starts over.
export function choose(state, choice) {
  if (state.approved || !CHOICES.includes(choice)) return state;
  return { choice, approved: false };
}

export function approve(state) {
  if (!state.choice || state.approved) return state;
  return { ...state, approved: true };
}

export function reset() {
  return initialState();
}

// 0 investigation · 1 human decision · 2 proposal · 3 approved.
// Returns the index of the phase the visitor is in now.
export function currentPhase(state) {
  if (state.approved) return 3;
  if (state.choice) return 2;
  return 1;
}

export function proposalStatus(state) {
  if (state.approved) return "approved";
  if (state.choice) return "ready";
  return "blocked";
}

const fill = (template, match) => template.replaceAll("{match}", match);

// Builds the implementation proposal for the current state from the locale's copy.
// `changed` marks lines whose content comes from the visitor's decision.
export function buildProposal(copy, state) {
  const status = proposalStatus(state);
  const decided = Boolean(state.choice);
  const match = decided ? copy.matchWords[state.choice] : `［${copy.unresolvedValue}］`;
  const cityTest = decided ? copy.cityTest[state.choice] : copy.cityTest.pending;

  return {
    status,
    statusText: {
      blocked: copy.statusBlocked,
      ready: copy.statusReady,
      approved: copy.statusApproved,
    }[status],
    canApprove: status === "ready",
    sections: [
      { key: "target", title: copy.sections.target, items: [{ text: fill(copy.target, match), changed: decided, unresolved: !decided }] },
      {
        key: "decisions",
        title: copy.sections.decisions,
        items: [
          { text: fill(copy.decisionLines.matching, match), changed: decided, unresolved: !decided },
          { text: copy.decisionLines.combination },
          { text: copy.decisionLines.noResult },
        ],
      },
      { key: "preserved", title: copy.sections.preserved, items: copy.preserved.map((text) => ({ text })) },
      {
        key: "boundary",
        title: copy.sections.boundary,
        items: copy.boundary.map((text) => ({
          text: fill(text, match),
          changed: decided && text.includes("{match}"),
          unresolved: !decided && text.includes("{match}"),
        })),
      },
      {
        key: "tests",
        title: copy.sections.tests,
        items: [{ text: cityTest, changed: decided, unresolved: !decided }, ...copy.tests.map((text) => ({ text }))],
      },
      {
        key: "open",
        title: copy.sections.open,
        items: [
          ...(decided ? [] : [{ text: fill(copy.decisionLines.matching, match), unresolved: true }]),
          { text: copy.open },
        ],
      },
    ],
  };
}

const strip = (text) => String(text).replace(/`/g, "");

// The frozen, machine-facing handoff. Only exists once a human approved the proposal.
export function buildPackage(copy, state) {
  if (!state.approved) return null;
  const match = copy.matchWords[state.choice];
  return {
    status: "approved_implementation_direction",
    requirement_id: "owner-city-search",
    reference_revision: "88e37c15cf6fc8490b01bc3e8e2c800cec1ac272",
    approved_target: fill(copy.target, match),
    human_decisions: {
      "gap.city_matching_semantics": state.choice,
      "gap.search_criteria_combination": "AND; city-only allowed; both blank returns all owners",
      "gap.no_result_error_placement": "form-level notFound",
    },
    preserved_behavior: copy.preserved.map(strip),
    change_boundary: copy.boundary.map((text) => strip(fill(text, match))),
    test_intents: [copy.cityTest[state.choice], ...copy.tests].map(strip),
    unresolved_questions: [strip(copy.open)],
  };
}
