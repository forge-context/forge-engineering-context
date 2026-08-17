const stepContent = [
  {
    status: "入力",
    kicker: "要件",
    title: "注文詳細画面から、注文をキャンセルできるようにしたい。",
    description: "この要件が触れる実装面をたどり、根拠と未確定の判断を段階ごとに整理します。",
    label: "入力された要件",
    detailKind: "text",
    detail: "注文詳細画面から、注文をキャンセルできるようにしたい。",
  },
  {
    status: "対象範囲を限定",
    kicker: "関連する実装面",
    title: "要件に関連する実装面を限定する。",
    description: "プロジェクト全体を要約せず、UI、API、Controller、Service と周辺機能のうち、この変更に必要な Context だけを対象にします。",
    label: "概念上の実装面",
    detailKind: "path",
    detail: ["Order Detail", "Cancel API", "Controller", "Service"],
  },
  {
    status: "観測済み",
    kicker: "Project Context からの観測",
    title: "返金機能、在庫予約、Audit Log の既存実装を、根拠とともに確認する。",
    description: "存在が確認できる機能は事実として記録します。ただし「存在する」ことを「今回使うべき」という仕様判断には変換しません。",
    label: "観測済み",
    detailKind: "tags",
    detail: ["返金 capability", "在庫予約", "Audit Log"],
  },
  {
    status: "未決定",
    kicker: "人の判断が必要",
    title: "返金方針、権限、在庫解放のタイミングは、コードだけでは決められない。",
    description: "追加調査で判明する事実と、責任者が決めるべき事項を区別します。根拠が途切れた場所を、妥当そうな仮定で埋めません。",
    label: "Context Gap",
    detailKind: "tags",
    detail: ["返金ポリシー", "キャンセル権限", "在庫解放タイミング"],
  },
  {
    status: "合意済み",
    kicker: "合意された判断",
    title: "プロジェクト上の権限を持つ人が、未確定事項を具体的に決定する。",
    description: "回答は会話のまま流さず、どの Gap に対する誰の判断かが分かる形で、実装 Context に組み込みます。",
    label: "Human Alignment",
    detailKind: "text",
    detail: "未決定事項と、人が決めた仕様を対応づける。",
  },
  {
    status: "引き継ぎ可能",
    kicker: "Coding Agent への引き継ぎ",
    title: "根拠と決定済み事項を、実装可能な小さな Context として引き継ぐ。",
    description: "Coding Agent は、ビジネス判断を再推論する代わりに、対象範囲と決定が明確になった実装へ集中できます。Forge はその前段を担当します。",
    label: "Implementation Package",
    detailKind: "tags",
    detail: ["根拠", "決定済み仕様", "変更対象", "テスト意図"],
  },
];

const stepper = document.querySelector("[data-stepper]");

if (stepper) {
  const buttons = [...stepper.querySelectorAll("[data-step]")];
  const index = stepper.querySelector("[data-step-index]");
  const status = stepper.querySelector("[data-step-status]");
  const kicker = stepper.querySelector("[data-step-kicker]");
  const title = stepper.querySelector("[data-step-title]");
  const description = stepper.querySelector("[data-step-description]");
  const detail = stepper.querySelector("[data-step-detail]");

  const activateStep = (position) => {
    const content = stepContent[position];

    buttons.forEach((button, buttonIndex) => {
      const active = buttonIndex === position;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });

    index.textContent = `STEP ${String(position + 1).padStart(2, "0")}`;
    status.textContent = content.status;
    kicker.textContent = content.kicker;
    title.textContent = content.title;
    description.textContent = content.description;
    const detailLabel = document.createElement("span");
    detailLabel.textContent = content.label;
    detail.replaceChildren(detailLabel);

    if (content.detailKind === "path") {
      const path = document.createElement("div");
      path.className = "conceptual-path";
      content.detail.forEach((item, itemIndex) => {
        const node = document.createElement("b");
        node.textContent = item;
        path.append(node);
        if (itemIndex < content.detail.length - 1) {
          const arrow = document.createElement("i");
          arrow.textContent = "→";
          path.append(arrow);
        }
      });
      detail.append(path);
    } else if (content.detailKind === "tags") {
      const tags = document.createElement("div");
      tags.className = "conceptual-tags";
      content.detail.forEach((item) => {
        const tag = document.createElement("b");
        tag.textContent = item;
        tags.append(tag);
      });
      detail.append(tags);
    } else {
      const text = document.createElement("p");
      text.textContent = content.detail;
      detail.append(text);
    }
  };

  buttons.forEach((button, position) => {
    button.addEventListener("click", () => activateStep(position));
    button.addEventListener("keydown", (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      let next = position;
      if (event.key === 'ArrowLeft') next = (position - 1 + buttons.length) % buttons.length;
      if (event.key === 'ArrowRight') next = (position + 1) % buttons.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = buttons.length - 1;
      activateStep(next);
      buttons[next].focus();
    });
  });

  activateStep(0);
}

const comparison = document.querySelector("[data-comparison]");

if (comparison) {
  const tabs = [...comparison.querySelectorAll("[data-comparison-tab]")];
  const panels = [...comparison.querySelectorAll("[data-comparison-panel]")];

  const activateComparison = (name) => {
    tabs.forEach((tab) => {
      const active = tab.dataset.comparisonTab === name;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.comparisonPanel !== name;
    });
  };

  tabs.forEach((tab, position) => {
    tab.addEventListener("click", () => activateComparison(tab.dataset.comparisonTab));
    tab.addEventListener("keydown", (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'ArrowRight' ? (position + 1) % tabs.length : (position - 1 + tabs.length) % tabs.length;
      activateComparison(tabs[next].dataset.comparisonTab);
      tabs[next].focus();
    });
  });

  activateComparison("without");
}

// --- ask error message (pure) -----------------------------------------------
// The failure message shown when /api/ask does not return a usable answer. Only
// the API's own safe `error` string is ever displayed; when the body is not JSON
// (an edge proxy HTML page, for example) nothing from the body is rendered — the
// HTTP status alone is added so an upstream failure is still distinguishable.
function askErrorMessage(status, data) {
  const safeError = data && typeof data.error === "string" ? data.error.trim() : "";
  if (safeError) return safeError;
  const code = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  return code === null
    ? "Ask Forge の回答を取得できませんでした。"
    : `Ask Forge の回答を取得できませんでした（HTTP ${code}）。`;
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

if (askForge) {
  const form = askForge.querySelector("[data-ask-form]");
  const question = askForge.querySelector("[data-ask-question]");
  const count = askForge.querySelector("[data-character-count]");
  const submit = askForge.querySelector("[data-ask-submit]");
  const output = askForge.querySelector("[data-ask-output]");
  const empty = askForge.querySelector("[data-ask-empty]");
  const errorBox = askForge.querySelector("[data-ask-error]");
  const resultBox = askForge.querySelector("[data-ask-result]");

  const updateCount = () => {
    count.textContent = `${[...question.value].length} / 500`;
  };

  // Public requirement registry, mirroring the server-side one. The id is the only
  // value sent to the API; the base path is used to render Evidence cards locally.
  const requirements = {
    "owner-city-search": {
      basePath: "examples/petclinic",
      note: "既存の姓検索に、市区町村の条件を追加する要件です。",
      presets: [
        "現在の検索はどう動いていますか？",
        "この要件はどこに影響しますか？",
        "実装前に人が決める必要があることは何ですか？",
        "なぜ city の照合方法を Forge は自動で決めなかったのですか？",
        "Human Alignment 後、Coding Agent には何を渡せますか？",
      ],
    },
    "same-day-visit": {
      basePath: "examples/petclinic-same-day-visit",
      note: "翌日以降しか受け付けない診療予約を、当日にも広げる要件です。",
      presets: [
        "現在の診療予約はどう動いていますか？",
        "この要件はどこに影響しますか？",
        "実装前に人が決める必要があることは何ですか？",
        "なぜ過去日の扱いを Forge は自動で決めなかったのですか？",
        "Human Alignment 後、Coding Agent には何を渡せますか？",
      ],
    },
    "outline-restore-nested-documents": {
      basePath: "examples/outline-restore-nested-documents",
      note: "削除は子文書へ波及するのに、復元は対象の文書だけを戻す非対称を変える要件です。参照プロジェクトは Outline で、PetClinic とは別のプロジェクトです。",
      presets: [
        "親文書をゴミ箱から復元すると、子文書は現在どうなりますか？",
        "この要件はどこに影響しますか？",
        "実装前に人が決める必要があることは何ですか？",
        "なぜ子文書の復元範囲を Forge は自動で決めなかったのですか？",
        "Human Alignment 後、Coding Agent には何を渡せますか？",
      ],
    },
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

  const describeEvidence = (reference, artifact) => {
    const [source, locator = ""] = String(reference).split("#", 2);
    if (source === "project_context.json" && artifact) {
      const surface = artifact.relevant_implementation_surfaces?.find((item) => item.id === locator);
      if (surface) {
        const location = evidenceLocation(surface.evidence);
        return {
          title: [humanizeIdentifier(surface.id), location].filter(Boolean).join(" — "),
          detail: surface.description,
        };
      }
      return { title: "Project Context", detail: artifact.note || "この要件について公開されている Context の範囲です。" };
    }
    if (source === "gaps.json" && artifact) {
      const gap = artifact.gaps?.find((item) => locator === item.id || locator.startsWith(`${item.id}.`));
      if (gap) return { title: gap.question, detail: gap.why_not_resolved_automatically };
      const openCount = artifact.gaps?.filter((item) => item.status === "open").length || 0;
      return { title: "Human Decision の確認範囲", detail: `公開 Artifact には ${openCount} 件の未決定事項が記録されています。` };
    }
    if (source === "implementation_package.json" && artifact) {
      const surface = artifact.implementation_surfaces?.find((item) => item.surface_ref === locator);
      if (surface) return { title: humanizeIdentifier(surface.surface_ref), detail: surface.change };
      const decision = artifact.human_decisions?.find((item) => item.gap_ref === locator);
      if (decision) return { title: humanizeIdentifier(decision.gap_ref), detail: "Human Alignment 後に決定済みの項目です。" };
      return { title: "Implementation Package", detail: artifact.handoff_note || "Coding Agent への引き継ぎ情報です。" };
    }
    if (source === "architecture.md") return { title: "Forge Architecture", detail: "Forge の公開アーキテクチャ文書です。" };
    return { title: humanizeIdentifier(locator) || source.replace(/\.[^.]+$/, ""), detail: "回答で参照された公開 Evidence です。" };
  };

  const renderEvidence = async (references) => {
    const list = askForge.querySelector("[data-result-evidence]");
    const described = await Promise.all(references.map(async (reference) => {
      const source = String(reference).split("#", 1)[0];
      return describeEvidence(reference, await loadArtifact(source));
    }));
    // Several refs can resolve to the same fallback title/detail. Show one card per
    // rendered result, in first-seen order; the raw refs stay in Trace metadata.
    const seen = new Set();
    const evidence = described.filter((value) => {
      const identity = JSON.stringify([value.title, value.detail]);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
    list.replaceChildren();
    evidence.forEach((value) => {
      const item = document.createElement("li");
      item.className = "evidence-item";
      const title = document.createElement("strong");
      title.textContent = value.title;
      const detail = document.createElement("span");
      detail.textContent = value.detail;
      item.append(title, detail);
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
      return { summary: "確認できた内容は次のとおりです。", points: bullets };
    }

    if (prose.length === 1 && !bullets.length) {
      const sentences = prose[0].match(/[^。！？]+[。！？]?/g)?.map((sentence) => sentence.trim()).filter(Boolean) || [];
      if (sentences.length > 1) return { summary: sentences[0], points: sentences.slice(1) };
    }

    return { summary: prose[0], points: [...prose.slice(1), ...bullets] };
  };

  // Evidence Sufficiency（回答根拠の充足度）: how well the retrieved Artifacts support the
  // answer. It is not a statement about whether a Human Decision has been made.
  const sufficiencyCopy = {
    sufficient: "この回答を裏付ける根拠は十分です。Human Decision 自体が決定済みであることを意味しません。",
    partial: "一部は確認できましたが、回答に必要な Context がまだ不足しています。",
    insufficient: "この質問に答えるための根拠が、公開されている Context にありません。Forge は不足部分を推測していません。",
  };

  const showResult = async (data) => {
    errorBox.hidden = true;
    empty.hidden = true;
    resultBox.hidden = false;
    askForge.querySelector("[data-result-route]").textContent = data.route;
    const sufficiency = askForge.querySelector("[data-result-sufficiency]");
    const sufficiencyMessage = sufficiencyCopy[data.sufficiency] || "回答に使用できる Context の状態を確認してください。";
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
      note.textContent = "この回答で新たな Human decision は提示されていません。";
      authority.append(note);
    } else {
      authorityItems.forEach((value) => {
        const item = document.createElement("div");
        item.className = "authority-item";
        const topic = document.createElement("b");
        topic.textContent = value.topic;
        const status = document.createElement("span");
        status.textContent = `${value.status === "open" ? "未決定" : value.status} — Forge は候補を自動選択しません`;
        item.append(topic, status);
        if (Array.isArray(value.candidate_options) && value.candidate_options.length) {
          const optionsLabel = document.createElement("p");
          optionsLabel.className = "authority-options-label";
          optionsLabel.textContent = "候補（いずれも未決定）";
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
    (requirements[activeRequirement]?.presets || []).forEach((text) => {
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
    if (requirementNote) requirementNote.textContent = requirements[id].note || "";
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
      showError("質問を入力してください。");
      question.focus();
      return;
    }
    submit.disabled = true;
    submit.firstChild.textContent = "確認中… ";
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
        showError(askErrorMessage(response.status, data), data.request_id);
      } else {
        await showResult(data);
      }
    } catch {
      showError("Ask Forge に接続できませんでした。時間をおいて再度お試しください。");
    } finally {
      submit.disabled = false;
      submit.firstChild.textContent = "Forge に確認する ";
      output.setAttribute("aria-busy", "false");
    }
  });

  updateCount();
}

const contactEmail = String(window.FORGE_PUBLIC_CONFIG?.contactEmail || "").trim();
const contactLink = document.querySelector("[data-contact-link]");
const contactPlaceholder = document.querySelector("[data-contact-placeholder]");
if (contactLink && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
  contactLink.href = `mailto:${encodeURIComponent(contactEmail)}?subject=${encodeURIComponent("Forge public showcase feedback")}`;
  contactLink.hidden = false;
  if (contactPlaceholder) contactPlaceholder.hidden = true;
}
