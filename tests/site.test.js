import test from "node:test";
import assert from "node:assert/strict";

import { COPY, LOCALES, PATHS } from "../site/copy.mjs";
import { renderPage } from "../site/page.mjs";
import {
  CHOICES,
  approve,
  buildPackage,
  buildProposal,
  choose,
  currentPhase,
  initialState,
  reset,
} from "../demo-model.js";

// --- locales ------------------------------------------------------------------

function keyPaths(value, prefix = "") {
  if (Array.isArray(value)) return [`${prefix}[${value.length}]`, ...value.flatMap((item, i) => keyPaths(item, `${prefix}[${i}]`))];
  if (value && typeof value === "object") {
    return Object.keys(value).sort().flatMap((key) => [`${prefix}.${key}`, ...keyPaths(value[key], `${prefix}.${key}`)]);
  }
  return [];
}

test("every locale carries the same copy structure as Japanese", () => {
  const reference = keyPaths(COPY.ja);
  for (const locale of LOCALES) {
    assert.deepEqual(keyPaths(COPY[locale]), reference, `${locale} must mirror the Japanese copy`);
  }
});

test("each locale renders at its own path with lang, canonical and alternates", () => {
  assert.deepEqual(PATHS, { ja: "/", zh: "/zh/", en: "/en/" });
  for (const locale of LOCALES) {
    const html = renderPage(locale);
    assert.match(html, new RegExp(`<html lang="${COPY[locale].meta.lang}">`));
    assert.match(html, new RegExp(`<link rel="canonical" href="https://forge.jianguoding.com${PATHS[locale]}" />`));
    for (const other of LOCALES) {
      assert.ok(html.includes(`href="https://forge.jianguoding.com${PATHS[other]}"`), `${locale} must list ${other} as an alternate`);
      assert.ok(html.includes(`<a href="${PATHS[other]}"`), `${locale} must link to ${other} in the language switch`);
    }
    // Assets are absolute so /zh/ and /en/ resolve them from the site root.
    assert.ok(html.includes('href="/styles.css"'));
    assert.ok(html.includes('src="/demo.js"'));
  }
});

test("the language switch marks only the current locale", () => {
  for (const locale of LOCALES) {
    const html = renderPage(locale);
    const current = [...html.matchAll(/<a href="([^"]+)"[^>]*aria-current="true"/g)].map((match) => match[1]);
    assert.ok(current.length >= 1);
    assert.ok(current.every((href) => href === PATHS[locale]));
  }
});

test("the page ends with GitHub and a way back to jianguoding.com in the same language", () => {
  const back = { ja: "https://jianguoding.com/ja/", zh: "https://jianguoding.com/zh/", en: "https://jianguoding.com/" };
  for (const locale of LOCALES) {
    const html = renderPage(locale);
    const closing = html.slice(html.indexOf('class="closing"'));
    assert.ok(closing.includes("https://github.com/forge-context/forge-engineering-context"));
    assert.ok(closing.includes(`href="${back[locale]}"`));
  }
});

// --- page structure -----------------------------------------------------------

test("the hero's primary CTA goes straight to the real PetClinic case", () => {
  for (const locale of LOCALES) {
    const html = renderPage(locale);
    const hero = html.slice(html.indexOf('class="hero"'), html.indexOf('id="why"'));
    const cta = hero.match(/<a class="button button-primary" href="([^"]+)" data-hero-cta>/);
    assert.ok(cta, `${locale} hero must have one primary CTA`);
    assert.equal(cta[1], "#case");
    assert.ok(html.includes('id="case"'));
    assert.equal((hero.match(/button-primary/g) || []).length, 1, "the hero has exactly one primary action");
  }
});

test("sections follow the agreed order", () => {
  for (const locale of LOCALES) {
    const html = renderPage(locale);
    const order = ["top", "why", "case", "evidence", "status", "github"].map((id) => html.indexOf(`id="${id}"`));
    assert.ok(order.every((position) => position > 0), `${locale} must render every section`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, `${locale} sections are out of order`);
  }
});

test("the F0 evidence is shown with its limits, and internal object names stay out of the main UI", () => {
  for (const locale of LOCALES) {
    const html = renderPage(locale);
    const why = html.slice(html.indexOf('id="why"'), html.indexOf('id="case"'));
    for (const value of ["26", "0", "0 / 21"]) assert.ok(why.includes(`<dt>${value}</dt>`), `${locale} must show ${value}`);
    assert.equal((why.match(/<li>/g) || []).length, 3, `${locale} must state the three limits`);
    // Schema names may appear only in metadata (the Package disclosure), not as headings.
    for (const internal of ["Context Gap", "Human Alignment", "Evidence Sufficiency"]) {
      assert.ok(!html.includes(internal), `${locale} must not show "${internal}"`);
    }
  }
});

test("the illustrative scenario and the six-step stepper are gone", () => {
  for (const locale of LOCALES) {
    const html = renderPage(locale);
    assert.ok(!html.includes("data-stepper"));
    assert.ok(!html.includes("data-comparison"));
    assert.ok(!/ILLUSTRATIVE/i.test(html));
  }
});

test("the decision offers exactly the candidate options recorded in gaps.json", async () => {
  const { readFile } = await import("node:fs/promises");
  const gaps = JSON.parse(await readFile(new URL("../examples/petclinic/gaps.json", import.meta.url), "utf8"));
  const gap = gaps.gaps.find((item) => item.id === "gap.city_matching_semantics");
  assert.equal(gap.candidate_options.length, CHOICES.length);
  for (const locale of LOCALES) {
    const html = renderPage(locale);
    const offered = [...html.matchAll(/data-choice="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(offered, CHOICES);
    assert.ok(!/<(input|textarea)[^>]*data-choice/.test(html), "the decision allows no free input");
  }
});

// --- decision model -------------------------------------------------------------

const proposalCopy = (locale = "ja") => COPY[locale].case.proposal;
const itemsOf = (proposal, key) => proposal.sections.find((section) => section.key === key).items;

test("before a decision the proposal is blocked and cannot be approved", () => {
  const state = initialState();
  const proposal = buildProposal(proposalCopy(), state);
  assert.equal(proposal.status, "blocked");
  assert.equal(proposal.canApprove, false);
  assert.equal(currentPhase(state), 1);
  assert.ok(itemsOf(proposal, "open").some((item) => item.unresolved));
  assert.ok(proposal.sections.every((section) => section.items.every((item) => !item.changed)));
  assert.equal(buildPackage(proposalCopy(), state), null);
  assert.deepEqual(approve(state), state, "approving without a decision does nothing");
});

test("a decision moves unresolved to decided and rewrites the lines it governs", () => {
  for (const locale of LOCALES) {
    const copy = proposalCopy(locale);
    for (const choice of CHOICES) {
      const state = choose(initialState(), choice);
      const proposal = buildProposal(copy, state);
      assert.equal(proposal.status, "ready");
      assert.equal(proposal.canApprove, true);
      assert.equal(currentPhase(state), 2);
      assert.ok(itemsOf(proposal, "target")[0].text.includes(copy.matchWords[choice]));
      assert.ok(itemsOf(proposal, "decisions")[0].changed);
      assert.equal(itemsOf(proposal, "tests")[0].text, copy.cityTest[choice]);
      assert.ok(itemsOf(proposal, "boundary").some((item) => item.changed));
      assert.ok(!itemsOf(proposal, "open").some((item) => item.unresolved), `${locale}/${choice} leaves nothing unresolved`);
      assert.ok(itemsOf(proposal, "preserved").every((item) => !item.changed), "preserved behavior never depends on the choice");
      assert.ok(proposal.sections.every((section) => section.items.every((item) => !item.text.includes("{match}"))));
    }
  }
});

test("only approval produces the package, and the package follows the decision", () => {
  const copy = proposalCopy("en");
  const packages = CHOICES.map((choice) => {
    const decided = choose(initialState(), choice);
    assert.equal(buildPackage(copy, decided), null, "a decision alone is not an approved direction");
    const approved = approve(decided);
    assert.equal(buildProposal(copy, approved).status, "approved");
    assert.equal(currentPhase(approved), 3);
    const pkg = buildPackage(copy, approved);
    assert.equal(pkg.status, "approved_implementation_direction");
    assert.equal(pkg.human_decisions["gap.city_matching_semantics"], choice);
    assert.ok(pkg.test_intents[0].includes(copy.cityTest[choice].replace(/`/g, "")));
    assert.ok(pkg.preserved_behavior.length > 0 && pkg.change_boundary.length > 0);
    assert.deepEqual(pkg.unresolved_questions.length, 1);
    return JSON.stringify(pkg);
  });
  assert.equal(new Set(packages).size, CHOICES.length, "each decision yields a different package");
});

test("an approved decision is locked until reset, and reset starts over", () => {
  const approved = approve(choose(initialState(), "prefix"));
  assert.deepEqual(choose(approved, "exact"), approved);
  const again = reset();
  assert.deepEqual(again, initialState());
  assert.equal(buildProposal(proposalCopy(), again).status, "blocked");
  // Before approval the decision can still be changed.
  assert.equal(choose(choose(initialState(), "prefix"), "contains").choice, "contains");
  assert.deepEqual(choose(initialState(), "anything"), initialState());
});
