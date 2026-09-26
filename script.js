// Ask Forge: questions about the published evidence. All visible strings come from
// the locale copy embedded in the page (#forge-copy); the PetClinic decision demo
// lives in demo.js.

// --- ask error message (pure) -----------------------------------------------
// The failure message shown when /api/ask does not return a usable answer. Only
// the API's own safe `error` string is ever displayed; when the body is not JSON
// (an edge proxy HTML page, for example) nothing from the body is rendered — the
// HTTP status alone is added so an upstream failure is still distinguishable.
// `messages` carries the locale's fallback wording; Japanese is the default.
function askErrorMessage(status, data, messages) {
  const text = messages || {
    generic: "Ask Forge の回答を取得できませんでした。",
    withStatus: "Ask Forge の回答を取得できませんでした（HTTP {status}）。",
  };
  const safeError = data && typeof data.error === "string" ? data.error.trim() : "";
  if (safeError) return safeError;
  const code = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  return code === null ? text.generic : text.withStatus.replace("{status}", String(code));
}
// --- end ask error message ---------------------------------------------------

// --- evidence location (pure) ------------------------------------------------
// The human-readable location shown on an Evidence card. Language independent:
// whatever the source extension is, it is dropped before a symbol is appended, so
// `Document.ts` + `restoreTo` reads as `Document.restoreTo` and `Owner.java` +
// `findByLastName` as `Owner.findByLastName`. A symbol that already carries the
// file name — an API route name, for instance — is shown on its own rather than
// repeated. Without a symbol the filename stands as recorded.
function evidenceLocation(evidence) {
  if (!evidence?.path) return "";
  const filename = evidence.path.split("/").pop();
  if (!evidence.symbol) return filename;
  const base = filename.replace(/\.[^.]+$/, "");
  const carriesBase = evidence.symbol === base || evidence.symbol.startsWith(`${base}.`);
  return carriesBase ? evidence.symbol : `${base}.${evidence.symbol}`;
}
// --- end evidence location ---------------------------------------------------

const askForge = document.querySelector("[data-ask-forge]");
const askCopyNode = document.getElementById("forge-copy");

if (askForge && askCopyNode) {
  const t = JSON.parse(askCopyNode.textContent).ask;
  const form = askForge.querySelector("[data-ask-form]");
  const question = askForge.querySelector("[data-ask-question]");
  const count = askForge.querySelector("[data-character-count]");
  const submit = askForge.querySelector("[data-ask-submit]");
  const submitLabel = askForge.querySelector("[data-submit-label]");
  const output = askForge.querySelector("[data-ask-output]");
  const empty = askForge.querySelector("[data-ask-empty]");
  const errorBox = askForge.querySelector("[data-ask-error]");
  const resultBox = askForge.querySelector("[data-ask-result]");

  const updateCount = () => {
    count.textContent = `${[...question.value].length} / 500`;
  };

  // Public requirement registry, mirroring the server-side one. The id is the only
  // value sent to the API; the base path is used to render Evidence locally.
  const requirements = {
    "owner-city-search": { basePath: "/examples/petclinic" },
    "same-day-visit": { basePath: "/examples/petclinic-same-day-visit" },
    "outline-restore-nested-documents": { basePath: "/examples/outline-restore-nested-documents" },
  };

  const picker = document.querySelector("[data-requirement-picker]");
  const requirementTabs = picker ? [...picker.querySelectorAll("[data-requirement]")] : [];
  const requirementNote = picker?.querySelector("[data-requirement-note]");
  const presetList = askForge.querySelector("[data-preset-list]");
  let activeRequirement = requirementTabs[0]?.dataset.requirement || "owner-city-search";

  const artifactNames = ["project_context.json", "gaps.json", "implementation_package.json"];
  // Keyed by requirement as well as source: the same filename resolves to different
  // evidence for each requirement, so a shared key would render the wrong artifact.
  const artifactCache = new Map();

  const loadArtifact = async (source) => {
    if (!artifactNames.includes(source)) return null;
    const base = requirements[activeRequirement]?.basePath;
    if (!base) return null;
    const key = `${activeRequirement}:${source}`;
    if (!artifactCache.has(key)) {
      artifactCache.set(
        key,
        fetch(`${base}/${source}`)
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null),
      );
    }
    return artifactCache.get(key);
  };

  const humanizeIdentifier = (value) => String(value || "")
    .replace(/^(surface|gap)\./, "")
    .split(/[._/]+/)
    .filter((part) => !["ui", "api", "repository", "model", "test", "persistence"].includes(part.toLowerCase()))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

  // Each piece of evidence is shown as a code location next to what it supports.
  const describeEvidence = (reference, artifact) => {
    const fallback = t.evidenceFallback;
    const [source, locator = ""] = String(reference).split("#", 2);
    if (source === "project_context.json" && artifact) {
      const surface = artifact.relevant_implementation_surfaces?.find((item) => item.id === locator);
      if (surface) {
        return { location: evidenceLocation(surface.evidence), title: humanizeIdentifier(surface.id), detail: surface.description };
      }
      return { title: "Project Context", detail: artifact.note || fallback.context };
    }
    if (source === "gaps.json" && artifact) {
      const gap = artifact.gaps?.find((item) => locator === item.id || locator.startsWith(`${item.id}.`));
      if (gap) return { title: gap.question, detail: gap.why_not_resolved_automatically };
      const openCount = artifact.gaps?.filter((item) => item.status === "open").length || 0;
      return { title: fallback.gapsTitle, detail: fallback.gapsCount.replace("{count}", String(openCount)) };
    }
    if (source === "implementation_package.json" && artifact) {
      const surface = artifact.implementation_surfaces?.find((item) => item.surface_ref === locator);
      if (surface) return { title: humanizeIdentifier(surface.surface_ref), detail: surface.change };
      const decision = artifact.human_decisions?.find((item) => item.gap_ref === locator);
      if (decision) return { title: humanizeIdentifier(decision.gap_ref), detail: fallback.decision };
      return { title: fallback.packageTitle, detail: artifact.handoff_note || fallback.packageDetail };
    }
    if (source === "architecture.md") return { title: "Forge Architecture", detail: fallback.architecture };
    return { title: humanizeIdentifier(locator) || source.replace(/\.[^.]+$/, ""), detail: fallback.generic };
  };

  const renderEvidence = async (references) => {
    const list = askForge.querySelector("[data-result-evidence]");
    const described = await Promise.all(references.map(async (reference) => {
      const source = String(reference).split("#", 1)[0];
      return describeEvidence(reference, await loadArtifact(source));
    }));
    // Several refs can resolve to the same fallback. Show one entry per rendered
    // result, in first-seen order; the raw refs stay in the technical metadata.
    const seen = new Set();
    const evidence = described.filter((value) => {
      const identity = JSON.stringify([value.location, value.title, value.detail]);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
    list.replaceChildren();
    evidence.forEach((value) => {
      const item = document.createElement("li");
      item.className = "evidence-item";
      const detail = document.createElement("span");
      detail.textContent = value.detail;
      item.append(detail);
      const where = document.createElement(value.location ? "code" : "strong");
      where.textContent = value.location || value.title;
      item.append(where);
      list.append(item);
    });
  };

  const showError = (message, requestId) => {
    empty.hidden = true;
    resultBox.hidden = true;
    errorBox.hidden = false;
    errorBox.textContent = requestId ? `${message}（Request ID: ${requestId}）` : message;
  };

  const partitionAnswer = (answer) => {
    const lines = String(answer || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const bullets = lines.filter((line) => /^[-*・]\s*/.test(line)).map((line) => line.replace(/^[-*・]\s*/, ""));
    const prose = lines.filter((line) => !/^[-*・]\s*/.test(line));

    if (!prose.length) {
      return { summary: t.bulletsSummary, points: bullets };
    }

    if (prose.length === 1 && !bullets.length) {
      const sentences = prose[0].match(/[^。！？]+[。！？]?/g)?.map((sentence) => sentence.trim()).filter(Boolean) || [];
      if (sentences.length > 1) return { summary: sentences[0], points: sentences.slice(1) };
    }

    return { summary: prose[0], points: [...prose.slice(1), ...bullets] };
  };

  const showResult = async (data) => {
    errorBox.hidden = true;
    empty.hidden = true;
    resultBox.hidden = false;
    askForge.querySelector("[data-result-route]").textContent = data.route;
    // Sufficiency: how well the retrieved artifacts support the answer. It is not a
    // statement about whether a human decision has been made.
    const sufficiencyMessage = t.sufficiency[data.sufficiency] || t.sufficiency.unknown;
    const sufficiency = askForge.querySelector("[data-result-sufficiency]");
    sufficiency.textContent = `${data.sufficiency} — ${sufficiencyMessage}`;
    sufficiency.dataset.state = data.sufficiency;
    const answerNotice = askForge.querySelector("[data-result-answer-notice]");
    answerNotice.hidden = data.sufficiency === "sufficient";
    answerNotice.dataset.state = data.sufficiency;
    answerNotice.textContent = sufficiencyMessage;
    const answer = partitionAnswer(data.answer);
    askForge.querySelector("[data-result-answer-summary]").textContent = answer.summary;
    const answerPoints = askForge.querySelector("[data-result-answer-points]");
    answerPoints.replaceChildren();
    answer.points.forEach((value) => {
      const item = document.createElement("li");
      item.textContent = value;
      answerPoints.append(item);
    });
    answerPoints.hidden = answer.points.length === 0;
    askForge.querySelector("[data-result-request-id]").textContent = data.request_id;
    const evidenceRefs = Array.isArray(data.evidence) ? data.evidence : [];
    await renderEvidence(evidenceRefs);

    const rawEvidence = askForge.querySelector("[data-result-raw-evidence]");
    rawEvidence.replaceChildren();
    evidenceRefs.forEach((reference) => {
      const item = document.createElement("li");
      item.textContent = reference;
      rawEvidence.append(item);
    });

    const authority = askForge.querySelector("[data-result-authority]");
    authority.replaceChildren();
    const authorityItems = Array.isArray(data.human_authority) ? data.human_authority : [];
    authority.dataset.state = authorityItems.length ? "required" : "none";
    if (!authorityItems.length) {
      const note = document.createElement("p");
      note.className = "authority-empty";
      note.textContent = t.authorityNone;
      authority.append(note);
    } else {
      authorityItems.forEach((value) => {
        const item = document.createElement("div");
        item.className = "authority-item";
        const topic = document.createElement("b");
        topic.textContent = value.topic;
        const status = document.createElement("span");
        status.textContent = value.status === "open" ? t.authorityOpen : value.status;
        item.append(topic, status);
        if (Array.isArray(value.candidate_options) && value.candidate_options.length) {
          const optionsLabel = document.createElement("p");
          optionsLabel.className = "authority-options-label";
          optionsLabel.textContent = t.authorityOptions;
          const options = document.createElement("ul");
          options.className = "authority-options";
          value.candidate_options.forEach((candidate) => {
            const option = document.createElement("li");
            option.textContent = candidate;
            options.append(option);
          });
          item.append(optionsLabel, options);
        }
        authority.append(item);
      });
    }

    const sources = askForge.querySelector("[data-result-sources]");
    sources.textContent = (Array.isArray(data.retrieved_sources) ? data.retrieved_sources : []).join(", ");
  };

  const renderPresets = () => {
    presetList.replaceChildren();
    (t.presets[activeRequirement] || []).forEach((text) => {
      const preset = document.createElement("button");
      preset.type = "button";
      preset.dataset.preset = "";
      preset.textContent = text;
      preset.addEventListener("click", () => {
        question.value = text;
        updateCount();
        question.focus();
      });
      presetList.append(preset);
    });
  };

  const activateRequirement = (id) => {
    if (!requirements[id]) return;
    const changed = id !== activeRequirement;
    activeRequirement = id;
    requirementTabs.forEach((tab) => {
      const active = tab.dataset.requirement === id;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    if (requirementNote) requirementNote.textContent = t.requirements[id]?.note || "";
    renderPresets();
    if (changed) {
      // A previous answer was grounded in the other requirement's artifacts, so it
      // is cleared rather than left on screen under a new active requirement.
      question.value = "";
      updateCount();
      resultBox.hidden = true;
      errorBox.hidden = true;
      empty.hidden = false;
    }
  };

  requirementTabs.forEach((tab, position) => {
    tab.addEventListener("click", () => activateRequirement(tab.dataset.requirement));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "ArrowRight"
        ? (position + 1) % requirementTabs.length
        : (position - 1 + requirementTabs.length) % requirementTabs.length;
      activateRequirement(requirementTabs[next].dataset.requirement);
      requirementTabs[next].focus();
    });
  });

  activateRequirement(activeRequirement);

  question.addEventListener("input", updateCount);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = question.value.trim();
    if (!text) {
      showError(t.errors.empty);
      question.focus();
      return;
    }
    submit.disabled = true;
    submitLabel.textContent = t.submitting;
    output.setAttribute("aria-busy", "true");
    errorBox.hidden = true;
    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requirement_id: activeRequirement, question: text }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        showError(askErrorMessage(response.status, data, t.errors), data.request_id);
      } else {
        await showResult(data);
      }
    } catch {
      showError(t.errors.network);
    } finally {
      submit.disabled = false;
      submitLabel.textContent = t.submit;
      output.setAttribute("aria-busy", "false");
    }
  });

  updateCount();
}

// Keeps the reader's place when switching language: the section anchor carries over.
document.querySelectorAll("[data-lang-link]").forEach((link) => {
  link.addEventListener("click", () => {
    if (location.hash) link.href = `${link.getAttribute("href").split("#")[0]}${location.hash}`;
  });
});

const contactEmail = String(window.FORGE_PUBLIC_CONFIG?.contactEmail || "").trim();
const contactLink = document.querySelector("[data-contact-link]");
if (contactLink && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
  contactLink.href = `mailto:${encodeURIComponent(contactEmail)}?subject=${encodeURIComponent("Forge public showcase feedback")}`;
  contactLink.hidden = false;
}
