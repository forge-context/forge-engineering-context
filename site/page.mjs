// Renders the public page for one locale. The build writes one file per locale
// (`/`, `/zh/`, `/en/`); every locale shares this markup and differs only in copy.
import { COPY, LOCALES, PATHS, REFS, REPO, SITE } from "./copy.mjs";

const HREFLANG = { ja: "ja", zh: "zh-Hans", en: "en" };
const LANG_NAMES = { ja: "日本語", zh: "中文", en: "English" };
const LANG_SHORT = { ja: "JA", zh: "中文", en: "EN" };
const ARTIFACT_BASE = `${REPO}/blob/main/examples/petclinic`;

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Escapes the text, then turns `backtick` spans into <code>.
export function fmt(value) {
  return escapeHtml(value).replace(/`([^`]+)`/g, "<code>$1</code>");
}

const ext = (href, label, className = "") =>
  `<a${className ? ` class="${className}"` : ""} href="${escapeHtml(href)}" rel="noopener">${label} <span aria-hidden="true">↗</span></a>`;

function codeRef(key) {
  const ref = REFS[key];
  return `<a class="code-ref" href="${escapeHtml(ref.url)}" rel="noopener"><code>${escapeHtml(ref.symbol)}</code><span aria-hidden="true">↗</span></a>`;
}

function langSwitch(locale, c) {
  const links = LOCALES.map((code) => {
    const current = code === locale ? ' aria-current="true"' : "";
    return `<a href="${PATHS[code]}" hreflang="${HREFLANG[code]}" lang="${HREFLANG[code]}" data-lang-link title="${LANG_NAMES[code]}"${current}>${LANG_SHORT[code]}</a>`;
  }).join("");
  return `<div class="lang-switch" role="group" aria-label="${escapeHtml(c.nav.lang)}">${links}</div>`;
}

function hero(c) {
  const t = c.teaser;
  return `
      <section class="hero" id="top" aria-labelledby="hero-title">
        <div class="shell">
          <p class="eyebrow">${fmt(c.hero.eyebrow)}</p>
          <h1 id="hero-title">${c.hero.h1.map((line) => `<span>${fmt(line)}</span>`).join("")}</h1>
          <div class="hero-grid">
            <div class="hero-copy">
              <p class="hero-lede">${fmt(c.hero.lede)}</p>
              <p class="hero-audience">${fmt(c.hero.audience)}</p>
              <div class="hero-actions">
                <a class="button button-primary" href="#case" data-hero-cta>${fmt(c.hero.ctaPrimary)} <span aria-hidden="true">↓</span></a>
                ${ext(REPO, fmt(c.hero.ctaSecondary), "text-link")}
              </div>
              <p class="hero-cta-note">${fmt(c.hero.ctaPrimaryNote)}</p>
            </div>
            <aside class="record-card" aria-label="${escapeHtml(t.label)}">
              <p class="record-label">${fmt(t.label)}</p>
              <div class="record-requirement">
                <span>${fmt(t.requirementLabel)}</span>
                <p>「${fmt(t.requirement)}」</p>
              </div>
              <ul class="record-facts">
                ${t.facts.map((f) => `<li><b>${fmt(f.value)}</b><span>${fmt(f.text)}</span></li>`).join("")}
              </ul>
              <p class="record-foot">${fmt(t.foot)}</p>
            </aside>
          </div>
        </div>
      </section>`;
}

function why(c) {
  const w = c.why;
  return `
      <section class="section why" id="why" aria-labelledby="why-title">
        <div class="shell">
          <div class="why-head">
            <p class="kicker">${fmt(w.kicker)}</p>
            <h2 id="why-title">${fmt(w.title)}</h2>
            <p class="lead">${fmt(w.lead)}</p>
          </div>
          <dl class="why-stats">
            ${w.stats.map((s) => `<div><dt>${fmt(s.value)}</dt><dd>${fmt(s.text)}</dd></div>`).join("")}
          </dl>
          <div class="limits">
            <p class="limits-title">${fmt(w.limitsTitle)}</p>
            <ul>${w.limits.map((l) => `<li>${fmt(l)}</li>`).join("")}</ul>
          </div>
        </div>
      </section>`;
}

function realCase(c, locale) {
  const k = c.case;
  const d = k.decision;
  const options = Object.entries(d.options)
    .map(([id, o]) => `
                  <button type="button" class="option" role="radio" aria-checked="false" data-choice="${id}">
                    <span class="option-mark" aria-hidden="true"></span>
                    <span class="option-body"><b>${fmt(o.name)}</b><span>${fmt(o.desc)}</span><small>${fmt(o.tag)}</small></span>
                  </button>`)
    .join("");
  return `
      <section class="section case" id="case" aria-labelledby="case-title">
        <div class="shell">
          <div class="case-head">
            <p class="kicker">${fmt(k.kicker)}</p>
            <h2 id="case-title">${fmt(k.title)}</h2>
            <p class="lead">${fmt(k.sub)}</p>
          </div>
          <ol class="phases" aria-label="${escapeHtml(k.phasesLabel)}" data-phases>
            ${k.phases.map((p, i) => `<li data-phase="${i}"><span>${i + 1}</span>${fmt(p)}</li>`).join("")}
          </ol>

          <div class="demo" data-demo>
            <article class="step">
              <p class="step-label"><span>1</span>${fmt(k.s1.label)}</p>
              <p class="requirement-quote">「${fmt(k.s1.requirement)}」</p>
              <ul class="claims">
                ${k.s1.context.map((x) => `<li><span>${fmt(x.text)}</span>${codeRef(x.ref)}</li>`).join("")}
              </ul>
            </article>

            <article class="step step-record">
              <p class="step-label"><span>2</span>${fmt(k.s2.label)}</p>
              <div class="record-panel">
                <p class="record-provenance">${fmt(k.s2.provenance)}</p>
                <ul class="done-list">
                  ${k.s2.done.map((x) => `<li><span>${fmt(x.text)}</span><em>${fmt(x.tag)}</em></li>`).join("")}
                </ul>
              </div>
              <p class="turn">${fmt(k.s2.turn)}</p>
              <p class="subhead">${fmt(k.s2.decisionsTitle)}</p>
              <ol class="silent-list">
                ${k.s2.decisions.map((x) => `<li>${fmt(x)}</li>`).join("")}
              </ol>
              <p class="note">${fmt(k.s2.decisionsNote)}</p>
            </article>

            <article class="step">
              <p class="step-label"><span>3</span>${fmt(k.s3.label)}</p>
              <p class="step-lead">${fmt(k.s3.lead)}</p>
              <ol class="gap-list">
                ${k.s3.gaps.map((g) => `
                <li>
                  <b>${fmt(g.q)}</b>
                  <p>${fmt(g.why)}</p>
                  <small>${fmt(k.s3.agentLabel)}${locale === "en" ? " " : ""}${fmt(g.agent)}</small>
                </li>`).join("")}
              </ol>
            </article>

            <article class="step step-decision" id="decide" data-decision>
              <p class="step-label"><span>4</span>${fmt(d.label)}</p>
              <div class="decision-card">
                <p class="status-pill" data-decision-status data-state="pending">${fmt(d.pending)}</p>
                <h3 id="decision-question">${fmt(d.question)}</h3>
                <p class="decision-why">${fmt(d.why)}</p>
                <div class="options" role="radiogroup" aria-labelledby="decision-question">${options}
                </div>
                <p class="decision-rule">${fmt(d.rule)}</p>
                <div class="after-decision" data-agent-chose hidden>
                  <p class="agent-chose">${fmt(d.agentChose)}</p>
                  <a class="text-link" href="#proposal">${fmt(d.seeProposal)} <span aria-hidden="true">↓</span></a>
                </div>
              </div>
              <div class="others">
                <p class="subhead">${fmt(d.othersTitle)}</p>
                <ul>${d.others.map((x) => `<li>${fmt(x)}</li>`).join("")}</ul>
              </div>
            </article>

            <article class="step step-proposal" id="proposal" data-proposal-step>
              <p class="step-label"><span>5</span>${fmt(k.proposal.label)}</p>
              <div class="proposal" data-proposal aria-live="polite"></div>
              <div class="proposal-actions">
                <button type="button" class="button button-primary" data-approve disabled>${fmt(k.proposal.approve)}</button>
                <p class="approve-hint" data-approve-hint>${fmt(k.proposal.approveHint)}</p>
                <button type="button" class="text-button" data-reset hidden>${fmt(k.proposal.reset)}</button>
              </div>
              <div class="handoff" data-handoff hidden tabindex="-1">
                <p class="handoff-title">${fmt(k.proposal.handoffTitle)}</p>
                <p class="handoff-note">${fmt(k.proposal.handoffNote)}</p>
                <details>
                  <summary>${fmt(k.proposal.handoffDetails)}</summary>
                  <pre data-package></pre>
                </details>
              </div>
            </article>
          </div>
        </div>
      </section>`;
}

function evidence(c, locale) {
  const e = c.evidence;
  const a = c.ask;
  const tabs = Object.entries(a.requirements)
    .map(([id, r], i) => `
              <button type="button" role="tab" aria-selected="${i === 0}" data-requirement="${id}"${i === 0 ? ' class="is-active"' : ' tabindex="-1"'}>
                <em>${fmt(r.project)}</em><b>${fmt(r.label)}</b>
              </button>`)
    .join("");
  return `
      <section class="section evidence" id="evidence" aria-labelledby="evidence-title">
        <div class="shell">
          <div class="evidence-head">
            <p class="kicker">${fmt(e.kicker)}</p>
            <h2 id="evidence-title">${fmt(e.title)}</h2>
            <p class="lead">${fmt(e.lead)}</p>
          </div>
          <ul class="claims claims-wide">
            ${e.claims.map((x) => `<li><span>${fmt(x.text)}</span>${codeRef(x.ref)}</li>`).join("")}
          </ul>
          <p class="artifacts">
            <span>${fmt(e.artifactsLabel)}</span>
            ${ext(`${ARTIFACT_BASE}/project_context.json`, fmt(e.artifacts.context))}
            ${ext(`${ARTIFACT_BASE}/gaps.json`, fmt(e.artifacts.gaps))}
            ${ext(`${ARTIFACT_BASE}/implementation_package.json`, fmt(e.artifacts.package))}
          </p>

          <details class="ask" id="ask-forge">
            <summary class="ask-head">
              <span class="ask-title">${fmt(a.title)}</span>
              <span class="ask-lead">${fmt(a.lead)}${a.langNote ? ` <strong>${fmt(a.langNote)}</strong>` : ""}</span>
            </summary>
            <div class="ask-requirement" data-requirement-picker>
              <p class="ask-label" id="ask-requirements-label">${fmt(a.requirementsLabel)}</p>
              <div class="requirement-tabs" role="tablist" aria-labelledby="ask-requirements-label">${tabs}
              </div>
              <p class="requirement-note" data-requirement-note></p>
            </div>
            <div class="ask-layout" data-ask-forge data-locale="${locale}">
              <form class="ask-form" data-ask-form>
                <fieldset>
                  <legend>${fmt(a.presetsLabel)}</legend>
                  <div class="preset-list" data-preset-list></div>
                </fieldset>
                <label for="ask-question">${fmt(a.inputLabel)}</label>
                <textarea id="ask-question" data-ask-question maxlength="500" rows="3" placeholder="${escapeHtml(a.placeholder)}"></textarea>
                <div class="ask-form-footer">
                  <span data-character-count>0 / 500</span>
                  <button class="button" type="submit" data-ask-submit><span data-submit-label>${fmt(a.submit)}</span> <span aria-hidden="true">→</span></button>
                </div>
                <p class="ask-form-note">${fmt(a.formNote)}</p>
              </form>
              <div class="ask-output" aria-live="polite" aria-busy="false" data-ask-output>
                <p class="ask-empty" data-ask-empty>${fmt(a.empty)}</p>
                <div class="ask-error" data-ask-error hidden></div>
                <div class="ask-result" data-ask-result hidden>
                  <section>
                    <h4>${fmt(a.answer)}</h4>
                    <div class="answer-notice" data-result-answer-notice hidden></div>
                    <p class="answer-summary" data-result-answer-summary></p>
                    <ul class="answer-points" data-result-answer-points hidden></ul>
                  </section>
                  <section><h4>${fmt(a.evidence)}</h4><ul class="evidence-list" data-result-evidence></ul></section>
                  <section><h4>${fmt(a.authority)}</h4><div data-result-authority></div></section>
                  <details class="result-trace">
                    <summary>${fmt(a.trace)}</summary>
                    <dl>
                      <div><dt>${fmt(a.traceRoute)}</dt><dd data-result-route></dd></div>
                      <div><dt>${fmt(a.traceSufficiency)}</dt><dd data-result-sufficiency></dd></div>
                      <div><dt>${fmt(a.traceSources)}</dt><dd data-result-sources></dd></div>
                      <div><dt>${fmt(a.traceRefs)}</dt><dd><ul data-result-raw-evidence></ul></dd></div>
                      <div><dt>${fmt(a.traceRequest)}</dt><dd><code data-result-request-id></code></dd></div>
                    </dl>
                  </details>
                </div>
              </div>
            </div>
          </details>
        </div>
      </section>`;
}

function status(c) {
  const s = c.status;
  return `
      <section class="section status" id="status" aria-labelledby="status-title">
        <div class="shell status-grid">
          <div>
            <p class="kicker" id="status-title">${fmt(s.kicker)}</p>
            <h3>${fmt(s.todayTitle)}</h3>
            <ul class="today-list">${s.today.map((x) => `<li>${fmt(x)}</li>`).join("")}</ul>
            <p class="note">${fmt(s.todayNote)}</p>
            <p class="others-links"><span>${fmt(s.othersLabel)}</span>${s.others.map((o) => ext(o.href, fmt(o.label))).join("")}</p>
          </div>
          <div class="next">
            <h3>${fmt(s.nextTitle)}</h3>
            <p>${fmt(s.next)}</p>
          </div>
        </div>
      </section>`;
}

function closing(c) {
  return `
      <section class="closing" id="github" aria-labelledby="closing-title">
        <div class="shell">
          <h2 id="closing-title">${fmt(c.cta.title)}</h2>
          <div class="closing-actions">
            ${ext(REPO, fmt(c.cta.github), "button button-primary")}
            <a class="text-link" href="${escapeHtml(c.cta.backUrl)}">${fmt(c.cta.back)}</a>
            <a class="text-link text-link-quiet" data-contact-link hidden>${fmt(c.cta.contact)}</a>
          </div>
        </div>
      </section>`;
}

// JSON handed to the browser scripts. `</` is escaped so no string can close the tag.
function clientCopy(c) {
  const payload = { case: c.case, ask: c.ask };
  return JSON.stringify(payload).replaceAll("</", "<\\/");
}

export function renderPage(locale) {
  const c = COPY[locale];
  const canonical = `${SITE}${PATHS[locale]}`;
  const alternates = LOCALES.map(
    (code) => `<link rel="alternate" hreflang="${HREFLANG[code]}" href="${SITE}${PATHS[code]}" />`,
  ).join("\n    ");
  return `<!doctype html>
<html lang="${c.meta.lang}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(c.meta.title)}</title>
    <meta name="description" content="${escapeHtml(c.meta.description)}" />
    <link rel="canonical" href="${canonical}" />
    ${alternates}
    <link rel="alternate" hreflang="x-default" href="${SITE}/" />
    <meta property="og:title" content="${escapeHtml(c.meta.title)}" />
    <meta property="og:description" content="${escapeHtml(c.meta.description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${SITE}/og-image.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="${escapeHtml(c.meta.ogAlt)}" />
    <meta property="og:site_name" content="Forge" />
    <meta property="og:locale" content="${c.meta.ogLocale}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(c.meta.title)}" />
    <meta name="twitter:description" content="${escapeHtml(c.meta.description)}" />
    <meta name="twitter:image" content="${SITE}/og-image.png" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" href="/favicon.png" sizes="32x32" type="image/png" />
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <a class="skip-link" href="#main">${fmt(c.skip)}</a>
    <header class="site-header">
      <div class="shell header-inner">
        <a class="brand" href="${PATHS[locale]}" aria-label="Forge">
          <span class="brand-mark" aria-hidden="true">F</span><span>Forge</span>
        </a>
        <nav aria-label="${escapeHtml(c.nav.label)}">
          <a href="#case">${fmt(c.nav.case)}</a>
          <a href="#evidence">${fmt(c.nav.evidence)}</a>
          <a class="nav-github" href="${REPO}" rel="noopener">${fmt(c.nav.github)} <span aria-hidden="true">↗</span></a>
          ${langSwitch(locale, c)}
        </nav>
      </div>
    </header>
    <main id="main">${hero(c)}${why(c)}${realCase(c, locale)}${evidence(c, locale)}${status(c)}${closing(c)}
    </main>
    <footer class="site-footer">
      <div class="shell footer-inner">
        <span class="brand"><span class="brand-mark" aria-hidden="true">F</span><span>Forge</span></span>
        <span>${fmt(c.footer.status)}</span>
        ${langSwitch(locale, c)}
      </div>
    </footer>
    <script type="application/json" id="forge-copy">${clientCopy(c)}</script>
    <script src="/public-config.js"></script>
    <script type="module" src="/demo.js"></script>
    <script src="/script.js"></script>
  </body>
</html>
`;
}
