// Deterministic citation-locator resolution.
//
// A citation is `retrieved_filename#locator`. Membership of the filename in the
// retrieved set was already enforced; what this module adds is whether the
// locator actually exists inside that exact artifact instance. Two locator
// shapes are in use across the current artifacts, and only these two:
//
//   * an identifier recorded inside the artifact
//       project_context.json#surface.repository.owner_lookup
//       gaps.json#gap.city_matching_semantics
//   * a JSON path from the artifact root, optionally continuing from such an
//     identifier
//       project_context.json#observed_current_behavior.summary
//       project_context.json#relevant_implementation_surfaces[2].evidence.note
//       gaps.json#gap.past_date_policy.candidate_options
//
// Nothing here knows any project, language or framework: both shapes are
// resolved by walking the artifact that was retrieved for this requirement, so
// an identifier that exists only in another requirement's artifact instance
// cannot resolve even though the two instances share a filename.

// Keys whose value names something citable. `_ref` is included because a
// package artifact records decisions by reference (`gap_ref`, `surface_ref`)
// rather than by embedding the referenced object.
const ID_KEY = /^(id|.*_id|ref|.*_ref)$/;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// `a.b[2].c`, `a.b.2.c` and `a` all split to the same segment list. Bracket
// syntax is what the artifacts are cited with; the dotted-index form is
// accepted as the same path rather than treated as a separate schema.
function segments(locator) {
  const parts = [];
  for (const chunk of locator.split(".")) {
    if (!chunk) return null;
    const head = chunk.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!head) return null;
    if (head[1]) parts.push(head[1]);
    else if (!head[2]) return null;
    for (const index of head[2].match(/\d+/g) || []) parts.push(index);
  }
  return parts.length ? parts : null;
}

// Walks one already-parsed path. A key that exists with a null value resolves:
// the question is existence, not usefulness.
function walk(node, parts) {
  let current = node;
  for (const part of parts) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) return false;
      const index = Number(part);
      if (index >= current.length) return false;
      current = current[index];
      continue;
    }
    if (!isObject(current) || !Object.hasOwn(current, part)) return false;
    current = current[part];
  }
  return true;
}

// Every value recorded under an id-like key, mapped to the node that carries it.
// Collected per call because the artifact set is requirement scoped: the same
// filename holds different identifiers for a different requirement.
function identifiers(artifact) {
  const found = new Map();
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string" && ID_KEY.test(key) && !found.has(value)) found.set(value, node);
      visit(value);
    }
  };
  visit(artifact);
  return found;
}

// True when `locator` names something that exists inside `artifact`.
// A Markdown artifact resolves to true for any non-empty locator: the current
// citation contract defines locators over structured artifacts only, and
// inventing anchor rules for prose here would be a new locator schema rather
// than enforcement of the existing one.
export function locatorExists(artifact, locator) {
  if (typeof locator !== "string" || !locator.trim()) return false;
  if (typeof artifact === "string") return true;
  if (!isObject(artifact)) return false;

  const parts = segments(locator);
  if (!parts) return false;
  if (walk(artifact, parts)) return true;

  // The locator may start at an identifier rather than at the artifact root.
  // Longest prefix first, so an identifier containing dots is matched whole
  // before any shorter prefix of it.
  const byId = identifiers(artifact);
  for (let end = parts.length; end > 0; end -= 1) {
    const anchor = byId.get(parts.slice(0, end).join("."));
    if (anchor && walk(anchor, parts.slice(end))) return true;
  }
  return false;
}

// Splits `filename#locator`. Only the first `#` separates the two, so a locator
// is free to contain one.
export function splitCitation(citation) {
  const index = citation.indexOf("#");
  if (index < 0) return { filename: citation, locator: "" };
  return { filename: citation.slice(0, index), locator: citation.slice(index + 1) };
}

// A citation is supported when its file was retrieved for this request and its
// locator exists in that retrieved artifact. Both halves are required: the
// filename alone is not a citation under the current contract.
export function citationSupported(artifacts, retrieved, citation) {
  if (typeof citation !== "string") return false;
  const { filename, locator } = splitCitation(citation);
  if (!retrieved.includes(filename)) return false;
  return locatorExists(artifacts[filename], locator);
}
