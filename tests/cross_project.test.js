import test from "node:test";
import assert from "node:assert/strict";

import { artifactsFor, ROUTE_SOURCES, runRetrieval } from "../functions/_lib/retrieval.js";
import { REQUIREMENTS, SHARED_ARTIFACTS } from "../functions/_lib/artifacts.generated.js";

// The public demo now serves two different projects. Requirement isolation was
// already tested within one project; what these tests add is the cross-project
// case, where a leak would put another codebase's vocabulary into an answer.

const PETCLINIC = ["owner-city-search", "same-day-visit"];
const OUTLINE = ["outline-restore-nested-documents"];

const PROJECTS = {
  "spring-petclinic": {
    requirementIds: PETCLINIC,
    // Terms that may only ever appear in a Spring PetClinic answer.
    vocabulary: [
      /Owner/,
      /Visit/,
      /OwnerRepository/,
      /Spring/i,
      /Thymeleaf/i,
      /市区町村/,
      /診療予約/,
    ],
  },
  outline: {
    requirementIds: OUTLINE,
    // Terms that may only ever appear in an Outline answer.
    vocabulary: [
      /Document/,
      /Collection/,
      /Trash/i,
      /restoreArchivedWithChildren/,
      /findAllChildDocumentIds/,
      /ゴミ箱/,
      /子文書/,
    ],
  },
};

function projectOf(requirementId) {
  for (const [name, project] of Object.entries(PROJECTS)) {
    if (project.requirementIds.includes(requirementId)) return name;
  }
  throw new Error(`test registry is stale: ${requirementId} belongs to no project`);
}

function foreignVocabulary(requirementId) {
  const own = projectOf(requirementId);
  return Object.entries(PROJECTS)
    .filter(([name]) => name !== own)
    .flatMap(([, project]) => project.vocabulary);
}

function requirementArtifacts(requirementId) {
  return REQUIREMENTS[requirementId].artifacts;
}

function scriptedClient(results) {
  let index = 0;
  return {
    get calls() {
      return index;
    },
    async complete() {
      return { result: results[index++], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, latencyMs: 1 };
    },
  };
}

test("the test registry covers every registered requirement", () => {
  // Guard the guard: a new requirement must be classified here, otherwise the
  // contamination assertions below would silently skip it.
  assert.deepEqual(
    Object.keys(REQUIREMENTS).sort(),
    [...PETCLINIC, ...OUTLINE].sort(),
  );
});

test("a requirement can retrieve nothing but its own artifacts and the shared design", () => {
  for (const requirementId of Object.keys(REQUIREMENTS)) {
    const retrievable = artifactsFor(requirementId);
    assert.deepEqual(
      Object.keys(retrievable).sort(),
      [...Object.keys(requirementArtifacts(requirementId)), ...Object.keys(SHARED_ARTIFACTS)].sort(),
    );
    for (const [name, artifact] of Object.entries(retrievable)) {
      if (name in SHARED_ARTIFACTS) continue;
      assert.equal(artifact.requirement_id, requirementId, `${name} must belong to ${requirementId}`);
    }
    // Every route's primary source resolves inside that same set.
    for (const source of Object.values(ROUTE_SOURCES)) {
      assert.ok(source in retrievable, `${requirementId} must be able to serve ${source}`);
    }
  }
});

test("no requirement artifact carries another project's vocabulary", () => {
  for (const requirementId of Object.keys(REQUIREMENTS)) {
    const serialized = JSON.stringify(requirementArtifacts(requirementId));
    for (const term of foreignVocabulary(requirementId)) {
      assert.doesNotMatch(serialized, term, `${requirementId} artifacts must not mention ${term}`);
    }
  }
});

test("surface and gap identifiers are never shared between projects", () => {
  const owners = new Map();
  for (const requirementId of Object.keys(REQUIREMENTS)) {
    const artifacts = requirementArtifacts(requirementId);
    const ids = [
      ...artifacts["project_context.json"].relevant_implementation_surfaces.map((surface) => surface.id),
      ...artifacts["gaps.json"].gaps.map((gap) => gap.id),
    ];
    for (const id of ids) {
      const previous = owners.get(id);
      assert.equal(previous, undefined, `${id} is claimed by both ${previous} and ${requirementId}`);
      owners.set(id, requirementId);
    }
  }
});

// What the model is shown is the real isolation boundary: it can only ground an
// answer in text it received, so the retrieved blocks themselves must be clean.
test("the retrieved evidence of one project never contains another project's text", () => {
  for (const requirementId of Object.keys(REQUIREMENTS)) {
    const retrievable = artifactsFor(requirementId);
    for (const [route, source] of Object.entries(ROUTE_SOURCES)) {
      // architecture.md is Forge's own design and is deliberately requirement
      // independent; it is the one shared source and is excluded by name.
      if (source in SHARED_ARTIFACTS) continue;
      const text = JSON.stringify(retrievable[source]);
      for (const term of foreignVocabulary(requirementId)) {
        assert.doesNotMatch(text, term, `${requirementId}/${route} would show ${term} to the model`);
      }
    }
  }
});

const OUTLINE_ID = "outline-restore-nested-documents";

test("an Outline impact answer drops surfaces belonging to the other project", async () => {
  const client = scriptedClient([
    { route: "impact_scope", primary_source: "project_context.json", reason: "impact" },
    {
      sufficiency: "sufficient",
      answer: "OwnerRepository と Thymeleaf にも影響します。",
      impact_items: [
        { surface_id: "surface.model.document_restore_to", reason: "restore" },
        { surface_id: "surface.api.search_endpoint", reason: "owner-city-search only" },
        { surface_id: "surface.controller.visit_date_rule", reason: "same-day-visit only" },
      ],
      evidence: ["project_context.json#surface.model.document_restore_to"],
      additional_source: null,
      additional_reason: null,
    },
  ]);
  const result = await runRetrieval("この要件はどこに影響しますか？", client, OUTLINE_ID);

  assert.deepEqual(result.impactItems.map((item) => item.surface_id), ["surface.model.document_restore_to"]);
  assert.match(result.validationWarnings.join(" "), /surface\.api\.search_endpoint/);
  assert.match(result.validationWarnings.join(" "), /surface\.controller\.visit_date_rule/);
  // The model prose that named the other project is replaced, not merely flagged.
  for (const term of foreignVocabulary(OUTLINE_ID)) {
    assert.doesNotMatch(result.answer, term);
    assert.doesNotMatch(JSON.stringify(result.evidence), term);
  }
});

test("a PetClinic impact answer drops Outline surfaces", async () => {
  const client = scriptedClient([
    { route: "impact_scope", primary_source: "project_context.json", reason: "impact" },
    {
      sufficiency: "sufficient",
      answer: "Document と Collection の Trash 処理も変更が必要です。",
      impact_items: [
        { surface_id: "surface.api.search_endpoint", reason: "controller" },
        { surface_id: "surface.model.document_restore_to", reason: "outline only" },
        { surface_id: "surface.model.document_delete_cascade", reason: "outline only" },
      ],
      evidence: ["project_context.json#surface.api.search_endpoint"],
      additional_source: null,
      additional_reason: null,
    },
  ]);
  const result = await runRetrieval("この要件はどこに影響しますか？", client, "owner-city-search");

  assert.deepEqual(result.impactItems.map((item) => item.surface_id), ["surface.api.search_endpoint"]);
  assert.match(result.validationWarnings.join(" "), /surface\.model\.document_restore_to/);
  for (const term of foreignVocabulary("owner-city-search")) {
    assert.doesNotMatch(result.answer, term);
  }
});

test("Outline blocking Human decisions are exactly its own two and stay project-clean", async () => {
  const client = scriptedClient([
    { route: "human_decision", primary_source: "gaps.json", reason: "open decisions" },
    {
      sufficiency: "sufficient",
      answer: "PetClinic の city 照合と同じ判断が必要です。",
      impact_items: [],
      evidence: ["gaps.json#gap.restore_scope"],
      additional_source: null,
      additional_reason: null,
    },
  ]);
  const result = await runRetrieval("実装前に人が決める必要があることは何ですか？", client, OUTLINE_ID);

  assert.deepEqual(
    result.humanAuthority.map((item) => item.gap_id),
    ["gap.restore_scope", "gap.cascade_restore_authorization"],
  );
  assert.ok(result.humanAuthority.every((item) => item.status === "open"));
  for (const term of foreignVocabulary(OUTLINE_ID)) {
    assert.doesNotMatch(result.answer, term);
    assert.doesNotMatch(JSON.stringify(result.humanAuthority), term);
  }
});

test("Outline never promotes an implementation detail to a Human decision", async () => {
  const gaps = requirementArtifacts(OUTLINE_ID)["gaps.json"];
  assert.equal(gaps.gaps.length, 2, "the showcase keeps exactly two blocking decisions");
  assert.ok(gaps.non_blocking_verifications.length > 0);
  assert.ok(gaps.derived_implementation_impact.length > 0);

  const client = scriptedClient([
    { route: "human_decision", primary_source: "gaps.json", reason: "open decisions" },
    {
      sufficiency: "sufficient",
      answer: "未解決の判断があります。",
      impact_items: [],
      evidence: ["gaps.json#gap.restore_scope"],
      additional_source: null,
      additional_reason: null,
    },
  ]);
  const result = await runRetrieval("実装前に人が決める必要があることは何ですか？", client, OUTLINE_ID);

  const reported = result.humanAuthority.map((item) => item.gap_id);
  const notDecisions = [
    ...gaps.non_blocking_verifications.map((item) => item.id),
    ...gaps.derived_implementation_impact.map((item) => item.id),
  ];
  assert.equal(reported.length, 2);
  for (const id of notDecisions) {
    assert.ok(!reported.includes(id), `${id} must never be reported as a Human decision`);
  }
});

// The browser bundle is a classic script, so the pure part under test is marked in
// script.js and evaluated here in isolation rather than by loading the whole file.
async function loadEvidenceLocation() {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../script.js", import.meta.url), "utf8");
  const block = source.match(/\/\/ --- evidence location \(pure\)[\s\S]*?\n\/\/ --- end evidence location/);
  assert.ok(block, "script.js must keep the marked pure evidence-location block");
  return new Function(`${block[0]}\nreturn evidenceLocation;`)();
}

test("an Evidence card location is rendered without hardcoding any language's extension", async () => {
  const evidenceLocation = await loadEvidenceLocation();

  // Whatever the extension, it is dropped once a symbol is present.
  assert.equal(
    evidenceLocation({ path: "src/main/java/org/example/OwnerController.java", symbol: "processFindForm" }),
    "OwnerController.processFindForm",
  );
  assert.equal(
    evidenceLocation({ path: "server/models/Document.ts", symbol: "restoreTo" }),
    "Document.restoreTo",
  );
  assert.equal(
    evidenceLocation({ path: "app/actions/definitions/documents.tsx", symbol: "restoreDocument" }),
    "documents.restoreDocument",
  );
  // A symbol already carrying the file name is not repeated.
  assert.equal(
    evidenceLocation({ path: "server/routes/api/documents/documents.ts", symbol: "documents.restore" }),
    "documents.restore",
  );
  assert.equal(
    evidenceLocation({ path: "server/queues/tasks/CleanupDeletedDocumentsTask.ts", symbol: "CleanupDeletedDocumentsTask" }),
    "CleanupDeletedDocumentsTask",
  );
  // Without a symbol the filename stands, extension included.
  assert.equal(evidenceLocation({ path: "src/main/resources/db/h2/schema.sql" }), "schema.sql");
  assert.equal(evidenceLocation({ path: "server/routes/api/documents/documents.test.ts" }), "documents.test.ts");
  assert.equal(evidenceLocation({}), "");
});

test("every published surface renders a location for both reference projects", async () => {
  const evidenceLocation = await loadEvidenceLocation();
  for (const requirementId of Object.keys(REQUIREMENTS)) {
    for (const surface of requirementArtifacts(requirementId)["project_context.json"].relevant_implementation_surfaces) {
      const location = evidenceLocation(surface.evidence);
      assert.ok(location, `${requirementId}/${surface.id} must render a location`);
      // A leftover extension in front of a symbol is the Java-only bug this replaced.
      assert.doesNotMatch(location, /\.(java|ts|tsx|html|sql|properties)\./, `${surface.id} renders ${location}`);
    }
  }
});

test("the showcase alignment of the Outline package is never presented as observed behavior", () => {
  const artifacts = requirementArtifacts(OUTLINE_ID);
  // The decided target changes the reference project's behavior, so the package
  // must mark it as a showcase decision rather than as something read from the repo.
  for (const decision of artifacts["implementation_package.json"].human_decisions) {
    assert.equal(decision.decided_by, "showcase_human_decision");
  }
  // The observed behavior stays the asymmetry actually present at the pinned revision.
  const context = artifacts["project_context.json"];
  assert.equal(context.reference_revision, "fb4ad4d0462e89f5764ed36a560adcd10b42e6f5");
  assert.match(context.observed_current_behavior.summary, /対象文書そのものだけを復元/);
  for (const surface of context.relevant_implementation_surfaces) {
    assert.ok(surface.evidence.source.includes(context.reference_revision), `${surface.id} must cite the pinned revision`);
  }
});
